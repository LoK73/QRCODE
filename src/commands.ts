/**
 * Comandi testuali riconosciuti nel gruppo (senza passare dall'AI):
 *
 *   ok 12 / approva 12 / conferma 12   → applica la commessa 12 al sito
 *   ok                                 → approva l'unica commessa in attesa
 *   annulla 12 / no 12                 → scarta la commessa 12
 *   ripristina 12                      → annulla sul sito le modifiche della 12
 *   stato 12                           → mostra la commessa 12
 *   commesse                           → elenco commesse aperte e recenti
 *   aiuto                              → istruzioni
 */

export type Command =
  | { type: "approve"; id?: number }
  | { type: "cancel"; id?: number }
  | { type: "revert"; id: number }
  | { type: "status"; id: number }
  | { type: "list" }
  | { type: "help" };

const ID = String.raw`#?\s*(\d+)`;

const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => Command]> = [
  // "ok" e simili funzionano anche senza numero; "sì"/"vai"/"no" solo con il numero,
  // per non scambiare una normale conversazione per un comando.
  [new RegExp(String.raw`^(?:ok|okay|approva|approvo|conferma|confermo)(?:\s+${ID})?$`, "i"), (m) => ({ type: "approve", id: num(m[1]) })],
  [new RegExp(String.raw`^(?:s[iì]|vai)\s+${ID}$`, "i"), (m) => ({ type: "approve", id: num(m[1]) })],
  [new RegExp(String.raw`^(?:annulla|scarta)(?:\s+${ID})?$`, "i"), (m) => ({ type: "cancel", id: num(m[1]) })],
  [new RegExp(String.raw`^no\s+${ID}$`, "i"), (m) => ({ type: "cancel", id: num(m[1]) })],
  [new RegExp(String.raw`^(?:ripristina|rollback|undo)\s+${ID}$`, "i"), (m) => ({ type: "revert", id: Number(m[1]) })],
  [new RegExp(String.raw`^(?:stato|commessa)\s+${ID}$`, "i"), (m) => ({ type: "status", id: Number(m[1]) })],
  [/^(?:commesse|lista|elenco)$/i, () => ({ type: "list" })],
  [/^(?:aiuto|help|\?)$/i, () => ({ type: "help" })],
];

function num(s: string | undefined): number | undefined {
  return s === undefined ? undefined : Number(s);
}

export function parseCommand(text: string): Command | undefined {
  const clean = text
    .trim()
    .replace(/[.!👍✅]+$/u, "")
    .trim();
  for (const [re, build] of PATTERNS) {
    const m = clean.match(re);
    if (m) return build(m);
  }
  return undefined;
}
