/**
 * Crea il gruppo WhatsApp gestito dal numero business del bot.
 *
 *   npm run crea-gruppo -- "Aggiornamenti sito" "Richieste di modifica al sito web"
 *
 * Il link d'invito arriva al webhook (evento group_lifecycle_update) e si può
 * anche leggere con:  npm run crea-gruppo -- --link <GROUP_ID>
 *
 * Requisito Meta: il numero deve essere un Official Business Account (spunta blu/verde).
 */
import { loadConfig } from "../src/config.js";
import { WhatsAppClient } from "../src/whatsapp.js";

const config = loadConfig();
const wa = new WhatsAppClient(config.whatsapp);
const args = process.argv.slice(2);

if (args[0] === "--link") {
  if (!args[1]) throw new Error("Indica il GROUP_ID: npm run crea-gruppo -- --link <GROUP_ID>");
  console.log(JSON.stringify(await wa.getInviteLink(args[1]), null, 2));
} else {
  const subject = args[0] ?? "Aggiornamenti sito";
  const description = args[1] ?? "Scrivete qui le modifiche da fare al sito: il bot prepara la commessa.";
  console.log(JSON.stringify(await wa.createGroup(subject, description), null, 2));
  console.log("\nGruppo richiesto. Il group_id e il link d'invito arrivano al webhook (group_lifecycle_update).");
}
