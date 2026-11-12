import assert from "node:assert/strict";
import fs from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { drainActions } from "../src/actions.js";
import { MessageQueue } from "../src/queue.js";
import { decryptSecret, encryptSecret } from "../src/secrets.js";
import { PgStore, type Db } from "../src/store-pg.js";
import { TenantRegistry } from "../src/tenants.js";
import type { IncomingMessage } from "../src/whatsapp.js";
import { FIXTURE_SITE_URL, fixtureFetch, fixturePages, type FixturePage } from "../evals/sito-di-prova.js";
import { FakeInterpreter, FakeMessenger, usage } from "./helpers.js";

const KEY = Buffer.alloc(32, 7).toString("base64");
const SQL = ["../supabase/tests/finto-supabase.sql", "../supabase/migrations/20261112000000_init.sql"].map((f) =>
  fs.readFileSync(new URL(f, import.meta.url), "utf8"),
);

const GROUP_A = "GRUPPO-AURORA";
const GROUP_B = "GRUPPO-PIERO";
const BOSS_A = "393330000001";
const BOSS_B = "393330000009";
const STAFF = "393330000002";

const PRICE = {
  kind: "commessa" as const,
  summary: "Cambio il prezzo del tour di Parigi di maggio",
  details: ["prezzo 650€ → 590€"],
  operations: [
    {
      type: "update_post" as const,
      post_type: "page",
      id: 101,
      content_replacements: [{ find: "<strong>650€</strong>", replace: "<strong>590€</strong>" }],
      acf: [{ field: "prezzo", value: "590" }],
    },
  ],
};

let pg: PGlite;
let store: PgStore;
let wa: FakeMessenger;
let ai: FakeInterpreter;
let registry: TenantRegistry;
let pagesA: FixturePage[];
let ids: { clientA: string; clientB: string; admin: string; operatorA: string; managerA: string; readerA: string; managerB: string };
let counter = 0;

const one = async (sql: string, params: unknown[] = []) => (await pg.query<Record<string, unknown>>(sql, params)).rows[0];
const all = async (sql: string, params: unknown[] = []) => (await pg.query<Record<string, unknown>>(sql, params)).rows;

function msg(chatId: string, text: string, from = STAFF, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return { id: `wamid.pg.${++counter}`, chatId, chatType: "group", from, fromName: "Marco", text, timestamp: Math.floor(Date.now() / 1000), ...extra };
}

async function route(m: IncomingMessage): Promise<void> {
  const entry = await registry.forChat(m.chatId);
  await entry?.bot?.handle(m);
}

/** Esegue una funzione come farebbe un utente della dashboard: ruolo "authenticated" e identità nel token. */
async function asUser<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  await pg.query("select set_config('request.jwt.claims', $1, false)", [JSON.stringify({ sub: userId })]);
  await pg.exec("set role authenticated");
  try {
    return await fn();
  } finally {
    await pg.exec("reset role");
    await pg.query("select set_config('request.jwt.claims', '', false)");
  }
}

beforeEach(async () => {
  pg = new PGlite();
  for (const sql of SQL) await pg.exec(sql);
  store = new PgStore(pg as unknown as Db);

  const user = async (email: string, name: string) =>
    String((await one("insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id", [email, JSON.stringify({ full_name: name })])).id);
  const client = async (name: string, sector: string) => String((await one("insert into clients (name, sector) values ($1, $2) returning id", [name, sector])).id);

  ids = {
    clientA: await client("Viaggi Aurora", "agenzia di viaggi"),
    clientB: await client("Ristorante Da Piero", "ristorazione"),
    admin: await user("giulia@agenzia.example", "Giulia Rossi"),
    operatorA: await user("luca@agenzia.example", "Luca Operatore"),
    managerA: await user("francesca@aurora.example", "Francesca Conti"),
    readerA: await user("anna@aurora.example", "Anna Lettrice"),
    managerB: await user("piero@dapiero.example", "Piero"),
  };
  for (const [clientId, group, boss] of [[ids.clientA, GROUP_A, BOSS_A], [ids.clientB, GROUP_B, BOSS_B]] as const) {
    await pg.query("insert into client_sites (client_id, url, wp_user, post_types) values ($1, $2, 'bot', '{page,post}')", [clientId, FIXTURE_SITE_URL]);
    await pg.query("insert into client_secrets (client_id, wp_app_password_enc) values ($1, $2)", [clientId, encryptSecret("abcd efgh", KEY)]);
    await pg.query("insert into client_channels (client_id, chat_id, name) values ($1, $2, 'Sito')", [clientId, group]);
    await pg.query("insert into contacts (client_id, wa_id, name, can_approve) values ($1, $2, 'Responsabile', true)", [clientId, boss]);
  }
  await pg.query("insert into memberships (user_id, client_id, role) values ($1, null, 'admin_agenzia')", [ids.admin]);
  await pg.query("insert into memberships (user_id, client_id, role) values ($1, $2, 'operatore_agenzia')", [ids.operatorA, ids.clientA]);
  await pg.query("insert into memberships (user_id, client_id, role) values ($1, $2, 'responsabile_cliente')", [ids.managerA, ids.clientA]);
  await pg.query("insert into memberships (user_id, client_id, role) values ($1, $2, 'lettore_cliente')", [ids.readerA, ids.clientA]);
  await pg.query("insert into memberships (user_id, client_id, role) values ($1, $2, 'responsabile_cliente')", [ids.managerB, ids.clientB]);

  wa = new FakeMessenger();
  ai = new FakeInterpreter(PRICE);
  ai.usage = usage(0.09);
  pagesA = fixturePages();
  const sites = new Map([[ids.clientA, fixtureFetch(pagesA)], [ids.clientB, fixtureFetch()]]);
  registry = new TenantRegistry({
    store,
    messenger: wa,
    credentialsKey: KEY,
    model: "claude-opus-5-5",
    effort: "medium",
    siteFetch: (tenant) => sites.get(tenant.id), // ogni cliente ha il suo sito finto
    makeInterpreter: () => ai,
    refreshMs: 0,
  });
});

describe("Piattaforma: bot su Postgres con più clienti", () => {
  it("credenziali cifrate: si leggono solo con la chiave giusta", () => {
    const enc = encryptSecret("abcd efgh ijkl", KEY);
    assert.notEqual(enc, encryptSecret("abcd efgh ijkl", KEY), "ogni cifratura è diversa");
    assert.equal(decryptSecret(enc, KEY), "abcd efgh ijkl");
    assert.throws(() => decryptSecret(enc, Buffer.alloc(32, 8).toString("base64")));
    assert.throws(() => encryptSecret("x", "chiave-corta"), /32 byte/);
  });

  it("dalla richiesta nel gruppo alla pagina aggiornata, tutto registrato per il cliente giusto", async () => {
    await route(msg(GROUP_A, "Il tour di Parigi di maggio ora costa 590"));
    const proposed = await one("select * from commesse");
    assert.equal(proposed.client_id, ids.clientA);
    assert.equal(proposed.status, "in_attesa");
    assert.equal(proposed.small, true);
    assert.deepEqual(proposed.preview, [
      {
        kind: "modifica",
        title: "Tour di Parigi – Maggio",
        url: `${FIXTURE_SITE_URL}/tour-parigi-maggio`,
        changes: [
          { field: "Testo", before: "Partenza: 15 maggio. Quota a persona: 650€", after: "Partenza: 15 maggio. Quota a persona: 590€" },
          { field: "Campo «prezzo»", before: "650", after: "590" },
        ],
      },
    ]);
    assert.match(wa.last, /Mi date l'ok e procedo\? \(rif\. 1\)/);

    await route(msg(GROUP_A, "ok", BOSS_A));
    const done = (await store.get(1))!;
    assert.equal(done.status, "completata");
    assert.equal(done.undo.length, 1);
    assert.match(pagesA.find((p) => p.id === 101)!.content, /590€/);
    assert.match(wa.last, /Fatto, è online \(rif\. 1\)/);

    const spent = await one("select client_id, commessa_id, cost_usd from consumi_ai");
    assert.equal(spent.client_id, ids.clientA);
    assert.equal(Number(spent.commessa_id), 1);
    assert.equal((await all("select 1 from messaggi where client_id = $1", [ids.clientA])).length, 4);
  });

  it("un cliente non può toccare le commesse di un altro, nemmeno conoscendo il numero", async () => {
    await route(msg(GROUP_A, "Il tour di Parigi di maggio ora costa 590"));
    await route(msg(GROUP_B, "ok 1", BOSS_B));
    assert.match(wa.last, /Non trovo niente con rif\. 1/);
    assert.equal((await store.get(1))?.status, "in_attesa");
    await route(msg(GROUP_B, "stato 1", BOSS_B));
    assert.match(wa.last, /Non trovo niente/);
  });

  it("solo i responsabili indicati possono dare l'ok dal gruppo", async () => {
    await route(msg(GROUP_A, "Il tour di Parigi di maggio ora costa 590"));
    await route(msg(GROUP_A, "ok 1", STAFF));
    assert.match(wa.last, /aspetto l'ok di un responsabile/);
    await route(msg(GROUP_A, "ok 1", BOSS_B));
    assert.equal((await store.get(1))?.status, "in_attesa");
  });

  it("con approvazione 'agenzia' l'ok da WhatsApp non basta: serve la dashboard", async () => {
    await pg.query("update clients set approval_rule = 'agenzia' where id = $1", [ids.clientA]);
    await route(msg(GROUP_A, "Il tour di Parigi di maggio ora costa 590"));
    await route(msg(GROUP_A, "ok 1", BOSS_A));
    assert.match(wa.last, /serve l'ok dell'agenzia/);
    assert.equal((await store.get(1))?.status, "in_attesa");
  });

  it("la coda dei messaggi funziona anche su Postgres", async () => {
    const queue = new MessageQueue(store, route, { retryDelayMs: 0 });
    const m = msg(GROUP_A, "Il tour di Parigi di maggio ora costa 590");
    assert.equal(await queue.enqueue(m), true);
    assert.equal(await queue.enqueue(m), false);
    await queue.idle();
    assert.equal(await store.jobStatus(m.id), "done");
    assert.equal(ai.calls.length, 1);

    const lost = msg(GROUP_A, "Vienna a 329");
    await store.enqueue(lost);
    await store.claimJob(lost.id);
    assert.equal(await new MessageQueue(store, route, { retryDelayMs: 0 }).resume(), 1);
  });

  it("modifiche programmate e tetto di spesa per cliente", async () => {
    ai.next = { ...PRICE, scheduled_for: new Date(Date.now() + 3_600_000).toISOString() };
    await route(msg(GROUP_A, "Tra un'ora Parigi a 590"));
    await route(msg(GROUP_A, "ok 1", BOSS_A));
    assert.equal((await store.get(1))?.status, "programmata");
    assert.deepEqual(await store.dueToApply(new Date().toISOString()), []);
    assert.equal((await store.dueToApply(new Date(Date.now() + 7_200_000).toISOString())).length, 1);

    await pg.query("update clients set monthly_budget_usd = 0.05 where id = $1", [ids.clientA]);
    await registry.refresh();
    await route(msg(GROUP_A, "Vienna a 329"));
    assert.equal(ai.calls.length, 1, "tetto superato: il messaggio non viene analizzato");
    await route(msg(GROUP_B, "Menù a 55"));
    assert.equal(ai.calls.length, 2, "il tetto di un cliente non blocca gli altri");
  });
});

describe("Piattaforma: azioni dalla dashboard", () => {
  beforeEach(async () => {
    await route(msg(GROUP_A, "Il tour di Parigi di maggio ora costa 590"));
  });

  const request = (userId: string, tipo: string, commessaId: number | null, clientId = ids.clientA) =>
    asUser(userId, () => pg.query("insert into azioni (client_id, commessa_id, tipo) values ($1, $2, $3)", [clientId, commessaId, tipo]));

  it("il responsabile del cliente approva dalla dashboard e il gruppo viene avvisato", async () => {
    await request(ids.managerA, "approva", 1);
    assert.equal(await drainActions(registry, store), 1);
    const c = (await store.get(1))!;
    assert.equal(c.status, "completata");
    assert.equal(c.approvedBy, "Francesca Conti (dashboard)");
    assert.match(wa.last, /Fatto, è online \(rif\. 1\)/);
    const action = await one("select stato, esito from azioni");
    assert.equal(action.stato, "fatta");
  });

  it("ripristino con conflitto, poi forzato; riprova di una commessa fallita", async () => {
    await request(ids.admin, "approva", 1);
    await drainActions(registry, store);
    const page = pagesA.find((p) => p.id === 101)!;
    page.content = page.content.replace("590€", "570€");
    page.acf.prezzo = "570";

    await request(ids.admin, "ripristina", 1);
    await drainActions(registry, store);
    const blocked = await one("select stato, esito from azioni order by id desc limit 1");
    assert.equal(blocked.stato, "fallita");
    assert.match(String(blocked.esito), /Non l'ho toccata/);

    await request(ids.admin, "ripristina_forza", 1);
    await drainActions(registry, store);
    assert.equal((await store.get(1))?.status, "ripristinata");
    assert.match(page.content, /650€/);
  });

  it("'Prova connessione' salva l'esito per la dashboard", async () => {
    await request(ids.operatorA, "prova_sito", null);
    await drainActions(registry, store);
    const site = await one("select last_check, last_check_at from client_sites where client_id = $1", [ids.clientA]);
    const check = site.last_check as { ok: boolean; user: { name: string } };
    assert.equal(check.ok, true);
    assert.equal(check.user.name, "Bot di prova");
    assert.ok(site.last_check_at);
  });

  it("un'azione rimasta a metà per un riavvio viene rieseguita", async () => {
    await request(ids.admin, "approva", 1);
    await store.claimAction(); // presa in carico, poi il server si ferma
    assert.equal(await store.resetInterruptedActions(), 1);
    await drainActions(registry, store);
    assert.equal((await store.get(1))?.status, "completata");
  });

  describe("permessi (regole RLS)", () => {
    it("chi può chiedere cosa", async () => {
      await assert.rejects(request(ids.readerA, "approva", 1), /row-level security/, "un lettore non approva");
      await assert.rejects(request(ids.managerB, "approva", 1, ids.clientB), /row-level security/, "commessa di un altro cliente");
      await assert.rejects(request(ids.managerB, "approva", 1), /row-level security/, "cliente altrui");
      await assert.rejects(request(ids.managerA, "prova_sito", null), /row-level security/, "la prova del sito è dell'agenzia");
      await request(ids.operatorA, "approva", 1);
      await request(ids.managerA, "annulla", 1);

      await pg.query("update clients set approval_rule = 'agenzia' where id = $1", [ids.clientA]);
      await assert.rejects(request(ids.managerA, "approva", 1), /row-level security/, "con regola 'agenzia' il cliente non approva");
      await request(ids.admin, "approva", 1);
    });

    it("ognuno vede solo i propri clienti", async () => {
      await route(msg(GROUP_B, "Menù degustazione a 55"));
      const names = (userId: string) => asUser(userId, async () => (await all("select name from clients order by name")).map((r) => r.name));
      assert.deepEqual(await names(ids.admin), ["Ristorante Da Piero", "Viaggi Aurora"]);
      assert.deepEqual(await names(ids.managerA), ["Viaggi Aurora"]);
      assert.deepEqual(await names(ids.operatorA), ["Viaggi Aurora"]);
      assert.deepEqual(await names(ids.managerB), ["Ristorante Da Piero"]);

      const commesse = (userId: string) => asUser(userId, async () => (await all("select id from commesse order by id")).map((r) => Number(r.id)));
      assert.deepEqual(await commesse(ids.admin), [1, 2]);
      assert.deepEqual(await commesse(ids.readerA), [1]);
      assert.deepEqual(await commesse(ids.managerB), [2]);
      assert.equal((await asUser(ids.managerB, () => all("select 1 from messaggi where client_id = $1", [ids.clientA]))).length, 0);
    });

    it("nessun utente legge le password o scrive le commesse", async () => {
      for (const who of [ids.admin, ids.managerA]) {
        await assert.rejects(asUser(who, () => all("select * from client_secrets")), /permission denied/);
        await assert.rejects(asUser(who, () => all("select * from inbox")), /permission denied/);
        await assert.rejects(asUser(who, () => pg.query("update commesse set status = 'completata' where id = 1")), /permission denied/);
        await assert.rejects(asUser(who, () => pg.query("update azioni set stato = 'fatta'")), /permission denied/);
      }
      const sites = (userId: string) => asUser(userId, async () => (await all("select url from client_sites")).length);
      assert.equal(await sites(ids.admin), 2);
      assert.equal(await sites(ids.operatorA), 1);
      assert.equal(await sites(ids.managerA), 0, "il cliente non vede la configurazione tecnica");
    });

    it("i costi li vede l'agenzia; il cliente solo se l'agenzia lo consente", async () => {
      const costs = (userId: string) => asUser(userId, async () => (await all("select 1 from consumi_ai")).length);
      assert.equal(await costs(ids.admin), 1);
      assert.equal(await costs(ids.managerA), 0);
      await pg.query("update clients set show_costs_to_client = true where id = $1", [ids.clientA]);
      assert.equal(await costs(ids.managerA), 1);
      assert.equal(await costs(ids.managerB), 0);
    });

    it("solo l'agenzia gestisce clienti, chat e utenti", async () => {
      await assert.rejects(asUser(ids.managerA, () => pg.query("insert into clients (name) values ('Intruso')")), /row-level security/);
      await assert.rejects(
        asUser(ids.managerA, () => pg.query("insert into memberships (user_id, client_id, role) values ($1, $2, 'responsabile_cliente')", [ids.managerA, ids.clientB])),
        /row-level security/,
      );
      const hijack = await asUser(ids.managerA, () => pg.query("update client_channels set client_id = $1 where chat_id = $2 returning id", [ids.clientA, GROUP_B]));
      assert.equal(hijack.rows.length, 0);
      await asUser(ids.operatorA, () => pg.query("update clients set trigger_prefix = '#sito' where id = $1", [ids.clientA]));
      assert.equal((await one("select trigger_prefix from clients where id = $1", [ids.clientA])).trigger_prefix, "#sito");
      const other = await asUser(ids.operatorA, () => pg.query("update clients set trigger_prefix = '#x' where id = $1 returning id", [ids.clientB]));
      assert.equal(other.rows.length, 0, "un operatore assegnato a un cliente non tocca gli altri");
    });
  });
});
