/**
 * Avvio della piattaforma multi-cliente: un solo bot WhatsApp che serve tutti
 * i clienti configurati nella dashboard (database Postgres/Supabase).
 *
 * Per un singolo cliente senza dashboard si usa invece src/index.ts (SQLite).
 */
import pg from "pg";
import { drainActions } from "./actions.js";
import { logAlerter, WebhookAlerter } from "./alerts.js";
import { loadWorkerConfig } from "./config.js";
import { ResendSender } from "./email.js";
import { daily, proposalNotifier } from "./notifications.js";
import { ClaudePrefilter } from "./prefilter.js";
import { MessageQueue } from "./queue.js";
import { createServer } from "./server.js";
import { PgStore, type Db } from "./store-pg.js";
import { TenantRegistry } from "./tenants.js";
import { HttpTranscriber } from "./transcribe.js";
import { WhatsAppClient } from "./whatsapp.js";

const config = loadWorkerConfig();

const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 5 });
pool.on("error", (err) => console.error("[database] errore di connessione:", err.message));
const store = new PgStore(pool as unknown as Db);
const whatsapp = new WhatsAppClient(config.whatsapp);
const alerter = config.alertWebhookUrl ? new WebhookAlerter({ url: config.alertWebhookUrl }) : logAlerter;
const email = config.email ? new ResendSender(config.email) : undefined;

const registry = new TenantRegistry({
  store,
  messenger: whatsapp,
  credentialsKey: config.credentialsKey,
  model: config.anthropic.model,
  effort: config.anthropic.effort,
  prefilter: new ClaudePrefilter({ model: config.anthropic.prefilterModel }),
  transcriber: config.transcription ? new HttpTranscriber(config.transcription) : undefined,
  alerter,
  onProposal: email ? proposalNotifier(store, email, config.dashboardUrl) : undefined,
});

const queue = new MessageQueue(store, async (msg) => {
  const entry = await registry.forChat(msg.chatId);
  if (!entry) {
    console.warn(`[worker] messaggio da una chat non collegata a nessun cliente: ${msg.chatId}`);
    await store.noteUnknownChat(msg);
    return;
  }
  if (!entry.bot) {
    console.warn(`[worker] ${entry.tenant.name}: messaggio ignorato, ${entry.problem}`);
    return;
  }
  await entry.bot.handle(msg);
}, {
  onGiveUp: (msg, reason) => alerter.alert(`Messaggio WhatsApp non elaborato dopo più tentativi (chat ${msg.chatId}): ${reason}`),
});

// Ripresa dopo un riavvio: commesse a metà, azioni a metà, messaggi in coda.
await store.pruneJobs();
await registry.refresh();
const entries = await registry.all();
for (const entry of entries) await entry.bot?.recover();
await store.resetInterruptedActions();
const resumed = await queue.resume();
console.log(`Clienti attivi: ${entries.length} (${entries.filter((e) => e.bot).length} pronti)${resumed ? `, ${resumed} messaggi ripresi dalla coda` : ""}`);
for (const entry of entries) if (!entry.bot) console.warn(`  ${entry.tenant.name}: ${entry.problem}`);

// Privacy: i messaggi delle chat più vecchi del periodo di conservazione vengono cancellati.
if (config.messageRetentionDays > 0) {
  daily("conservazione", async () => {
    const removed = await store.pruneMessages(config.messageRetentionDays);
    if (removed) console.log(`[conservazione] cancellati ${removed} messaggi più vecchi di ${config.messageRetentionDays} giorni`);
  });
}
if (!config.email) console.warn("ℹ️  Email ai responsabili non configurate (EMAIL_API_KEY).");
if (!config.whatsapp.fallbackTemplate) {
  console.warn("ℹ️  Nessun messaggio modello WhatsApp (WHATSAPP_TEMPLATE_AVVISO): gli avvisi fuori dalla finestra di 24 ore non partono.");
}

// Modifiche programmate e offerte a scadenza: ogni minuto, per ogni cliente.
let scheduling = false;
const scheduler = setInterval(async () => {
  if (scheduling) return;
  scheduling = true;
  try {
    for (const entry of await registry.all()) await entry.bot?.runDue();
  } catch (err) {
    console.error("[scheduler] errore:", err);
  } finally {
    scheduling = false;
  }
}, 60_000);

// Azioni chieste dalla dashboard: controllo ogni 3 secondi.
let acting = false;
const actions = setInterval(async () => {
  if (acting) return;
  acting = true;
  try {
    await drainActions(registry, store);
  } catch (err) {
    console.error("[azioni] errore:", err);
  } finally {
    acting = false;
  }
}, 3_000);

const app = createServer({
  verifyToken: config.whatsapp.verifyToken,
  appSecret: config.whatsapp.appSecret,
  onMessage: async (msg) => {
    await queue.enqueue(msg);
  },
});

const server = app.listen(config.port, () => {
  console.log(`Bot multi-cliente in ascolto sulla porta ${config.port} (webhook: /webhook)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(scheduler);
    clearInterval(actions);
    server.close(() => {
      const timeout = new Promise((resolve) => setTimeout(resolve, 20_000).unref());
      void Promise.race([queue.idle(), timeout]).then(async () => {
        await pool.end().catch(() => {});
        process.exit(0);
      });
    });
  });
}
