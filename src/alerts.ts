/**
 * Avvisi per l'agenzia quando qualcosa va storto (modifica non riuscita,
 * ripristino a metà, messaggio WhatsApp non consegnato, richiesta abbandonata).
 *
 * Gli avvisi vengono mandati a un "webhook in entrata" di Slack, Google Chat o
 * Microsoft Teams (ALERT_WEBHOOK_URL): tutti accettano un JSON con il campo
 * "text". Lo stesso avviso non viene ripetuto più di una volta ogni 10 minuti.
 */

export interface Alerter {
  alert(text: string): void;
}

export interface WebhookAlerterOptions {
  url: string;
  /** Prefisso per distinguere gli ambienti, es. "[produzione]". */
  prefix?: string;
  /** Millisecondi entro cui un avviso identico non viene ripetuto (default 10 minuti). */
  dedupeMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

export class WebhookAlerter implements Alerter {
  private readonly recent = new Map<string, number>();
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: WebhookAlerterOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** Non aspetta e non lancia eccezioni: un avviso non riuscito finisce solo nel log. */
  alert(text: string): void {
    const now = this.opts.now?.() ?? Date.now();
    const window = this.opts.dedupeMs ?? 600_000;
    for (const [key, at] of this.recent) if (now - at > window) this.recent.delete(key);
    if (this.recent.has(text)) return;
    this.recent.set(text, now);

    const body = JSON.stringify({ text: this.opts.prefix ? `${this.opts.prefix} ${text}` : text });
    void this.fetchFn(this.opts.url, { method: "POST", headers: { "Content-Type": "application/json" }, body })
      .then((res) => {
        if (!res.ok) console.error(`[avvisi] il webhook ha risposto ${res.status}`);
      })
      .catch((err) => console.error("[avvisi] invio non riuscito:", err instanceof Error ? err.message : err));
  }
}

/** Avvisi solo nel log, quando il webhook non è configurato. */
export const logAlerter: Alerter = {
  alert: (text) => console.error(`[avviso] ${text}`),
};
