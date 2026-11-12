import type { AiUsage } from "./store.js";

/**
 * Prezzi dei modelli Claude in dollari per milione di token (listino API
 * Anthropic, verificato a ottobre 2026). Servono solo a stimare i costi nei
 * report: se un prezzo cambia basta aggiornare questa tabella.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};

type Tokens = Pick<AiUsage, "model" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">;

/** Costo stimato in dollari; undefined se il modello non è in tabella. */
export function costUsd(usage: Tokens): number | undefined {
  const price = PRICES[usage.model];
  if (!price) return undefined;
  const cost =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * price.cacheRead +
    usage.cacheWriteTokens * price.cacheWrite;
  return Math.round((cost / 1_000_000) * 1e6) / 1e6;
}

interface ApiUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Somma i consumi di una o più risposte dell'API in un unico riepilogo con il costo. */
export function sumUsage(model: string, purpose: string, responses: Array<{ usage?: ApiUsage | null }>): AiUsage {
  const total: AiUsage = {
    model,
    purpose,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  for (const r of responses) {
    total.calls++;
    total.inputTokens += r.usage?.input_tokens ?? 0;
    total.outputTokens += r.usage?.output_tokens ?? 0;
    total.cacheReadTokens += r.usage?.cache_read_input_tokens ?? 0;
    total.cacheWriteTokens += r.usage?.cache_creation_input_tokens ?? 0;
  }
  total.costUsd = costUsd(total);
  return total;
}
