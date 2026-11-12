import type { DataStore } from "./store.js";
import type { IncomingMessage } from "./whatsapp.js";

export interface QueueOptions {
  /** Tentativi massimi per messaggio prima di rinunciare. */
  maxAttempts?: number;
  /** Attesa prima di riprovare (moltiplicata per il numero del tentativo). */
  retryDelayMs?: number;
}

/**
 * Coda dei messaggi in arrivo.
 *
 * - Ogni messaggio viene salvato su disco prima di essere elaborato: dopo un
 *   riavvio `resume()` riprende quelli rimasti a metà.
 * - I messaggi della stessa chat vengono elaborati uno alla volta, in ordine;
 *   chat diverse procedono in parallelo.
 * - Se l'elaborazione fallisce si riprova qualche volta, poi si rinuncia.
 */
export class MessageQueue {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private timers = 0;

  constructor(
    private readonly store: DataStore,
    private readonly handler: (msg: IncomingMessage) => Promise<void>,
    opts: QueueOptions = {},
  ) {
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.retryDelayMs = opts.retryDelayMs ?? 5000;
  }

  /**
   * Accoda un messaggio: quando la promessa si risolve il messaggio è salvato
   * in modo durevole. Restituisce false se era già stato ricevuto.
   */
  async enqueue(msg: IncomingMessage): Promise<boolean> {
    if (!(await this.store.enqueue(msg))) return false;
    this.schedule(msg);
    return true;
  }

  /** Da chiamare all'avvio: rimette in coda i messaggi interrotti e riparte. */
  async resume(): Promise<number> {
    await this.store.resetInterruptedJobs();
    const jobs = await this.store.pendingJobs();
    for (const job of jobs) this.schedule(job.message);
    return jobs.length;
  }

  /** Si risolve quando non c'è più nulla in lavorazione (utile nei test e allo spegnimento). */
  async idle(): Promise<void> {
    while (this.chains.size > 0 || this.timers > 0) {
      await Promise.all([...this.chains.values()]);
      if (this.timers > 0) await new Promise((r) => setTimeout(r, 1));
    }
  }

  private schedule(msg: IncomingMessage): void {
    const previous = this.chains.get(msg.chatId) ?? Promise.resolve();
    const next = previous.then(() => this.run(msg));
    this.chains.set(msg.chatId, next);
    void next.finally(() => {
      if (this.chains.get(msg.chatId) === next) this.chains.delete(msg.chatId);
    });
  }

  private async run(msg: IncomingMessage): Promise<void> {
    const attempt = await this.store.claimJob(msg.id);
    if (attempt === 0) return;
    try {
      await this.handler(msg);
      await this.store.finishJob(msg.id, "done");
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempt >= this.maxAttempts) {
        console.error(`[coda] messaggio ${msg.id} abbandonato dopo ${attempt} tentativi:`, err);
        await this.store.finishJob(msg.id, "failed", reason);
        return;
      }
      console.warn(`[coda] messaggio ${msg.id}: tentativo ${attempt} fallito (${reason}), riprovo`);
      await this.store.finishJob(msg.id, "pending", reason);
      this.timers++;
      const timer = setTimeout(() => {
        this.timers--;
        this.schedule(msg);
      }, this.retryDelayMs * attempt);
      timer.unref?.();
    }
  }
}
