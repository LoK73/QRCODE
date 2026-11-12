import type { Interpretation } from "../src/operations.js";

/** Un messaggio di prova con il risultato atteso. */
export interface EvalCase {
  id: string;
  /** Il messaggio scritto nel gruppo. */
  text: string;
  /** Messaggi precedenti, se servono a capire. */
  history?: Array<{ from: string; text: string; bot?: boolean }>;
  /** Proposte ancora in sospeso al momento del messaggio. */
  pending?: Array<{ id: number; summary: string; details: string[] }>;
  expect: {
    /** Il tipo di risposta giusto (o più tipi accettabili). */
    kind: Interpretation["kind"] | Array<Interpretation["kind"]>;
    /** ID dei contenuti che la commessa deve toccare. */
    pages?: number[];
    /** Testi di cui almeno uno deve comparire tra i nuovi valori (es. il prezzo nuovo). */
    newValue?: string[];
    /** true se deve essere una modifica programmata. */
    scheduled?: boolean;
    /** true se deve avere una scadenza con ripristino. */
    revert?: boolean;
    /** Rif. della proposta che deve sostituire. */
    replaces?: number;
    /** Deve creare un contenuto nuovo. */
    creates?: boolean;
    /** Altri contenuti in cui lo stesso dato è ripetuto: trovarli è un merito in più, non un obbligo. */
    bonusPages?: number[];
  };
  note?: string;
}

export interface Score {
  pass: boolean;
  /** Cosa non corrisponde alle attese. */
  problems: string[];
  /** Quante delle pagine "bonus" sono state trovate. */
  bonusFound: number;
  bonusTotal: number;
}

/** Tutti i testi nuovi che una commessa scriverebbe sul sito. */
function newTexts(result: Interpretation): string {
  const parts: string[] = [];
  for (const op of result.operations ?? []) {
    if (op.type === "update_post") {
      parts.push(op.title ?? "", op.content ?? "", op.excerpt ?? "");
      for (const r of op.content_replacements ?? []) parts.push(r.replace);
      for (const f of op.acf ?? []) parts.push(f.value);
    } else if (op.type === "create_post") {
      parts.push(op.title, op.content, op.excerpt ?? "");
      for (const f of op.acf ?? []) parts.push(f.value);
    } else {
      parts.push(op.regular_price ?? "", op.sale_price ?? "");
    }
  }
  return parts.join("\n");
}

function touchedPages(result: Interpretation): number[] {
  return (result.operations ?? []).flatMap((op) =>
    op.type === "update_post" ? [op.id] : op.type === "update_product_price" ? [op.product_id] : [],
  );
}

export function scoreCase(c: EvalCase, result: Interpretation): Score {
  const problems: string[] = [];
  const kinds = Array.isArray(c.expect.kind) ? c.expect.kind : [c.expect.kind];
  if (!kinds.includes(result.kind)) {
    problems.push(`tipo "${result.kind}" invece di ${kinds.map((k) => `"${k}"`).join(" o ")}`);
  }

  const touched = touchedPages(result);
  if (result.kind === "commessa") {
    for (const id of c.expect.pages ?? []) {
      if (!touched.includes(id)) problems.push(`non tocca il contenuto ${id}`);
    }
    if (c.expect.newValue?.length) {
      const text = newTexts(result);
      if (!c.expect.newValue.some((v) => text.includes(v))) {
        problems.push(`manca il nuovo valore (${c.expect.newValue.join(" / ")})`);
      }
    }
    if (c.expect.scheduled !== undefined && Boolean(result.scheduled_for) !== c.expect.scheduled) {
      problems.push(c.expect.scheduled ? "doveva essere programmata" : "non doveva essere programmata");
    }
    if (c.expect.revert !== undefined && Boolean(result.revert_at) !== c.expect.revert) {
      problems.push(c.expect.revert ? "doveva avere una scadenza" : "non doveva avere una scadenza");
    }
    if (c.expect.replaces !== undefined && result.replaces !== c.expect.replaces) {
      problems.push(`doveva sostituire la proposta ${c.expect.replaces}`);
    }
    if (c.expect.creates && !(result.operations ?? []).some((op) => op.type === "create_post")) {
      problems.push("doveva creare un contenuto nuovo");
    }
  }

  const bonus = c.expect.bonusPages ?? [];
  return {
    pass: problems.length === 0,
    problems,
    bonusFound: bonus.filter((id) => touched.includes(id)).length,
    bonusTotal: bonus.length,
  };
}

/** Per il filtro economico: un messaggio va fatto passare se la risposta giusta non è (solo) "ignora". */
export function shouldPassFilter(c: EvalCase): boolean | undefined {
  const kinds = Array.isArray(c.expect.kind) ? c.expect.kind : [c.expect.kind];
  if (kinds.every((k) => k === "ignora")) return false;
  if (kinds.includes("ignora")) return undefined; // entrambe le scelte sono accettabili
  return true;
}
