import { z } from "zod";

/**
 * Le operazioni che il bot può eseguire sul sito. Sono volutamente poche e
 * precise: niente cancellazioni definitive, niente modifiche a utenti/plugin.
 * L'AI propone una o più operazioni, una persona le approva, il bot le applica.
 */

const AcfField = z.object({
  field: z.string().describe("Nome del campo ACF, es. 'prezzo' o 'data_partenza'"),
  value: z.string().describe("Nuovo valore del campo, come testo"),
});

const TextReplacement = z.object({
  find: z
    .string()
    .min(1)
    .describe("Testo esatto da cercare nel contenuto attuale (copiato da get_content)"),
  replace: z.string().describe("Testo con cui sostituirlo"),
});

export const UpdatePostOp = z.object({
  type: z.literal("update_post"),
  post_type: z.string().describe("Slug del tipo di contenuto, es. 'post', 'page', 'viaggio'"),
  id: z.number().int().describe("ID del contenuto WordPress"),
  title: z.string().optional().describe("Nuovo titolo"),
  excerpt: z.string().optional().describe("Nuovo riassunto"),
  status: z.enum(["publish", "draft", "private"]).optional().describe("Nuovo stato di pubblicazione"),
  content_replacements: z
    .array(TextReplacement)
    .optional()
    .describe("Sostituzioni puntuali nel contenuto (preferibili alla riscrittura completa)"),
  content: z
    .string()
    .optional()
    .describe("Contenuto completo nuovo: usalo solo se le sostituzioni non bastano"),
  acf: z.array(AcfField).optional().describe("Campi personalizzati ACF da aggiornare"),
});

export const CreatePostOp = z.object({
  type: z.literal("create_post"),
  post_type: z.string().describe("Slug del tipo di contenuto da creare"),
  title: z.string().min(1),
  content: z.string().describe("Contenuto (HTML o blocchi Gutenberg)"),
  excerpt: z.string().optional(),
  status: z
    .enum(["draft", "publish"])
    .describe("Usa 'draft' salvo richiesta esplicita di pubblicare subito"),
  acf: z.array(AcfField).optional(),
});

export const UpdateProductPriceOp = z.object({
  type: z.literal("update_product_price"),
  product_id: z.number().int().describe("ID del prodotto WooCommerce"),
  regular_price: z.string().optional().describe("Prezzo pieno, es. '590' o '590.00'"),
  sale_price: z
    .string()
    .optional()
    .describe("Prezzo in offerta; stringa vuota per rimuovere l'offerta"),
});

export const Operation = z.discriminatedUnion("type", [
  UpdatePostOp,
  CreatePostOp,
  UpdateProductPriceOp,
]);

export type Operation = z.infer<typeof Operation>;
export type UpdatePostOp = z.infer<typeof UpdatePostOp>;
export type CreatePostOp = z.infer<typeof CreatePostOp>;
export type UpdateProductPriceOp = z.infer<typeof UpdateProductPriceOp>;

/** Risultato dell'interpretazione di un messaggio da parte dell'AI. */
export const Interpretation = z.object({
  kind: z
    .enum(["commessa", "chiarimento", "risposta", "ignora"])
    .describe(
      "'commessa' = richiesta di modifica al sito pronta da proporre; " +
        "'chiarimento' = è una richiesta ma serve una domanda per completarla; " +
        "'risposta' = messaggio rivolto a te che merita una breve risposta ma non è una modifica al sito; " +
        "'ignora' = conversazione tra colleghi che non ti riguarda",
    ),
  summary: z
    .string()
    .describe(
      "Per 'commessa': cosa farai, in prima persona e al presente, come lo scriverebbe un collega " +
        "(es. 'Cambio il prezzo del tour di Parigi di maggio'). Per gli altri casi: nota interna breve.",
    ),
  question: z
    .string()
    .optional()
    .describe("Per 'chiarimento': la domanda da fare nel gruppo, breve e colloquiale"),
  reply: z.string().optional().describe("Per 'risposta': il testo da scrivere nel gruppo, breve e colloquiale"),
  operations: z
    .array(Operation)
    .optional()
    .describe("Per 'commessa': le operazioni da eseguire, nell'ordine"),
  details: z
    .array(z.string())
    .optional()
    .describe("Per 'commessa': i cambiamenti in forma 'prima → dopo', brevi (es. 'prezzo 650€ → 590€')"),
  replaces: z
    .number()
    .int()
    .optional()
    .describe(
      "Per 'commessa': il rif. di una proposta ancora in sospeso che questa corregge e sostituisce " +
        "(es. lo staff risponde 'no, 580 non 590')",
    ),
  scheduled_for: z
    .string()
    .optional()
    .describe(
      "Per 'commessa' da applicare in futuro ('dal 1° dicembre…'): data e ora ISO 8601 con fuso, " +
        "es. 2026-12-01T00:05:00+01:00. Ometti se va applicata subito.",
    ),
  revert_at: z
    .string()
    .optional()
    .describe(
      "Per 'commessa' a tempo ('offerta valida fino al 30'): data e ora ISO 8601 con fuso in cui " +
        "rimettere il sito com'era, es. 2026-11-30T23:59:00+01:00",
    ),
});

export type Interpretation = z.infer<typeof Interpretation>;

/**
 * Una modifica è "piccola" se tocca un solo contenuto con poche sostituzioni
 * puntuali o un prezzo. Le modifiche piccole si possono approvare a colpo
 * d'occhio dall'elenco; per le altre conviene aprire il dettaglio.
 */
export function isSmallChange(operations: Operation[]): boolean {
  if (operations.length !== 1) return false;
  const op = operations[0];
  if (op.type === "update_product_price") return true;
  if (op.type !== "update_post") return false;
  if (op.content !== undefined || op.status !== undefined || op.title !== undefined) return false;
  const replacements = op.content_replacements ?? [];
  const longest = Math.max(0, ...replacements.map((r) => Math.max(r.find.length, r.replace.length)));
  return replacements.length + (op.acf?.length ?? 0) <= 3 && longest <= 200;
}
