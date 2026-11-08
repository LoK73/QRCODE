import { ClaudeInterpreter } from "./ai.js";
import { Bot } from "./bot.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { Store } from "./store.js";
import { WhatsAppClient } from "./whatsapp.js";
import { WordPressClient } from "./wordpress.js";

const config = loadConfig();

const store = new Store(config.databasePath);
const whatsapp = new WhatsAppClient(config.whatsapp);
const wordpress = new WordPressClient(config.wordpress);
const interpreter = new ClaudeInterpreter(wordpress, config.anthropic);

const bot = new Bot(store, interpreter, wordpress, whatsapp, {
  allowedGroups: config.allowedGroups,
  allowedSenders: config.allowedSenders,
  approvers: config.approvers,
  triggerPrefix: config.triggerPrefix,
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

const app = createServer({
  verifyToken: config.whatsapp.verifyToken,
  appSecret: config.whatsapp.appSecret,
  onMessage: (msg) => bot.handle(msg),
});

const server = app.listen(config.port, () => {
  console.log(`Bot in ascolto sulla porta ${config.port} (webhook: /webhook)`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => {
      store.close();
      process.exit(0);
    });
  });
}
