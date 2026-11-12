import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { buildUserContent, buildUserMessage, checkInterpretation } from "../src/ai.js";
import { Bot, formatWhen, type BotOptions } from "../src/bot.js";
import { MessageQueue } from "../src/queue.js";
import { Store } from "../src/store.js";
import { HttpTranscriber } from "../src/transcribe.js";
import { parseWebhook, WhatsAppClient } from "../src/whatsapp.js";
import {
  BOSS,
  FakeInterpreter,
  FakeMessenger,
  FakeSite,
  FakeTranscriber,
  GROUP,
  PRICE_CHANGE,
  STAFF,
  groupMsg,
  mediaMsg,
} from "./helpers.js";

const HOUR = 3_600_000;

let store: Store;
let ai: FakeInterpreter;
let site: FakeSite;
let wa: FakeMessenger;
let bot: Bot;
/** Orologio regolabile: millisecondi da aggiungere all'ora reale. */
let clockOffset = 0;

function makeBot(overrides: Partial<BotOptions> = {}): Bot {
  bot = new Bot(store, ai, site, wa, {
    allowedGroups: [GROUP],
    allowedSenders: [],
    approvers: [BOSS],
    triggerPrefix: "",
    now: () => new Date(Date.now() + clockOffset),
    ...overrides,
  });
  return bot;
}

beforeEach(() => {
  store = new Store(":memory:");
  ai = new FakeInterpreter(PRICE_CHANGE);
  site = new FakeSite();
  wa = new FakeMessenger();
  clockOffset = 0;
  makeBot();
});

describe("Coda dei messaggi", () => {
  it("elabora una volta sola un messaggio ripetuto dal webhook", async () => {
    const queue = new MessageQueue(store, (m) => bot.handle(m), { retryDelayMs: 0 });
    const msg = groupMsg("Parigi ora costa 590€");
    assert.equal(await queue.enqueue(msg), true);
    assert.equal(await queue.enqueue(msg), false);
    await queue.idle();
    assert.equal(ai.calls.length, 1);
    assert.equal(store.jobStatus(msg.id), "done");
  });

  it("elabora i messaggi della stessa chat uno alla volta e in ordine", async () => {
    const log: string[] = [];
    let running = 0;
    let maxTogether = 0;
    const queue = new MessageQueue(store, async (m) => {
      running++;
      maxTogether = Math.max(maxTogether, running);
      log.push(`inizio ${m.text}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`fine ${m.text}`);
      running--;
    });
    for (const t of ["a", "b", "c"]) await queue.enqueue(groupMsg(t));
    await queue.idle();
    assert.equal(maxTogether, 1);
    assert.deepEqual(log, ["inizio a", "fine a", "inizio b", "fine b", "inizio c", "fine c"]);
  });

  it("riprova se l'elaborazione fallisce e alla fine rinuncia", async () => {
    let failures = 2;
    const ok = new MessageQueue(
      store,
      async () => {
        if (failures-- > 0) throw new Error("temporaneo");
      },
      { retryDelayMs: 0 },
    );
    const first = groupMsg("uno");
    await ok.enqueue(first);
    await ok.idle();
    assert.equal(store.jobStatus(first.id), "done");

    const broken = new MessageQueue(
      store,
      async () => {
        throw new Error("sempre rotto");
      },
      { retryDelayMs: 0, maxAttempts: 2 },
    );
    const second = groupMsg("due");
    await broken.enqueue(second);
    await broken.idle();
    assert.equal(store.jobStatus(second.id), "failed");
  });

  it("dopo un riavvio riprende i messaggi rimasti a metà", async () => {
    const msg = groupMsg("Parigi ora costa 590€");
    store.enqueue(msg);
    store.claimJob(msg.id); // il server si è fermato mentre lo elaborava
    assert.equal(store.jobStatus(msg.id), "processing");

    const queue = new MessageQueue(store, (m) => bot.handle(m), { retryDelayMs: 0 });
    assert.equal(await queue.resume(), 1);
    await queue.idle();
    assert.equal(store.jobStatus(msg.id), "done");
    assert.match(wa.last, /Mi date l'ok e procedo\? \(rif\. 1\)/);
  });

  it("rielaborare un messaggio non crea una seconda commessa: rimanda solo la proposta", async () => {
    const msg = groupMsg("Parigi ora costa 590€");
    wa.failNext = 1; // l'invio della proposta fallisce al primo tentativo
    await assert.rejects(bot.handle(msg));
    assert.equal(store.get(1)?.proposalMessageId, undefined);

    await bot.handle(msg);
    assert.equal(ai.calls.length, 1, "l'AI non viene richiamata");
    assert.equal(store.get(2), undefined, "nessun doppione");
    assert.equal(store.get(1)?.proposalMessageId, wa.lastId);
  });
});

describe("Ripresa dopo un riavvio", () => {
  it("annulla una pubblicazione rimasta a metà e rimette la commessa in attesa", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    store.transition(1, "in_attesa", "in_corso", { approvedBy: BOSS });
    store.appendUndo(1, { type: "trash_post", post_type: "post", id: 9 });

    await makeBot().recover();
    assert.equal(site.undone.length, 1);
    assert.equal(store.get(1)?.status, "in_attesa");
    assert.deepEqual(store.get(1)?.undo, []);

    await bot.handle(groupMsg("ok 1", BOSS)); // il messaggio di ok rimasto in coda
    assert.equal(store.get(1)?.status, "completata");
  });

  it("se non riesce a rimediare lo segnala nel gruppo", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    store.transition(1, "in_attesa", "in_corso", { approvedBy: BOSS });
    store.appendUndo(1, { type: "trash_post", post_type: "post", id: 9 });
    site.undo = async () => {
      throw new Error("WordPress non raggiungibile");
    };
    await makeBot().recover();
    assert.equal(store.get(1)?.status, "errore");
    assert.match(wa.last, /Mi sono interrotto .* controllate la pagina \(rif\. 1\)/);
  });

  it("un ripristino interrotto si può riprovare", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    store.transition(1, "completata", "in_ripristino");
    await makeBot().recover();
    assert.equal(store.get(1)?.status, "completata");
    await bot.handle(groupMsg("ripristina 1", BOSS));
    assert.equal(store.get(1)?.status, "ripristinata");
  });
});

describe("Scadenza delle proposte", () => {
  it("un ok arrivato troppo tardi non applica la proposta", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    clockOffset = 25 * HOUR;
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.match(wa.last, /proposta \(rif\. 1\) è vecchia/);
    assert.equal(store.get(1)?.status, "scaduta");
    assert.equal(site.applied.length, 0);
  });

  it("un 'ok' generico dopo la scadenza è solo conversazione", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    clockOffset = 25 * HOUR;
    ai.next = { kind: "ignora", summary: "" };
    await bot.handle(groupMsg("ok", BOSS));
    assert.equal(site.applied.length, 0);
    assert.equal(store.get(1)?.status, "scaduta");
  });

  it("entro il tempo previsto l'ok vale", async () => {
    makeBot({ proposalTtlHours: 48 });
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    clockOffset = 25 * HOUR;
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.equal(store.get(1)?.status, "completata");
  });
});

describe("Esito della pubblicazione", () => {
  it("controlla la pagina pubblica prima di dire che è online", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.equal(site.checked.length, 1);
    assert.match(wa.last, /^Fatto, è online \(rif\. 1\):/);
  });

  it("avvisa se la pagina pubblica mostra ancora la versione vecchia", async () => {
    site.publicResult = "non_visibile";
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.match(wa.last, /la modifica è salvata \(rif\. 1\), ma sul sito pubblico vedo ancora la versione di prima/);
    assert.match(wa.last, /cache/);
    assert.equal(store.get(1)?.status, "completata");
  });

  it("non dice 'online' se non ha potuto controllare", async () => {
    site.publicResult = "non_verificabile";
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.match(wa.last, /^Fatto, modifica salvata \(rif\. 1\):/);
  });

  it("distingue le bozze dalle pagine online", async () => {
    site.outcome = "bozza";
    await bot.handle(groupMsg("Nuova offerta Vienna"));
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.match(wa.last, /^Fatto, è salvato in bozza \(rif\. 1\):/);
  });
});

describe("Ripristino sicuro", () => {
  beforeEach(async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
  });

  it("non tocca una pagina modificata da altri nel frattempo", async () => {
    site.conflict = true;
    await bot.handle(groupMsg("ripristina 1", BOSS));
    assert.match(wa.last, /Non l'ho toccata: .*modificata dopo la mia modifica/);
    assert.match(wa.last, /ripristina 1 forza/);
    assert.equal(site.undone.length, 0);
    assert.equal(store.get(1)?.status, "completata");
  });

  it("con 'forza' rimette comunque tutto com'era", async () => {
    site.conflict = true;
    await bot.handle(groupMsg("ripristina 1 forza", BOSS));
    assert.equal(site.undone.length, 1);
    assert.equal(store.get(1)?.status, "ripristinata");
    assert.match(wa.last, /Fatto, ho rimesso com'era prima \(rif\. 1\)/);
  });
});

describe("Approvare rispondendo al messaggio", () => {
  it("l'ok dato in risposta a una proposta approva proprio quella", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    const firstProposal = wa.lastId;
    await bot.handle(groupMsg("Anche Vienna a 349€"));

    await bot.handle(groupMsg("ok", BOSS, { replyTo: firstProposal }));
    assert.equal(store.get(1)?.status, "completata");
    assert.equal(store.get(2)?.status, "in_attesa");
  });

  it("vale anche se nel frattempo il bot ha scritto altro", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    const proposal = wa.lastId;
    ai.next = { kind: "risposta", summary: "", reply: "Sì, l'ho vista" };
    await bot.handle(groupMsg("Hai visto la mail?"));
    await bot.handle(groupMsg("sì vai", BOSS, { replyTo: proposal }));
    assert.equal(store.get(1)?.status, "completata");
  });

  it("chi non è responsabile riceve una risposta chiara", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    await bot.handle(groupMsg("ok", STAFF, { replyTo: wa.lastId }));
    assert.match(wa.last, /aspetto l'ok di un responsabile/);
    assert.equal(store.get(1)?.status, "in_attesa");
  });

  it("'lascia perdere' in risposta annulla quella proposta", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    const firstProposal = wa.lastId;
    await bot.handle(groupMsg("Anche Vienna a 349€"));
    await bot.handle(groupMsg("lascia perdere", STAFF, { replyTo: firstProposal }));
    assert.equal(store.get(1)?.status, "annullata");
    assert.equal(store.get(2)?.status, "in_attesa");
  });
});

describe("Correggere una proposta", () => {
  it("la nuova proposta sostituisce quella sbagliata", async () => {
    await bot.handle(groupMsg("Parigi ora costa 590€"));
    ai.next = { ...PRICE_CHANGE, details: ["prezzo 650€ → 580€"], replaces: 1 };
    await bot.handle(groupMsg("no scusate, 580 non 590"));

    assert.deepEqual(ai.calls[1].pending, [
      { id: 1, summary: "Cambio il prezzo del tour di Parigi di maggio", details: ["prezzo 650€ → 590€"] },
    ]);
    assert.equal(store.get(1)?.status, "annullata");
    assert.equal(store.get(2)?.status, "in_attesa");
    assert.match(wa.last, /^Corretto, cambio il prezzo/);
    assert.match(wa.last, /580€/);
    assert.match(wa.last, /\(rif\. 2\)/);

    await bot.handle(groupMsg("ok", BOSS));
    assert.equal(store.get(2)?.status, "completata");
    assert.equal(site.applied.length, 1);
  });
});

describe("Modifiche programmate e a tempo", () => {
  const inDays = (n: number) => new Date(Date.now() + n * 24 * HOUR).toISOString();

  it("una modifica con data resta in programma fino a quel momento", async () => {
    ai.next = { ...PRICE_CHANGE, scheduled_for: inDays(2) };
    await bot.handle(groupMsg("Dal weekend Parigi costa 590€"));
    assert.match(wa.last, /La metto online (il|l') ?\d+°? \p{L}+ alle \d\d:\d\d\./u);
    assert.match(wa.last, /Mi date l'ok\? \(rif\. 1\)/);

    await bot.handle(groupMsg("ok 1", BOSS));
    assert.equal(store.get(1)?.status, "programmata");
    assert.match(wa.last, /^Ok, la metto online .* \(rif\. 1\)\.$/);
    assert.equal(site.applied.length, 0);

    await bot.runDue();
    assert.equal(site.applied.length, 0, "non è ancora il momento");

    clockOffset = 49 * HOUR;
    await bot.runDue();
    assert.equal(site.applied.length, 1);
    assert.equal(store.get(1)?.status, "completata");
    assert.match(wa.last, /^Fatto, è online \(rif\. 1\):/);

    await bot.runDue();
    assert.equal(site.applied.length, 1, "non viene applicata due volte");
  });

  it("una modifica programmata si può annullare prima della data", async () => {
    ai.next = { ...PRICE_CHANGE, scheduled_for: inDays(2) };
    await bot.handle(groupMsg("Dal weekend Parigi costa 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    await bot.handle(groupMsg("annulla 1", STAFF));
    assert.equal(store.get(1)?.status, "annullata");
    clockOffset = 49 * HOUR;
    await bot.runDue();
    assert.equal(site.applied.length, 0);
  });

  it("un'offerta a tempo viene rimessa com'era alla scadenza", async () => {
    ai.next = { ...PRICE_CHANGE, revert_at: inDays(3) };
    await bot.handle(groupMsg("Fino a domenica Parigi a 590€"));
    assert.match(wa.last, /Rimetto com'era (il|l') ?\d+/);
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.equal(store.get(1)?.status, "completata");
    assert.match(wa.last, /Rimetto com'era/);

    await bot.runDue();
    assert.equal(site.undone.length, 0);

    clockOffset = 73 * HOUR;
    await bot.runDue();
    assert.equal(site.undone.length, 1);
    assert.equal(store.get(1)?.status, "ripristinata");
    assert.match(wa.last, /Come d'accordo ho rimesso com'era \(rif\. 1\)/);
  });

  it("alla scadenza non sovrascrive una pagina modificata da altri, e avvisa una volta sola", async () => {
    ai.next = { ...PRICE_CHANGE, revert_at: inDays(3) };
    await bot.handle(groupMsg("Fino a domenica Parigi a 590€"));
    await bot.handle(groupMsg("ok 1", BOSS));
    site.conflict = true;
    clockOffset = 73 * HOUR;
    await bot.runDue();
    assert.match(wa.last, /dovevo rimettere com'era .* non l'ho toccata/);
    assert.equal(store.get(1)?.status, "completata");
    const sent = wa.sent.length;
    await bot.runDue();
    assert.equal(wa.sent.length, sent);
  });

  it("scrive le date in italiano", () => {
    assert.equal(formatWhen("2026-11-30T23:05:00Z"), "il 1° dicembre alle 00:05");
    assert.equal(formatWhen("2026-12-08T09:30:00Z"), "l'8 dicembre alle 10:30");
    assert.equal(formatWhen("2026-07-15T16:00:00Z"), "il 15 luglio alle 18:00");
  });
});

describe("Foto, PDF e vocali", () => {
  const photo = { id: "m-foto", kind: "image" as const, mimeType: "image/jpeg" };
  const pdf = { id: "m-pdf", kind: "document" as const, mimeType: "application/pdf", filename: "listino.pdf" };
  const docx = { id: "m-doc", kind: "document" as const, mimeType: "application/msword", filename: "note.doc" };
  const voice = { id: "m-voce", kind: "audio" as const, mimeType: "audio/ogg" };

  beforeEach(() => {
    wa.media.set("m-foto", { data: Buffer.from("jpeg"), mimeType: "image/jpeg" });
    wa.media.set("m-pdf", { data: Buffer.from("%PDF"), mimeType: "application/pdf" });
    wa.media.set("m-doc", { data: Buffer.from("doc"), mimeType: "application/msword" });
    wa.media.set("m-voce", { data: Buffer.from("ogg"), mimeType: "audio/ogg" });
  });

  it("una foto senza testo aspetta la richiesta successiva della stessa persona", async () => {
    await bot.handle(mediaMsg(photo));
    assert.equal(ai.calls.length, 0);
    assert.equal(wa.sent.length, 0);

    await bot.handle(groupMsg("mettete questa offerta sul sito"));
    assert.equal(ai.calls[0].attachments?.length, 1);
    assert.equal(ai.calls[0].attachments?.[0].kind, "image");

    await bot.handle(groupMsg("e cambiate anche Vienna a 349€"));
    assert.equal(ai.calls[1].attachments?.length, 0, "la foto è già stata usata");
  });

  it("la foto di un collega non viene allegata alla richiesta di un altro", async () => {
    await bot.handle(mediaMsg(photo, "", BOSS));
    await bot.handle(groupMsg("Parigi a 590€", STAFF));
    assert.equal(ai.calls[0].attachments?.length, 0);
  });

  it("legge foto con didascalia e PDF", async () => {
    await bot.handle(mediaMsg(pdf, "aggiornate i prezzi con questo listino"));
    assert.equal(ai.calls[0].text, "aggiornate i prezzi con questo listino");
    assert.deepEqual(
      ai.calls[0].attachments?.map((a) => [a.kind, a.name]),
      [["pdf", "listino.pdf"]],
    );
  });

  it("dice all'AI quando un allegato non si può leggere", async () => {
    await bot.handle(mediaMsg(docx, "aggiornate con questo"));
    assert.equal(ai.calls[0].attachments?.length, 0);
    assert.deepEqual(ai.calls[0].attachmentNotes, ["allegato in un formato che non so leggere: note.doc"]);
  });

  it("trascrive i vocali e li tratta come testo", async () => {
    const transcriber = new FakeTranscriber("Il tour di Parigi ora costa 590 euro");
    makeBot({ transcriber });
    await bot.handle(mediaMsg(voice));
    assert.equal(transcriber.calls, 1);
    assert.equal(ai.calls[0].text, "Il tour di Parigi ora costa 590 euro");
    assert.match(wa.last, /Mi date l'ok e procedo\?/);
    assert.match(buildUserMessage({ text: "x", history: store.recentMessages(GROUP) }), /\(vocale\) Il tour di Parigi/);
  });

  it("senza trascrizione chiede di scrivere il messaggio", async () => {
    await bot.handle(mediaMsg(voice));
    assert.match(wa.last, /I vocali non riesco ancora ad ascoltarli/);
    assert.equal(ai.calls.length, 0);
  });

  it("se la trascrizione fallisce lo dice, senza inventare", async () => {
    makeBot({ transcriber: new FakeTranscriber(new Error("servizio giù")) });
    await bot.handle(mediaMsg(voice));
    assert.match(wa.last, /Non sono riuscito a sentire bene il vocale/);
    assert.equal(ai.calls.length, 0);
  });

  it("nei vocali il prefisso di attivazione si dice a voce", async () => {
    makeBot({ triggerPrefix: "#sito", transcriber: new FakeTranscriber("Sito, Parigi ora costa 590") });
    await bot.handle(mediaMsg(voice));
    assert.equal(ai.calls[0].text, "Parigi ora costa 590");

    makeBot({ triggerPrefix: "#sito", transcriber: new FakeTranscriber("Ci vediamo dopo pranzo") });
    await bot.handle(mediaMsg(voice));
    assert.equal(ai.calls.length, 1, "un vocale senza prefisso viene ignorato");
  });
});

describe("WhatsApp: allegati, risposte e invio", () => {
  const payload = (messages: unknown[]) => ({
    object: "whatsapp_business_account",
    entry: [{ changes: [{ field: "messages", value: { messages } }] }],
  });

  it("riconosce foto, documenti, vocali e il messaggio a cui si risponde", () => {
    const msgs = parseWebhook(
      payload([
        { from: "39333", group_id: "G", id: "a", type: "image", image: { id: "M1", mime_type: "image/jpeg", caption: " nuova offerta " } },
        { from: "39333", group_id: "G", id: "b", type: "document", document: { id: "M2", mime_type: "application/pdf", filename: "listino.pdf" } },
        { from: "39333", group_id: "G", id: "c", type: "audio", audio: { id: "M3", mime_type: "audio/ogg; codecs=opus" } },
        { from: "39333", group_id: "G", id: "d", type: "text", text: { body: "ok" }, context: { id: "wamid.PROPOSTA" } },
        { from: "39333", group_id: "G", id: "e", type: "sticker" },
      ]),
    );
    assert.equal(msgs.length, 4);
    assert.equal(msgs[0].text, "nuova offerta");
    assert.deepEqual(msgs[0].media, { id: "M1", kind: "image", mimeType: "image/jpeg" });
    assert.deepEqual(msgs[1].media, { id: "M2", kind: "document", mimeType: "application/pdf", filename: "listino.pdf" });
    assert.equal(msgs[1].text, "");
    assert.deepEqual(msgs[2].media, { id: "M3", kind: "audio", mimeType: "audio/ogg" });
    assert.equal(msgs[3].replyTo, "wamid.PROPOSTA");
  });

  function client(handler: (url: string, init?: RequestInit) => Response) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return handler(String(input), init);
    }) as typeof fetch;
    return {
      calls,
      wa: new WhatsAppClient({ accessToken: "tok", phoneNumberId: "111", graphVersion: "v27.0", fetch: fetchFn }),
    };
  }

  it("restituisce l'ID del messaggio inviato", async () => {
    const { wa: c, calls } = client(() => Response.json({ messages: [{ id: "wamid.OUT" }] }));
    assert.equal(await c.sendText("G", "group", "ciao"), "wamid.OUT");
    assert.equal(JSON.parse(String(calls[0].init?.body)).recipient_type, "group");
  });

  it("scarica un allegato in due passaggi, con il token", async () => {
    const { wa: c, calls } = client((url) =>
      url.endsWith("/M1")
        ? Response.json({ url: "https://media.example/file", mime_type: "image/jpeg", file_size: 4 })
        : new Response(Buffer.from("jpeg")),
    );
    const media = await c.downloadMedia("M1");
    assert.equal(media.mimeType, "image/jpeg");
    assert.equal(media.data.toString(), "jpeg");
    assert.equal((calls[1].init?.headers as Record<string, string>).Authorization, "Bearer tok");
  });

  it("rifiuta gli allegati troppo grandi senza scaricarli", async () => {
    const { wa: c, calls } = client(() => Response.json({ url: "https://media.example/file", file_size: 50 * 1024 * 1024 }));
    await assert.rejects(c.downloadMedia("M1"), /troppo grande/);
    assert.equal(calls.length, 1);
  });
});

describe("Trascrizione dei vocali", () => {
  it("manda l'audio al servizio configurato e restituisce il testo", async () => {
    let request: { url: string; init?: RequestInit } | undefined;
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      request = { url: String(input), init };
      return Response.json({ text: " Parigi a 590 euro " });
    }) as typeof fetch;
    const t = new HttpTranscriber({ url: "https://stt.example/v1/audio/transcriptions", apiKey: "k", model: "m", language: "it", fetch: fetchFn });
    assert.equal(await t.transcribe(Buffer.from("ogg"), "audio/ogg; codecs=opus"), "Parigi a 590 euro");
    const form = request?.init?.body as FormData;
    assert.equal(form.get("model"), "m");
    assert.equal(form.get("language"), "it");
    assert.equal((form.get("file") as File).name, "vocale.ogg");
    assert.equal((request?.init?.headers as Record<string, string>).Authorization, "Bearer k");
  });

  it("segnala gli errori del servizio", async () => {
    const fetchFn = (async () => new Response("quota esaurita", { status: 429 })) as typeof fetch;
    const t = new HttpTranscriber({ url: "https://stt.example", apiKey: "k", model: "m", fetch: fetchFn });
    await assert.rejects(t.transcribe(Buffer.from("x"), "audio/ogg"), /429.*quota esaurita/);
  });
});

describe("Messaggio per l'AI", () => {
  const base = { text: "Parigi a 590€", history: [], now: new Date("2026-11-11T09:02:00Z"), timezone: "Europe/Rome" };

  it("indica data, ora e fuso per le modifiche programmate", () => {
    assert.match(buildUserMessage(base), /^Data e ora: 2026-11-11 10:02 \(fuso Europe\/Rome, UTC\+01:00\)/);
  });

  it("elenca le proposte in sospeso e gli allegati", () => {
    const text = buildUserMessage({
      ...base,
      pending: [{ id: 7, summary: "Cambio il prezzo di Parigi", details: ["650€ → 590€"] }],
      attachmentNotes: ["allegato in un formato che non so leggere: note.doc"],
    });
    assert.match(text, /<proposte_in_sospeso>\nrif\. 7: Cambio il prezzo di Parigi \(650€ → 590€\)/);
    assert.match(text, /\[allegato in un formato che non so leggere: note\.doc\]/);
  });

  it("mette foto e PDF prima del testo", () => {
    const blocks = buildUserContent({
      ...base,
      attachments: [
        { kind: "image", mediaType: "image/jpeg", data: Buffer.from("a") },
        { kind: "pdf", mediaType: "application/pdf", data: Buffer.from("b"), name: "listino.pdf" },
      ],
    });
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["image", "document", "text"],
    );
  });

  it("fa correggere al modello date e riferimenti sbagliati", async () => {
    const wp = { validate: async () => {} };
    const now = new Date("2026-11-11T09:00:00Z");
    const check = (extra: object, pending: number[] = []) =>
      checkInterpretation({ ...PRICE_CHANGE, ...extra }, wp, now, new Set(pending));

    assert.equal(await check({}), undefined);
    assert.match((await check({ scheduled_for: "2026-11-01T00:05:00+01:00" })) ?? "", /nel futuro/);
    assert.match((await check({ scheduled_for: "domani" })) ?? "", /ISO 8601/);
    assert.match((await check({ scheduled_for: "2026-12-01T00:05:00+01:00", revert_at: "2026-11-20T00:00:00+01:00" })) ?? "", /revert_at deve venire dopo/);
    assert.equal(await check({ scheduled_for: "2026-12-01T00:05:00+01:00", revert_at: "2026-12-31T23:59:00+01:00" }), undefined);
    assert.match((await check({ replaces: 9 }, [7])) ?? "", /proposta in sospeso \(7\)/);
    assert.equal(await check({ replaces: 7 }, [7]), undefined);
  });
});
