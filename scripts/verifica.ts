/**
 * Controlla che tutti i collegamenti funzionino, senza modificare nulla:
 * WordPress, WhatsApp, Claude e (se configurata) la trascrizione dei vocali.
 *
 *   npm run verifica
 */
import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "../src/config.js";
import { WhatsAppClient } from "../src/whatsapp.js";
import { WordPressClient } from "../src/wordpress.js";

const config = loadConfig();
let failed = false;
const ok = (what: string, detail = "") => console.log(`OK      ${what}${detail ? ` — ${detail}` : ""}`);
const ko = (what: string, detail: string) => {
  failed = true;
  console.log(`ERRORE  ${what} — ${detail}`);
};
const note = (text: string) => console.log(`        ${text}`);
const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// WordPress
const site = await new WordPressClient(config.wordpress).checkConnection();
if (site.ok) ok("WordPress", `utente ${site.user?.name} (${site.user?.roles.join(", ") || "ruolo non indicato"})`);
else ko("WordPress", site.problems.join(" "));
if (site.availableTypes.length) {
  note(`Tipi di contenuto sul sito: ${site.availableTypes.map((t) => `${t.name} [${t.slug}]`).join(", ")}`);
  note(`Il bot può modificare: ${config.wordpress.postTypes.join(", ")} (WP_POST_TYPES)`);
}
if (site.user) {
  note(site.acfVisible ? "Campi personalizzati ACF: visibili" : "Campi personalizzati ACF: non visibili (attiva \"Show in REST API\" se li usi)");
  note(`WooCommerce: ${site.woocommerce ? "presente" : "non presente"}`);
}

// WhatsApp
try {
  const wa = await new WhatsAppClient(config.whatsapp).checkConnection();
  ok("WhatsApp", `${wa.name ?? "numero"} ${wa.number ?? ""}${wa.quality ? `, qualità ${wa.quality}` : ""}`);
} catch (err) {
  ko("WhatsApp", message(err));
}
if (!config.allowedGroups.length && !config.allowedSenders.length) {
  note("Attenzione: ALLOWED_GROUPS e ALLOWED_SENDERS sono vuoti, il bot ignorerà tutti i messaggi.");
}

// Claude
try {
  const client = new Anthropic();
  await client.models.retrieve(config.anthropic.model);
  ok("Claude", config.anthropic.model);
  if (config.anthropic.prefilterModel) {
    await client.models.retrieve(config.anthropic.prefilterModel);
    ok("Filtro economico", config.anthropic.prefilterModel);
  }
} catch (err) {
  ko("Claude", message(err));
}

// Trascrizione dei vocali
if (config.transcription) {
  try {
    const modelsUrl = config.transcription.url.replace(/\/audio\/transcriptions\/?$/, "/models");
    const res = await fetch(modelsUrl, { headers: { Authorization: `Bearer ${config.transcription.apiKey}` } });
    if (res.ok) ok("Trascrizione vocali", `${new URL(modelsUrl).host}, modello ${config.transcription.model}`);
    else ko("Trascrizione vocali", `il servizio ha risposto ${res.status}: chiave non valida?`);
  } catch (err) {
    ko("Trascrizione vocali", message(err));
  }
} else {
  note("Trascrizione vocali: non configurata (TRANSCRIPTION_API_KEY)");
}

process.exitCode = failed ? 1 : 0;
