/**
 * Comandi riconosciuti nel gruppo senza passare dall'AI.
 *
 * Forme esplicite (con il numero di riferimento), valide sempre:
 *   ok 12 / vai 12 / procedi 12 / sì 12   → applica la commessa 12
 *   annulla 12 / no 12                    → scarta la commessa 12
 *   ripristina 12                         → riporta il sito com'era prima della 12
 *   ripristina 12 forza                   → come sopra, anche se la pagina è stata modificata dopo
 *   riprova 12                            → rifà da capo una commessa non riuscita o scaduta
 *   stato 12                              → dettagli della commessa 12
 *   commesse                              → elenco
 *   aiuto                                 → istruzioni
 *
 * Forme naturali, senza numero ("sì vai", "procedi", "lascia perdere"): sono
 * marcate `loose` e il bot le accetta solo se c'è una sola commessa in attesa
 * e la sua proposta è l'ultimo messaggio del bot nella chat. In tutti gli altri
 * casi vengono trattate come normale conversazione.
 */

export type Command =
  | { type: "approve"; id?: number; loose: boolean }
  | { type: "cancel"; id?: number; loose: boolean }
  | { type: "revert"; id: number; force: boolean }
  | { type: "retry"; id: number }
  | { type: "status"; id: number }
  | { type: "list" }
  | { type: "help" };

const REF = String.raw`(?:rif\.?\s*)?#?\s*(\d+)`;
const SI = String.raw`s[iì]`;

const APPROVE_WORDS = String.raw`ok|okay|approva|approvo|conferma|confermo|${SI}|vai|procedi`;
const APPROVE_LOOSE = [
  String.raw`ok(?:\s*,?\s*(?:vai|procedi|grazie))?`,
  "okay",
  "va bene",
  "vai(?: pure)?",
  "procedi(?: pure)?",
  "confermo",
  "conferma",
  "approvo",
  "d'accordo",
  "perfetto",
  String.raw`perfetto\s*,?\s*(?:vai|procedi)(?: pure)?`,
  SI,
  String.raw`${SI}\s*,?\s*(?:vai|procedi|grazie|confermo|ok|perfetto)(?: pure)?`,
  String.raw`${SI} certo`,
].join("|");

const CANCEL_LOOSE = [
  "annulla",
  "scarta",
  "lascia(?:mo)? (?:perdere|stare)",
  String.raw`no\s*,?\s*(?:lascia(?:mo)? (?:perdere|stare)|aspetta|fermo|annulla)`,
  "non (?:farlo|procedere|ancora)",
  "aspetta",
].join("|");

const PATTERNS: Array<[RegExp, (m: RegExpMatchArray) => Command]> = [
  [new RegExp(String.raw`^(?:${APPROVE_WORDS})\s+${REF}$`, "i"), (m) => ({ type: "approve", id: Number(m[1]), loose: false })],
  [new RegExp(String.raw`^(?:${APPROVE_LOOSE})$`, "i"), () => ({ type: "approve", loose: true })],
  [new RegExp(String.raw`^(?:annulla|scarta|no)\s+${REF}$`, "i"), (m) => ({ type: "cancel", id: Number(m[1]), loose: false })],
  [new RegExp(String.raw`^(?:${CANCEL_LOOSE})$`, "i"), () => ({ type: "cancel", loose: true })],
  [
    new RegExp(String.raw`^(?:ripristina|rollback|undo)\s+${REF}(\s+(?:forza|comunque|lo stesso))?$`, "i"),
    (m) => ({ type: "revert", id: Number(m[1]), force: Boolean(m[2]) }),
  ],
  [new RegExp(String.raw`^(?:riprova|rifai)\s+${REF}$`, "i"), (m) => ({ type: "retry", id: Number(m[1]) })],
  [new RegExp(String.raw`^(?:stato|commessa)\s+${REF}$`, "i"), (m) => ({ type: "status", id: Number(m[1]) })],
  [/^(?:commesse|lista commesse|elenco commesse)$/i, () => ({ type: "list" })],
  [/^(?:aiuto|help)$/i, () => ({ type: "help" })],
];

export function parseCommand(text: string): Command | undefined {
  const clean = text
    .trim()
    .replace(/[\s.!,👍✅🙏😊👌]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
  for (const [re, build] of PATTERNS) {
    const m = clean.match(re);
    if (m) return build(m);
  }
  return undefined;
}
