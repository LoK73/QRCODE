import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { Bot } from "../src/bot.js";
import { Store } from "../src/store.js";
import { BOSS, FakeInterpreter, FakeMessenger, FakeSite, GROUP, PRICE_CHANGE, STAFF, groupMsg } from "./helpers.js";

describe("Bot", () => {
  let store: Store;
  let ai: FakeInterpreter;
  let site: FakeSite;
  let wa: FakeMessenger;
  let bot: Bot;

  function makeBot(overrides: Partial<ConstructorParameters<typeof Bot>[4]> = {}) {
    bot = new Bot(store, ai, site, wa, {
      allowedGroups: [GROUP],
      allowedSenders: [],
      approvers: [BOSS],
      triggerPrefix: "",
      ...overrides,
    });
  }

  beforeEach(() => {
    store = new Store(":memory:");
    ai = new FakeInterpreter(PRICE_CHANGE);
    site = new FakeSite();
    wa = new FakeMessenger();
    makeBot();
  });

  it("crea una commessa in attesa e la propone nel gruppo", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    assert.equal(ai.calls.length, 1);
    assert.match(wa.last, /Mi date l'ok e procedo\? \(rif\. 1\)/);
    assert.match(wa.last, /prezzo 650€ → 590€/);
    assert.doesNotMatch(wa.last, /[📋✅🤖*]/u, "niente emoji o grassetti da bot");
    assert.equal(store.get(1)?.status, "in_attesa");
    assert.equal(site.applied.length, 0, "nulla va applicato prima dell'approvazione");
  });

  it("applica la commessa quando un responsabile approva", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.equal(site.applied.length, 1);
    assert.equal(store.get(1)?.status, "completata");
    assert.equal(store.get(1)?.approvedBy, BOSS);
    assert.match(wa.last, /Fatto, è online \(rif\. 1\)/);
    assert.match(wa.last, /agenzia\.example\/parigi/);
  });

  it("accetta conferme naturali subito dopo la proposta", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("Sì vai pure 👍", BOSS));
    assert.equal(store.get(1)?.status, "completata");
    assert.equal(ai.calls.length, 1, "la conferma non passa dall'AI");
  });

  it("una conferma naturale non vale se nel frattempo il bot ha scritto altro", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    ai.next = { kind: "risposta", summary: "", reply: "Sì, l'ho vista prima" };
    await bot.handle(groupMsg("Hai visto la mail di Alpitour?"));
    ai.next = { kind: "ignora", summary: "" };
    await bot.handle(groupMsg("sì", BOSS));
    assert.equal(store.get(1)?.status, "in_attesa");
    assert.equal(site.applied.length, 0);
  });

  it("un 'sì' di chi non è responsabile è solo conversazione", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    ai.next = { kind: "ignora", summary: "" };
    await bot.handle(groupMsg("sì", STAFF));
    assert.equal(store.get(1)?.status, "in_attesa");
    assert.equal(wa.sent.length, 1, "nessuna risposta al 'sì'");
  });

  it("'lascia perdere' annulla la proposta appena fatta", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("no lascia perdere", STAFF));
    assert.equal(store.get(1)?.status, "annullata");
    assert.match(wa.last, /Ok, lascio perdere/);
  });

  it("'ok' senza numero chiede quale commessa se ce ne sono più di una", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("Anche Vienna a 349€"));
    await bot.handle(groupMsg("ok", BOSS));
    assert.match(wa.last, /Ne ho 2 in sospeso/);
    assert.equal(site.applied.length, 0);
  });

  it("non permette di approvare a chi non è responsabile", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("ok 1", STAFF));
    assert.match(wa.last, /aspetto l'ok di un responsabile/);
    assert.equal(store.get(1)?.status, "in_attesa");
    assert.equal(site.applied.length, 0);
  });

  it("non applica due volte la stessa commessa", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await Promise.all([bot.handle(groupMsg("ok 1", BOSS)), bot.handle(groupMsg("ok 1", BOSS))]);
    assert.equal(site.applied.length, 1);
  });

  it("ignora i messaggi ripetuti dal webhook", async () => {
    const msg = groupMsg("Parigi ora costa 590€");
    await bot.handle(msg);
    await bot.handle(msg);
    assert.equal(ai.calls.length, 1);
  });

  it("chi ha chiesto la commessa può annullarla", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("annulla 1", STAFF));
    assert.equal(store.get(1)?.status, "annullata");
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.equal(site.applied.length, 0);
  });

  it("in caso di errore ripristina le operazioni già fatte", async () => {
    ai.next = { ...PRICE_CHANGE, operations: [PRICE_CHANGE.operations![0], PRICE_CHANGE.operations![0]] };
    site.failOn = 1;
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.equal(store.get(1)?.status, "errore");
    assert.equal(site.undone.length, 1);
    assert.match(wa.last, /Non sono riuscito a fare la modifica sul sito: WordPress non raggiungibile/);
    assert.match(wa.last, /Ho rimesso com'era/);
  });

  it("ripristina una commessa completata", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    await bot.handle(groupMsg("ripristina 1", BOSS));
    assert.equal(store.get(1)?.status, "ripristinata");
    assert.equal(site.undone.length, 1);
  });

  it("fa una domanda quando l'AI chiede un chiarimento", async () => {
    ai.next = { kind: "chiarimento", summary: "", question: "Quale Parigi? Maggio o giugno?" };
    await bot.handle(groupMsg("Cambiate il prezzo di Parigi"));
    assert.match(wa.last, /Quale Parigi/);
    assert.equal(store.get(1), undefined);
  });

  it("passa la cronologia della chat all'AI per le risposte ai chiarimenti", async () => {
    ai.next = { kind: "chiarimento", summary: "", question: "Quale Parigi?" };
    await bot.handle(groupMsg("Cambiate il prezzo di Parigi"));
    ai.next = PRICE_CHANGE;
    await bot.handle(groupMsg("quello di maggio"));
    const history = ai.calls[1].history.map((m) => m.text);
    assert.deepEqual(history, ["Cambiate il prezzo di Parigi", "Quale Parigi?"]);
  });

  it("risponde con sincerità a chi chiede se è un bot", async () => {
    ai.next = { kind: "risposta", summary: "", reply: "Sì, sono un assistente automatico: preparo le modifiche al sito." };
    await bot.handle(groupMsg("ma sei un bot?"));
    assert.match(wa.last, /assistente automatico/);
  });

  it("resta in silenzio sui messaggi che non sono richieste", async () => {
    ai.next = { kind: "ignora", summary: "saluto" };
    await bot.handle(groupMsg("Buongiorno a tutti!"));
    assert.equal(wa.sent.length, 0);
  });

  it("ignora i gruppi non autorizzati", async () => {
    await bot.handle({ ...groupMsg("Parigi a 590€"), chatId: "ALTRO" });
    assert.equal(ai.calls.length, 0);
    assert.equal(wa.sent.length, 0);
  });

  it("con TRIGGER_PREFIX interpreta solo i messaggi che lo usano", async () => {
    makeBot({ triggerPrefix: "#sito" });
    await bot.handle(groupMsg("Parigi a 590€"));
    assert.equal(ai.calls.length, 0);
    await bot.handle(groupMsg("#sito Parigi a 590€"));
    assert.equal(ai.calls[0].text, "Parigi a 590€");
  });

  it("segnala gli errori dell'AI senza creare commesse", async () => {
    ai.next = new Error("rate limit");
    await bot.handle(groupMsg("Parigi a 590€"));
    assert.match(wa.last, /non riesco a guardarci/);
    assert.equal(store.get(1), undefined);
  });

  it("elenca le commesse", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("commesse"));
    assert.match(wa.last, /rif\. 1: Cambio il prezzo .* \(aspetto l'ok\)/);
  });
});
