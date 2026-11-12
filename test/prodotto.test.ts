import assert from "node:assert/strict";
import fs from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { Bot, type BotOptions } from "../src/bot.js";
import { parseCommand } from "../src/commands.js";
import { costUsd, sumUsage } from "../src/costs.js";
import { isSmallChange, type Operation } from "../src/operations.js";
import { buildFilterMessage } from "../src/prefilter.js";
import { Store } from "../src/store.js";
import { WordPressClient } from "../src/wordpress.js";
import { scoreCase, shouldPassFilter, type EvalCase } from "../evals/punteggio.js";
import { FIXTURE_SITE_URL, fixtureFetch, fixturePages } from "../evals/sito-di-prova.js";
import {
  BOSS,
  FakeInterpreter,
  FakeMessenger,
  FakePrefilter,
  FakeSite,
  GROUP,
  PRICE_CHANGE,
  groupMsg,
  mediaMsg,
  usage,
} from "./helpers.js";

let store: Store;
let ai: FakeInterpreter;
let site: FakeSite;
let wa: FakeMessenger;
let bot: Bot;

function makeBot(overrides: Partial<BotOptions> = {}): Bot {
  bot = new Bot(store, ai, site, wa, {
    allowedGroups: [GROUP],
    allowedSenders: [],
    approvers: [BOSS],
    triggerPrefix: "",
    ...overrides,
  });
  return bot;
}

beforeEach(() => {
  store = new Store(":memory:");
  ai = new FakeInterpreter(PRICE_CHANGE);
  site = new FakeSite();
  wa = new FakeMessenger();
  makeBot();
});

describe("Filtro economico", () => {
  it("un messaggio giudicato non pertinente non arriva al modello principale", async () => {
    const prefilter = new FakePrefilter(false);
    makeBot({ prefilter });
    await bot.handle(groupMsg("Oggi pranzo alle 13?"));
    assert.equal(prefilter.calls.length, 1);
    assert.equal(ai.calls.length, 0);
    assert.equal(wa.sent.length, 0);
  });

  it("un messaggio pertinente prosegue normalmente", async () => {
    makeBot({ prefilter: new FakePrefilter(true) });
    await bot.handle(groupMsg("Parigi di maggio ora costa 590€"));
    assert.equal(ai.calls.length, 1);
    assert.match(wa.last, /Mi date l'ok e procedo\?/);
  });

  it("non filtra le risposte al bot, le correzioni e i messaggi con allegati", async () => {
    const prefilter = new FakePrefilter(false);
    makeBot({ prefilter: new FakePrefilter(true) });
    await bot.handle(groupMsg("Parigi di maggio ora costa 590€")); // crea la proposta 1

    makeBot({ prefilter });
    await bot.handle(groupMsg("no scusate 580")); // c'è una proposta in sospeso e l'ultimo a parlare è il bot
    assert.equal(prefilter.calls.length, 0);
    assert.equal(ai.calls.length, 2);

    wa.media.set("m1", { data: Buffer.from("x"), mimeType: "image/jpeg" });
    await bot.handle(groupMsg("annulla 1", BOSS));
    await bot.handle(groupMsg("annulla 2", BOSS));
    ai.next = { kind: "ignora", summary: "" };
    await bot.handle(groupMsg("grazie")); // subito dopo un messaggio del bot: va letto comunque
    assert.equal(prefilter.calls.length, 0);
    await bot.handle(groupMsg("ciao a tutti")); // messaggio sciolto tra colleghi: passa dal filtro
    assert.equal(prefilter.calls.length, 1);
    await bot.handle(mediaMsg({ id: "m1", kind: "image", mimeType: "image/jpeg" }, "guardate questa locandina"));
    assert.equal(prefilter.calls.length, 1, "i messaggi con allegati non vengono filtrati");
  });

  it("prepara un messaggio breve con gli ultimi scambi", () => {
    const text = buildFilterMessage({
      text: "sì quello di maggio",
      senderName: "Marco",
      history: [{ from: "bot", text: "Quale Parigi?", bot: true, timestamp: 1 }],
    });
    assert.match(text, /\[Assistente\]: Quale Parigi\?/);
    assert.match(text, /<messaggio_da_valutare>\n\[Marco\]: sì quello di maggio/);
  });
});

describe("Costi dell'AI", () => {
  it("calcola il costo dai token e dal listino", () => {
    assert.equal(
      costUsd({ model: "claude-opus-5-5", inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      6,
    );
    assert.equal(costUsd({ model: "modello-sconosciuto", inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }), undefined);
    const total = sumUsage("claude-haiku-5-5", "filtro", [
      { usage: { input_tokens: 500, output_tokens: 20, cache_read_input_tokens: null, cache_creation_input_tokens: null } },
      { usage: { input_tokens: 500, output_tokens: 20 } },
    ]);
    assert.equal(total.calls, 2);
    assert.equal(total.inputTokens, 1000);
    assert.equal(total.costUsd, 0.00012);
  });

  it("registra i consumi di ogni richiesta, collegati alla commessa", async () => {
    ai.usage = usage(0.09);
    await bot.handle(groupMsg("Parigi di maggio ora costa 590€"));
    ai.next = { kind: "ignora", summary: "" };
    await bot.handle(groupMsg("ciao"));
    const totals = store.usageSince(GROUP, "2000-01-01T00:00:00Z");
    assert.equal(totals.calls, 2);
    assert.equal(Math.round(totals.costUsd * 100), 18);
  });

  it("superato il tetto mensile smette di analizzare i messaggi", async () => {
    ai.usage = usage(0.6);
    makeBot({ monthlyBudgetUsd: 1 });
    await bot.handle(groupMsg("Parigi di maggio ora costa 590€")); // 0,60 $
    await bot.handle(groupMsg("Vienna a 349€")); // 1,20 $: tetto superato
    await bot.handle(groupMsg("Lisbona a 790€"));
    assert.equal(ai.calls.length, 2);
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.equal(store.get(1)?.status, "completata", "le approvazioni continuano a funzionare");
  });
});

describe("Riprovare una commessa", () => {
  it("'riprova' rifà l'analisi della richiesta originale", async () => {
    site.failOn = 0;
    await bot.handle(groupMsg("Parigi di maggio ora costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.equal(store.get(1)?.status, "errore");

    site.failOn = undefined;
    assert.deepEqual(parseCommand("riprova 1"), { type: "retry", id: 1 });
    await bot.handle(groupMsg("riprova 1"));
    assert.equal(ai.calls[1].text, "Parigi di maggio ora costa 590€");
    assert.equal(store.get(2)?.status, "in_attesa");
    assert.match(wa.last, /\(rif\. 2\)/);
  });

  it("non rifà una commessa che è andata a buon fine", async () => {
    await bot.handle(groupMsg("Parigi di maggio ora costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    await bot.handle(groupMsg("riprova 1"));
    assert.match(wa.last, /non ha bisogno di essere rifatta/);
    assert.equal(ai.calls.length, 1);
  });
});

describe("Azioni dalla dashboard", () => {
  beforeEach(async () => {
    await bot.handle(groupMsg("Parigi di maggio ora costa 590€"));
  });

  it("approva una commessa e scrive l'esito nel gruppo", async () => {
    const result = await bot.approveById(1, "utente:giulia");
    assert.equal(result.ok, true);
    assert.equal(store.get(1)?.status, "completata");
    assert.equal(store.get(1)?.approvedBy, "utente:giulia");
    assert.match(wa.last, /Fatto, è online \(rif\. 1\)/);

    assert.deepEqual(await bot.approveById(1, "utente:giulia"), { ok: false, message: "La commessa è già stata gestita." });
    assert.equal(site.applied.length, 1);
  });

  it("riporta l'errore se la modifica non riesce", async () => {
    site.failOn = 0;
    const result = await bot.approveById(1, "utente:giulia");
    assert.equal(result.ok, false);
    assert.match(result.message, /WordPress non raggiungibile/);
  });

  it("annulla e ripristina", async () => {
    assert.equal((await bot.cancelById(1)).ok, true);
    assert.equal(store.get(1)?.status, "annullata");
    assert.match(wa.last, /Ok, lascio perdere \(rif\. 1\)/);

    await bot.handle(groupMsg("Vienna a 349€"));
    await bot.approveById(2, "utente:giulia");
    site.conflict = true;
    const blocked = await bot.revertById(2);
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /Non l'ho toccata/);
    assert.equal((await bot.revertById(2, true)).ok, true);
    assert.equal(store.get(2)?.status, "ripristinata");
  });

  it("un bot non tocca le commesse di un altro cliente", async () => {
    const other = new Bot(store, ai, new FakeSite(), new FakeMessenger(), {
      allowedGroups: ["ALTRO-GRUPPO"],
      allowedSenders: [],
      approvers: [],
      triggerPrefix: "",
    });
    assert.deepEqual(await other.approveById(1, "x"), { ok: false, message: "Commessa 1 non trovata." });
    store.transition(1, "in_attesa", "in_corso", { approvedBy: BOSS });
    await other.recover();
    assert.equal(store.get(1)?.status, "in_corso", "la ripresa riguarda solo le proprie chat");
  });
});

describe("Modifiche piccole e grandi", () => {
  const update = (extra: object): Operation => ({ type: "update_post", post_type: "page", id: 1, ...extra });

  it("riconosce le modifiche approvabili a colpo d'occhio", () => {
    assert.equal(isSmallChange(PRICE_CHANGE.operations!), true);
    assert.equal(isSmallChange([{ type: "update_product_price", product_id: 3, regular_price: "590" }]), true);
    assert.equal(isSmallChange([update({ acf: [{ field: "prezzo", value: "590" }] })]), true);
  });

  it("considera grandi le riscritture, i cambi di stato e le modifiche a più pagine", () => {
    assert.equal(isSmallChange([update({ content: "<p>tutto nuovo</p>" })]), false);
    assert.equal(isSmallChange([update({ status: "draft" })]), false);
    assert.equal(isSmallChange([...PRICE_CHANGE.operations!, ...PRICE_CHANGE.operations!]), false);
    assert.equal(isSmallChange([{ type: "create_post", post_type: "post", title: "x", content: "y", status: "draft" }]), false);
  });
});

describe("Controllo dei collegamenti e sito di prova", () => {
  const client = (postTypes: string[], woocommerce = false) =>
    new WordPressClient({ url: FIXTURE_SITE_URL, user: "prova", appPassword: "p", postTypes, woocommerce, fetch: fixtureFetch() });

  it("conferma un sito configurato bene", async () => {
    const check = await client(["page", "post"]).checkConnection();
    assert.equal(check.ok, true);
    assert.deepEqual(check.user, { name: "Bot di prova", roles: ["editor"] });
    assert.deepEqual(check.availableTypes.map((t) => t.slug), ["page", "post"]);
    assert.equal(check.acfVisible, true);
    assert.equal(check.woocommerce, false);
  });

  it("spiega cosa non va", async () => {
    const check = await client(["page", "viaggio"], true).checkConnection();
    assert.equal(check.ok, false);
    assert.deepEqual(check.missingTypes, ["viaggio"]);
    assert.match(check.problems.join(" "), /Tipi di contenuto non trovati sul sito: viaggio/);
    assert.match(check.problems.join(" "), /WooCommerce è attivato/);

    const denied = new WordPressClient({
      url: FIXTURE_SITE_URL, user: "x", appPassword: "y", postTypes: ["page"], woocommerce: false,
      fetch: (async () => Response.json({ message: "no" }, { status: 401 })) as typeof fetch,
    });
    assert.match((await denied.checkConnection()).problems[0], /Accesso rifiutato/);
  });

  it("il sito di prova risponde come WordPress a ricerche e modifiche", async () => {
    const wp = client(["page", "post"]);
    assert.deepEqual((await wp.search("Parigi maggio")).map((r) => r.id), [101, 105]);
    assert.deepEqual((await wp.findOccurrences("650€")).map((o) => o.id), [101, 105]);
    const applied = await wp.apply({
      type: "update_post", post_type: "page", id: 101,
      content_replacements: [{ find: "<strong>650€</strong>", replace: "<strong>590€</strong>" }],
    });
    assert.equal(applied.outcome, "online");
    assert.match((await wp.getContent("page", 101)).content, /590€/);
    assert.equal(fixturePages().find((p) => p.id === 101)?.content.includes("650€"), true, "ogni prova parte da un sito pulito");
  });
});

describe("Raccolta di messaggi di prova", () => {
  const cases = JSON.parse(fs.readFileSync(new URL("../evals/casi.json", import.meta.url), "utf8")) as EvalCase[];

  it("i casi sono ben formati e fanno riferimento a pagine esistenti", () => {
    const ids = new Set(fixturePages().map((p) => p.id));
    assert.equal(new Set(cases.map((c) => c.id)).size, cases.length, "id duplicati");
    assert.ok(cases.length >= 20);
    for (const c of cases) {
      assert.ok(c.text && c.expect?.kind, c.id);
      for (const id of [...(c.expect.pages ?? []), ...(c.expect.bonusPages ?? [])]) assert.ok(ids.has(id), `${c.id}: pagina ${id}`);
    }
  });

  it("valuta una risposta rispetto alle attese", () => {
    const c: EvalCase = { id: "x", text: "", expect: { kind: "commessa", pages: [101], newValue: ["590"], scheduled: false, bonusPages: [105] } };
    const good = scoreCase(c, {
      kind: "commessa", summary: "",
      operations: [
        { type: "update_post", post_type: "page", id: 101, content_replacements: [{ find: "650€", replace: "590€" }] },
        { type: "update_post", post_type: "page", id: 105, content_replacements: [{ find: "650€", replace: "590€" }] },
      ],
    });
    assert.deepEqual(good, { pass: true, problems: [], bonusFound: 1, bonusTotal: 1 });

    const bad = scoreCase(c, {
      kind: "commessa", summary: "", scheduled_for: "2027-01-01T00:00:00Z",
      operations: [{ type: "update_post", post_type: "page", id: 102, content_replacements: [{ find: "690€", replace: "600€" }] }],
    });
    assert.deepEqual(bad.problems, ["non tocca il contenuto 101", "manca il nuovo valore (590)", "non doveva essere programmata"]);
    assert.deepEqual(scoreCase(c, { kind: "ignora", summary: "" }).problems, ['tipo "ignora" invece di "commessa"']);
  });

  it("sa quali messaggi il filtro deve lasciar passare", () => {
    assert.equal(shouldPassFilter({ id: "a", text: "", expect: { kind: "ignora" } }), false);
    assert.equal(shouldPassFilter({ id: "b", text: "", expect: { kind: "commessa" } }), true);
    assert.equal(shouldPassFilter({ id: "c", text: "", expect: { kind: ["chiarimento", "ignora"] } }), undefined);
  });
});
