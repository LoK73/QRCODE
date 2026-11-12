/**
 * Ambiente di prova locale per la dashboard, senza WhatsApp, WordPress né Claude veri.
 *
 *   DATABASE_URL=postgres://... CREDENTIALS_KEY=... npm run demo
 *
 * Riempie un database Postgres locale con tre clienti e alcune commesse nei vari
 * stati, passando dal bot vero (stessa logica di produzione) ma con:
 *   - un finto sito WordPress in memoria per ogni cliente,
 *   - un "interprete" a copione al posto di Claude,
 *   - i messaggi WhatsApp stampati a video invece che inviati.
 * Poi resta in esecuzione ed esegue le azioni chieste dalla dashboard.
 *
 * Serve un Postgres con supabase/tests/finto-supabase.sql e le migrazioni applicate.
 * Non usarlo su un database vero: crea utenti e dati inventati.
 */
import pg from "pg";
import { drainActions } from "../src/actions.js";
import type { Interpreter, InterpretInput } from "../src/ai.js";
import type { Messenger } from "../src/bot.js";
import type { Interpretation } from "../src/operations.js";
import { encryptSecret } from "../src/secrets.js";
import { PgStore, type Db } from "../src/store-pg.js";
import { TenantRegistry } from "../src/tenants.js";
import type { IncomingMessage } from "../src/whatsapp.js";
import { FIXTURE_SITE_URL, fixtureFetch } from "../evals/sito-di-prova.js";

const databaseUrl = process.env.DATABASE_URL;
const credentialsKey = process.env.CREDENTIALS_KEY;
if (!databaseUrl || !credentialsKey) throw new Error("Servono DATABASE_URL e CREDENTIALS_KEY");
if (/supabase\.(co|com)/.test(databaseUrl)) throw new Error("Questo script è solo per un database locale di prova");

const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PgStore(pool as unknown as Db);
const q = async (sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows;

// ------------------------------------------------------------------ finti servizi

const messenger: Messenger = {
  async sendText(chatId, _type, text) {
    console.log(`\n[WhatsApp → ${chatId}]\n${text}`);
    return `demo.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  },
};

/** Al posto di Claude: riconosce le frasi del copione qui sotto. */
const SCRIPT: Array<[RegExp, Interpretation]> = [
  [/parigi.*590/i, {
    kind: "commessa", summary: "Cambio il prezzo del tour di Parigi di maggio", details: ["prezzo 650€ → 590€"],
    operations: [{ type: "update_post", post_type: "page", id: 101, content_replacements: [{ find: "<strong>650€</strong>", replace: "<strong>590€</strong>" }], acf: [{ field: "prezzo", value: "590" }] }],
  }],
  [/crociera.*sold out/i, {
    kind: "commessa", summary: "Metto in bozza la crociera in Grecia, è sold out", details: ["pubblicata → bozza", "la tolgo anche dalle offerte del mese"],
    operations: [
      { type: "update_post", post_type: "page", id: 103, status: "draft" },
      { type: "update_post", post_type: "page", id: 105, content_replacements: [{ find: "<li>Crociera nelle isole greche, da 1.290€</li>", replace: "" }] },
    ],
  }],
  [/vienna.*329/i, {
    kind: "commessa", summary: "Cambio il prezzo del weekend a Vienna", details: ["prezzo 349€ → 329€"],
    operations: [{ type: "update_post", post_type: "page", id: 104, content_replacements: [{ find: "<strong>349€</strong>", replace: "<strong>329€</strong>" }], acf: [{ field: "prezzo", value: "329" }] }],
  }],
  [/praga/i, {
    kind: "commessa", summary: "Creo la pagina del weekend a Praga, in bozza", details: ["nuova pagina: Weekend a Praga, 3 notti da 299€"],
    operations: [{ type: "create_post", post_type: "page", title: "Weekend a Praga", content: "<p>Tre notti a Praga con volo da Bergamo.</p>\n\n<p>Quota a persona: <strong>299€</strong></p>", status: "draft" }],
  }],
  [/telefono/i, {
    kind: "commessa", summary: "Cambio il numero di telefono nella pagina Contatti", details: ["02 9999999 → 02 7654321"],
    // Il numero indicato non c'è nella pagina: alla pubblicazione questa commessa fallisce.
    operations: [{ type: "update_post", post_type: "page", id: 106, content_replacements: [{ find: "Telefono: 02 9999999", replace: "Telefono: 02 7654321" }] }],
  }],
  [/lisbona.*790/i, {
    kind: "commessa", summary: "Cambio il prezzo del capodanno a Lisbona", details: ["prezzo 890€ → 790€"],
    scheduled_for: new Date(Date.now() + 5 * 86_400_000).toISOString(),
    operations: [{ type: "update_post", post_type: "post", id: 107, content_replacements: [{ find: "<strong>890€</strong>", replace: "<strong>790€</strong>" }] }],
  }],
  [/sabato.*17/i, {
    kind: "commessa", summary: "Cambio l'orario del sabato nella pagina Contatti", details: ["sabato 9:00–13:00 → 9:00–17:00"],
    operations: [{ type: "update_post", post_type: "page", id: 106, content_replacements: [{ find: "sabato 9:00–13:00", replace: "sabato 9:00–17:00" }] }],
  }],
];

const interpreter: Interpreter = {
  async interpret(input: InterpretInput): Promise<Interpretation> {
    input.onUsage?.({
      model: "claude-opus-5-5", purpose: "interpretazione", calls: 3,
      inputTokens: 9000 + Math.round(Math.random() * 6000), outputTokens: 900, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.05 + Math.round(Math.random() * 8) / 100,
    });
    return SCRIPT.find(([re]) => re.test(input.text))?.[1] ?? { kind: "ignora", summary: "fuori copione" };
  },
};

const sites = new Map<string, typeof fetch>();
const registry = new TenantRegistry({
  store,
  messenger,
  credentialsKey,
  model: "claude-opus-5-5",
  effort: "medium",
  siteFetch: (tenant) => {
    if (!sites.has(tenant.id)) sites.set(tenant.id, fixtureFetch());
    return sites.get(tenant.id);
  },
  makeInterpreter: () => interpreter,
  refreshMs: 5_000,
});

// ------------------------------------------------------------------ dati di prova

let n = 0;
const say = async (chatId: string, from: string, fromName: string, text: string, extra: Partial<IncomingMessage> = {}) => {
  const msg: IncomingMessage = { id: `demo.in.${Date.now()}.${++n}`, chatId, chatType: "group", from, fromName, text, timestamp: Math.floor(Date.now() / 1000), ...extra };
  console.log(`\n[${fromName} in ${chatId}] ${text}`);
  const entry = await registry.forChat(chatId);
  if (entry?.bot) await entry.bot.handle(msg);
  else await store.noteUnknownChat(msg);
};

async function seed(): Promise<void> {
  const user = async (email: string, name: string) =>
    String((await q("insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb) returning id", [email, JSON.stringify({ full_name: name })]))[0].id);
  const client = async (name: string, sector: string, extra = "") =>
    String((await q(`insert into clients (name, sector, profile, monthly_budget_usd ${extra ? ", approval_rule" : ""}) values ($1, $2, $3, $4 ${extra ? ", $5" : ""}) returning id`,
      [name, sector, "Il prezzo dei viaggi è anche nel campo personalizzato «prezzo».", 50, ...(extra ? [extra] : [])]))[0].id);

  const aurora = await client("Viaggi Aurora", "agenzia di viaggi");
  const piero = await client("Ristorante Da Piero", "ristorazione", "agenzia");
  const lume = await client("Ottica Lume", "negozio");

  for (const [id, group, boss, bossName] of [[aurora, "GRUPPO-AURORA", "393330000001", "Francesca"], [piero, "GRUPPO-PIERO", "393330000009", "Piero"]] as const) {
    await q("insert into client_sites (client_id, url, wp_user, post_types) values ($1, $2, 'bot-commesse', '{page,post}')", [id, FIXTURE_SITE_URL]);
    await q("insert into client_secrets (client_id, wp_app_password_enc) values ($1, $2)", [id, encryptSecret("password di prova", credentialsKey!)]);
    await q("insert into client_channels (client_id, chat_id, name) values ($1, $2, $3)", [id, group, id === aurora ? "Sito Viaggi Aurora" : "Sito Da Piero"]);
    await q("insert into contacts (client_id, wa_id, name, can_approve) values ($1, $2, $3, true)", [id, boss, bossName]);
  }
  await q("insert into contacts (client_id, wa_id, name, can_approve) values ($1, '393330000002', 'Marco', false)", [aurora]);

  const giulia = await user("giulia@agenzia.example", "Giulia Rossi");
  const luca = await user("luca@agenzia.example", "Luca Bianchi");
  const francesca = await user("francesca@viaggiaurora.example", "Francesca Conti");
  const anna = await user("anna@viaggiaurora.example", "Anna Verdi");
  await q("insert into memberships (user_id, client_id, role) values ($1, null, 'admin_agenzia'), ($2, $5, 'operatore_agenzia'), ($3, $5, 'responsabile_cliente'), ($4, $5, 'lettore_cliente')",
    [giulia, luca, francesca, anna, aurora]);
  void lume;

  await registry.refresh();
  await say("GRUPPO-AURORA", "393330000002", "Marco", "Weekend a Vienna ora a 329");
  await say("GRUPPO-AURORA", "393330000001", "Francesca", "ok");
  await say("GRUPPO-AURORA", "393330000002", "Marco", "Nuova offerta: weekend a Praga, 3 notti da 299€");
  await say("GRUPPO-AURORA", "393330000001", "Francesca", "sì vai");
  await say("GRUPPO-AURORA", "393330000002", "Marco", "Cambiate il telefono in 02 7654321");
  await say("GRUPPO-AURORA", "393330000001", "Francesca", "ok");
  await say("GRUPPO-AURORA", "393330000002", "Marco", "Dal 17 Lisbona a 790");
  await say("GRUPPO-AURORA", "393330000001", "Francesca", "ok");
  await say("GRUPPO-AURORA", "393330000002", "Marco", "Togliete la crociera in Grecia, è sold out");
  await say("GRUPPO-AURORA", "393330000002", "Marco", "Il tour di Parigi di maggio ora costa 590 invece di 650");
  await say("GRUPPO-PIERO", "393330000009", "Piero", "Il sabato adesso siamo aperti fino alle 17");
  await say("GRUPPO-PALESTRA", "393330000020", "Luca (Kinesis)", "Ciao, siamo la palestra: potete aggiungere il corso di pilates?");
  console.log("\nDati di prova creati.");
}

const [{ count }] = await q("select count(*)::int as count from clients");
if (count === 0) await seed();
else {
  await registry.refresh();
  console.log(`Database già popolato (${count} clienti): salto la creazione dei dati di prova.`);
}

console.log("\nBot di prova in esecuzione: eseguo le azioni chieste dalla dashboard. Ctrl+C per uscire.");
for (;;) {
  try {
    const done = await drainActions(registry, store);
    if (done) console.log(`\n[azioni] eseguite: ${done}`);
    for (const entry of await registry.all()) await entry.bot?.runDue();
  } catch (err) {
    console.error("[demo] errore:", err);
  }
  await new Promise((r) => setTimeout(r, 1500));
}
