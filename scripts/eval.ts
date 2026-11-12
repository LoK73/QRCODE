/**
 * Misura quanto bene l'AI capisce i messaggi di prova in evals/casi.json,
 * lavorando su un finto sito WordPress in memoria (nessun sito vero viene toccato).
 *
 *   npm run eval                 tutti i casi
 *   npm run eval -- --solo saluto,prezzo-chiaro
 *   npm run eval -- --filtro     prova anche il filtro economico (PREFILTER_MODEL o claude-haiku-5-5)
 *   npm run eval -- --ripeti 3   ogni caso più volte, per vedere quanto è stabile
 *
 * Ogni esecuzione chiama davvero Claude e quindi ha un costo: alla fine viene stampato.
 * Serve ANTHROPIC_API_KEY. Modello e impegno si scelgono con ANTHROPIC_MODEL e ANTHROPIC_EFFORT.
 */
import fs from "node:fs";
import { ClaudeInterpreter } from "../src/ai.js";
import { ClaudePrefilter } from "../src/prefilter.js";
import type { AiUsage, ChatMessage } from "../src/store.js";
import { WordPressClient } from "../src/wordpress.js";
import { scoreCase, shouldPassFilter, type EvalCase } from "../evals/punteggio.js";
import { FIXTURE_SITE_URL, fixtureFetch } from "../evals/sito-di-prova.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

const model = process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5";
const effort = (process.env.ANTHROPIC_EFFORT ?? "medium") as "low" | "medium" | "high" | "xhigh" | "max";
const filterModel = process.env.PREFILTER_MODEL || "claude-haiku-5-5";
const repeat = Number(option("--ripeti") ?? 1);
const only = option("--solo")?.split(",");

let cases = JSON.parse(fs.readFileSync(new URL("../evals/casi.json", import.meta.url), "utf8")) as EvalCase[];
if (only) cases = cases.filter((c) => only.includes(c.id));
if (!cases.length) throw new Error("Nessun caso da provare");

const usages: AiUsage[] = [];
const onUsage = (u: AiUsage) => usages.push(u);
const toHistory = (c: EvalCase): ChatMessage[] =>
  (c.history ?? []).map((m, i) => ({ from: m.from, fromName: m.bot ? undefined : m.from, text: m.text, bot: Boolean(m.bot), timestamp: i }));

console.log(`Modello: ${model} (impegno ${effort}) · ${cases.length} casi × ${repeat}${flag("--filtro") ? ` · filtro: ${filterModel}` : ""}\n`);

let passed = 0;
let total = 0;
let bonusFound = 0;
let bonusTotal = 0;
let filterRight = 0;
let filterTotal = 0;
let filterMissed = 0;
const failures: string[] = [];

for (const c of cases) {
  for (let run = 0; run < repeat; run++) {
    // Ogni prova parte da un sito pulito: le prove non si influenzano tra loro.
    const wp = new WordPressClient({
      url: FIXTURE_SITE_URL,
      user: "prova",
      appPassword: "prova",
      postTypes: ["page", "post"],
      woocommerce: false,
      fetch: fixtureFetch(),
    });
    const history = toHistory(c);

    if (flag("--filtro")) {
      const want = shouldPassFilter(c);
      if (want !== undefined && !c.pending?.length && !history.at(-1)?.bot) {
        const got = await new ClaudePrefilter({ model: filterModel }).relevant({ text: c.text, senderName: "Marco", history, onUsage });
        filterTotal++;
        if (got === want) filterRight++;
        else if (want) {
          filterMissed++;
          failures.push(`[filtro] ${c.id}: richiesta vera scartata`);
        }
      }
    }

    total++;
    try {
      const result = await new ClaudeInterpreter(wp, { model, effort, profile: "Agenzia di viaggi. Il prezzo dei viaggi è anche nel campo ACF 'prezzo'." }).interpret({
        text: c.text,
        senderName: "Marco",
        history,
        pending: c.pending,
        onUsage,
      });
      const score = scoreCase(c, result);
      bonusFound += score.bonusFound;
      bonusTotal += score.bonusTotal;
      if (score.pass) passed++;
      else failures.push(`${c.id}: ${score.problems.join("; ")}`);
      console.log(`${score.pass ? "OK    " : "ERRORE"} ${c.id.padEnd(26)} → ${result.kind}${score.pass ? "" : `  (${score.problems.join("; ")})`}`);
    } catch (err) {
      failures.push(`${c.id}: errore ${err instanceof Error ? err.message : String(err)}`);
      console.log(`ERRORE ${c.id.padEnd(26)} → ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const cost = usages.reduce((sum, u) => sum + (u.costUsd ?? 0), 0);
const costOf = (purpose: string) => usages.filter((u) => u.purpose === purpose).reduce((s, u) => s + (u.costUsd ?? 0), 0);

console.log(`\nRisultato: ${passed}/${total} corretti (${Math.round((passed / total) * 100)}%)`);
if (bonusTotal) console.log(`Stesso dato in altre pagine: trovato ${bonusFound} volte su ${bonusTotal}`);
if (filterTotal) {
  console.log(`Filtro: ${filterRight}/${filterTotal} giusti, ${filterMissed} richieste vere scartate (devono essere 0)`);
  console.log(`Costo medio per messaggio: filtro ${(costOf("filtro") / filterTotal).toFixed(4)} $, modello principale ${(costOf("interpretazione") / total).toFixed(4)} $`);
}
console.log(`Costo di questa prova: ${cost.toFixed(2)} $`);
if (failures.length) {
  console.log("\nDa guardare:");
  for (const f of failures) console.log(`- ${f}`);
  process.exitCode = 1;
}
