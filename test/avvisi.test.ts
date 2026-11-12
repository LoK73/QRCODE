import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { WebhookAlerter } from "../src/alerts.js";
import { Bot } from "../src/bot.js";
import { proposalEmail, ResendSender, type EmailMessage } from "../src/email.js";
import { proposalNotifier } from "../src/notifications.js";
import { MessageQueue } from "../src/queue.js";
import { Store } from "../src/store.js";
import type { Tenant } from "../src/store-pg.js";
import { OUTSIDE_WINDOW, templateParameter, WhatsAppClient } from "../src/whatsapp.js";
import { BOSS, FakeInterpreter, FakeMessenger, FakeSite, GROUP, PRICE_CHANGE, groupMsg } from "./helpers.js";

function recorder(handler: (body: Record<string, unknown>, call: number) => Response) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ url: String(input), body, headers: (init?.headers ?? {}) as Record<string, string> });
    return handler(body, calls.length);
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("WhatsApp fuori dalla finestra di 24 ore", () => {
  const outside = () => Response.json({ error: { message: "Re-engagement message", code: OUTSIDE_WINDOW } }, { status: 400 });

  it("ripiega sul messaggio modello con il testo su una riga", async () => {
    const { calls, fetchFn } = recorder((body) => (body.type === "text" ? outside() : Response.json({ messages: [{ id: "wamid.T" }] })));
    const wa = new WhatsAppClient({ accessToken: "t", phoneNumberId: "1", graphVersion: "v27.0", fallbackTemplate: { name: "avviso_sito", language: "it" }, fetch: fetchFn });
    const id = await wa.sendText("G", "group", "Fatto, è online (rif. 4):\nhttps://sito.example/parigi");
    assert.equal(id, "wamid.T");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body.template, {
      name: "avviso_sito",
      language: { code: "it" },
      components: [{ type: "body", parameters: [{ type: "text", text: "Fatto, è online (rif. 4): · https://sito.example/parigi" }] }],
    });
    assert.equal(calls[1].body.recipient_type, "group");
  });

  it("senza modello configurato, o per altri errori, l'errore resta", async () => {
    const plain = recorder(() => outside());
    const wa = new WhatsAppClient({ accessToken: "t", phoneNumberId: "1", graphVersion: "v27.0", fetch: plain.fetchFn });
    await assert.rejects(wa.sendText("G", "group", "ciao"), /131047/);

    const other = recorder(() => Response.json({ error: { message: "Invalid token", code: 190 } }, { status: 401 }));
    const wa2 = new WhatsAppClient({ accessToken: "t", phoneNumberId: "1", graphVersion: "v27.0", fallbackTemplate: { name: "x", language: "it" }, fetch: other.fetchFn });
    await assert.rejects(wa2.sendText("G", "group", "ciao"), /Invalid token/);
    assert.equal(other.calls.length, 1);
  });

  it("prepara il parametro del modello secondo le regole di Meta", () => {
    assert.equal(templateParameter("Cambio il prezzo:\n- 650€ → 590€\n\nMi date l'ok?    (rif. 3)"), "Cambio il prezzo: · 650€ → 590€ · Mi date l'ok? (rif. 3)");
    assert.equal(templateParameter("x".repeat(2000)).length, 1000);
  });
});

describe("Avvisi all'agenzia", () => {
  it("manda il testo al webhook e non ripete lo stesso avviso per 10 minuti", async () => {
    const { calls, fetchFn } = recorder(() => new Response("ok"));
    let now = 0;
    const alerter = new WebhookAlerter({ url: "https://hooks.example/x", prefix: "[prod]", fetch: fetchFn, now: () => now });
    alerter.alert("Commessa 3 non riuscita");
    alerter.alert("Commessa 3 non riuscita");
    alerter.alert("Commessa 4 non riuscita");
    now = 11 * 60_000;
    alerter.alert("Commessa 3 non riuscita");
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(calls.map((c) => c.body.text), ["[prod] Commessa 3 non riuscita", "[prod] Commessa 4 non riuscita", "[prod] Commessa 3 non riuscita"]);
  });

  it("il bot avvisa quando una modifica non riesce o un messaggio non viene consegnato", async () => {
    const store = new Store(":memory:");
    const site = new FakeSite();
    const wa = new FakeMessenger();
    const problems: string[] = [];
    const bot = new Bot(store, new FakeInterpreter(PRICE_CHANGE), site, wa, {
      allowedGroups: [GROUP], allowedSenders: [], approvers: [BOSS], triggerPrefix: "",
      onProblem: (t) => problems.push(t),
    });
    await bot.handle(groupMsg("Parigi a 590"));
    site.failOn = 0;
    await bot.handle(groupMsg("ok 1", BOSS));
    assert.deepEqual(problems, ["Commessa 1 non riuscita: WordPress non raggiungibile"]);

    site.failOn = undefined;
    await bot.handle(groupMsg("Parigi a 590"));
    wa.failNext = 1;
    await bot.handle(groupMsg("ok 2", BOSS));
    assert.match(problems[1], /Messaggio WhatsApp non consegnato per la commessa 2: WhatsApp non raggiungibile/);
  });

  it("la coda avvisa quando abbandona un messaggio", async () => {
    const store = new Store(":memory:");
    const gaveUp: string[] = [];
    const queue = new MessageQueue(store, async () => { throw new Error("sempre rotto"); }, {
      retryDelayMs: 0, maxAttempts: 2, onGiveUp: (m, reason) => gaveUp.push(`${m.id}: ${reason}`),
    });
    const msg = groupMsg("ciao");
    await queue.enqueue(msg);
    await queue.idle();
    assert.deepEqual(gaveUp, [`${msg.id}: sempre rotto`]);
  });
});

describe("Email ai responsabili", () => {
  it("una nuova proposta fa partire la notifica una volta sola", async () => {
    const store = new Store(":memory:");
    const notified: number[] = [];
    const bot = new Bot(store, new FakeInterpreter(PRICE_CHANGE), new FakeSite(), new FakeMessenger(), {
      allowedGroups: [GROUP], allowedSenders: [], approvers: [BOSS], triggerPrefix: "",
      onProposal: async (c) => { notified.push(c.id); },
    });
    const msg = groupMsg("Parigi a 590");
    await bot.handle(msg);
    await bot.handle(msg); // il webhook ripete la notifica
    assert.deepEqual(notified, [1]);
  });

  it("un'email per destinatario, con link alla commessa", async () => {
    const sent: EmailMessage[] = [];
    const notify = proposalNotifier(
      { proposalRecipients: async () => ["francesca@aurora.example", "luca@agenzia.example"] },
      { send: async (m) => { sent.push(m); } },
      "https://dashboard.example",
    );
    const tenant = { id: "c1", name: "Viaggi Aurora" } as Tenant;
    await notify(tenant, { id: 7, summary: "Cambio il prezzo di Parigi", details: ["650€ → 590€"], requesterName: "Marco" } as never);
    assert.deepEqual(sent.map((m) => m.to), [["francesca@aurora.example"], ["luca@agenzia.example"]]);
    assert.equal(sent[0].subject, "Da approvare: Cambio il prezzo di Parigi (Viaggi Aurora)");
    assert.match(sent[0].text, /https:\/\/dashboard\.example\/commesse\/7/);
  });

  it("il testo della richiesta non può iniettare HTML nell'email", () => {
    const email = proposalEmail({ clientName: "A&B", id: 1, summary: "<script>x</script>", details: ['"><img src=x>'], requesterName: "M", link: "https://d.example/commesse/1" });
    assert.doesNotMatch(email.html, /<script>|<img/);
    assert.match(email.html, /&lt;script&gt;/);
    assert.match(email.html, /A&amp;B/);
  });

  it("invia tramite Resend con la chiave e il mittente configurati", async () => {
    const { calls, fetchFn } = recorder(() => Response.json({ id: "e1" }));
    await new ResendSender({ apiKey: "re_test", from: "Commesse <n@agenzia.example>", fetch: fetchFn }).send({ to: ["a@b.example"], subject: "s", text: "t", html: "<p>t</p>" });
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].headers.Authorization, "Bearer re_test");
    assert.deepEqual(calls[0].body, { from: "Commesse <n@agenzia.example>", to: ["a@b.example"], subject: "s", text: "t", html: "<p>t</p>" });

    const failing = recorder(() => new Response("dominio non verificato", { status: 403 }));
    await assert.rejects(new ResendSender({ apiKey: "k", from: "x", fetch: failing.fetchFn }).send({ to: ["a@b.example"], subject: "s", text: "t", html: "" }), /403.*dominio non verificato/);
  });
});

describe("Conservazione dei messaggi", () => {
  it("cancella solo i messaggi più vecchi del periodo indicato", () => {
    const store = new Store(":memory:");
    const now = Math.floor(Date.now() / 1000);
    store.addMessage(GROUP, { from: "a", text: "vecchio", bot: false, timestamp: now - 100 * 86_400 });
    store.addMessage(GROUP, { from: "a", text: "recente", bot: false, timestamp: now - 10 * 86_400 });
    assert.equal(store.pruneMessages(90), 1);
    assert.deepEqual(store.recentMessages(GROUP).map((m) => m.text), ["recente"]);
  });
});
