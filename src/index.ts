import { ClaudeInterpreter } from "./ai.js";
import { Bot, type SiteEditor } from "./bot.js";
import { loadConfig } from "./config.js";
import { MessageQueue } from "./queue.js";
import { createServer } from "./server.js";
import { Store } from "./store.js";
import { HttpTranscriber } from "./transcribe.js";
import { WhatsAppClient } from "./whatsapp.js";
import { WordPressClient } from "./wordpress.js";

const config = loadConfig();

const store = new Store(config.databasePath);
const whatsapp = new WhatsAppClient(config.whatsapp);
const wordpress = new WordPressClient(config.wordpress);
const interpreter = new ClaudeInterpreter(wordpress, config.anthropic);

const site: SiteEditor = {
  apply: (op, record) => wordpress.apply(op, record),
  undo: (step, opts) => wordpress.undo(step, opts),
  ...(config.verifyPublic ? { verifyPublic: (check) => wordpress.verifyPublic(check) } : {}),
};

const bot = new Bot(store, interpreter, site, whatsapp, {
  allowedGroups: config.allowedGroups,
  allowedSenders: config.allowedSenders,
  approvers: config.approvers,
  triggerPrefix: config.triggerPrefix,
  proposalTtlHours: config.proposalTtlHours,
  timezone: config.timezone,
  transcriber: config.transcription ? new HttpTranscriber(config.transcription) : undefined,
});

if (config.allowedGroups.length === 0 && config.allowedSenders.length === 0) {
  console.warn(
    "⚠️  ALLOWED_GROUPS e ALLOWED_SENDERS sono vuoti: il bot ignorerà tutti i messaggi. " +
      "Scrivi nel gruppo e copia dal log il group_id da inserire in ALLOWED_GROUPS.",
  );
}
if (config.approvers.length === 0) {
  console.warn("⚠️  APPROVERS è vuoto: chiunque nelle chat autorizzate potrà approvare le commesse.");
}
if (!config.transcription) {
  console.warn("ℹ️  Trascrizione dei vocali non configurata (TRANSCRIPTION_URL): ai vocali il bot chiederà di scrivere.");
}

const queue = new MessageQueue(store, (msg) => bot.handle(msg));

// Ripresa dopo un riavvio: prima le commesse rimaste a metà, poi i messaggi ancora in coda.
store.pruneJobs();
await bot.recover();
const resumed = queue.resume();
if (resumed > 0) console.log(`Riprendo ${resumed} messaggi rimasti in coda`);

// Modifiche programmate e offerte a scadenza: controllo ogni minuto.
const tick = () => bot.runDue().catch((err) => console.error("[scheduler] errore:", err));
const scheduler = setInterval(tick, 60_000);
void tick();

const app = createServer({
  verifyToken: config.whatsapp.verifyToken,
  appSecret: config.whatsapp.appSecret,
  onMessage: (msg) => {
    queue.enqueue(msg);
  },
});

const server = app.listen(config.port, () => {
  console.log(`Bot in ascolto sulla porta ${config.port} (webhook: /webhook)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    clearInterval(scheduler);
    server.close(() => {
      // Lascio finire i messaggi in lavorazione (quelli non finiti restano in coda su disco).
      const timeout = new Promise((resolve) => setTimeout(resolve, 20_000).unref());
      void Promise.race([queue.idle(), timeout]).then(() => {
        store.close();
        process.exit(0);
      });
    });
  });
}
