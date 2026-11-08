import { errorMessage, type Interpreter } from "./ai.js";
import { parseCommand, type Command } from "./commands.js";
import type { Operation } from "./operations.js";
import type { Commessa, Store } from "./store.js";
import type { AppliedOperation, UndoStep } from "./wordpress.js";
import type { IncomingMessage } from "./whatsapp.js";

export interface Messenger {
  sendText(chatId: string, chatType: "group" | "individual", text: string): Promise<void>;
}

export interface SiteEditor {
  apply(op: Operation): Promise<AppliedOperation>;
  undo(step: UndoStep): Promise<void>;
}

export interface BotOptions {
  allowedGroups: string[];
  allowedSenders: string[];
  approvers: string[];
  triggerPrefix: string;
}

type Chat = Pick<IncomingMessage, "chatId" | "chatType">;

/**
 * Il cuore del bot: riceve i messaggi, riconosce i comandi, fa interpretare
 * le richieste all'AI, registra le commesse e le applica dopo l'approvazione.
 */
export class Bot {
  constructor(
    private readonly store: Store,
    private readonly interpreter: Interpreter,
    private readonly site: SiteEditor,
    private readonly messenger: Messenger,
    private readonly opts: BotOptions,
  ) {}

  async handle(msg: IncomingMessage): Promise<void> {
    if (!this.isAllowed(msg)) {
      console.warn(
        `[bot] messaggio ignorato da ${msg.chatType === "group" ? `gruppo ${msg.chatId}` : msg.from} ` +
          `(non presente in ${msg.chatType === "group" ? "ALLOWED_GROUPS" : "ALLOWED_SENDERS/APPROVERS"})`,
      );
      return;
    }
    // Meta può ripetere la stessa notifica: ogni messaggio va elaborato una volta sola.
    if (!this.store.markProcessed(msg.id)) return;

    const history = this.store.recentMessages(msg.chatId);
    this.store.addMessage(msg.chatId, {
      from: msg.from,
      fromName: msg.fromName,
      text: msg.text,
      bot: false,
      timestamp: msg.timestamp,
    });

    const command = parseCommand(msg.text);
    if (command) {
      await this.handleCommand(command, msg);
      return;
    }

    let text = msg.text;
    if (this.opts.triggerPrefix) {
      if (!text.toLowerCase().startsWith(this.opts.triggerPrefix.toLowerCase())) return;
      text = text.slice(this.opts.triggerPrefix.length).trim();
      if (!text) return;
    }

    await this.handleRequest(msg, text, history);
  }

  // ------------------------------------------------------------ richieste

  private async handleRequest(msg: IncomingMessage, text: string, history: ReturnType<Store["recentMessages"]>) {
    let result;
    try {
      result = await this.interpreter.interpret({ text, senderName: msg.fromName, history });
    } catch (err) {
      console.error("[bot] errore AI:", err);
      await this.reply(msg, `⚠️ Non sono riuscito a elaborare la richiesta (${errorMessage(err)}). Riprova tra poco.`);
      return;
    }

    if (result.kind === "ignora") return;

    if (result.kind === "chiarimento") {
      await this.reply(msg, `❓ ${result.question ?? result.summary}`);
      return;
    }

    const commessa = this.store.createCommessa({
      chatId: msg.chatId,
      chatType: msg.chatType,
      requesterId: msg.from,
      requesterName: msg.fromName,
      originalText: text,
      summary: result.summary,
      details: result.details ?? [],
      operations: result.operations ?? [],
    });
    await this.reply(msg, formatProposal(commessa));
  }

  // ------------------------------------------------------------ comandi

  private async handleCommand(cmd: Command, msg: IncomingMessage): Promise<void> {
    switch (cmd.type) {
      case "help":
        return this.reply(msg, HELP_TEXT);
      case "list":
        return this.reply(msg, this.formatList(msg.chatId));
      case "status": {
        const c = this.findVisible(cmd.id, msg);
        return this.reply(msg, c ? formatStatus(c) : `Commessa #${cmd.id} non trovata.`);
      }
      case "approve":
        return this.approve(cmd.id, msg);
      case "cancel":
        return this.cancel(cmd.id, msg);
      case "revert":
        return this.revert(cmd.id, msg);
    }
  }

  private async approve(id: number | undefined, msg: IncomingMessage): Promise<void> {
    if (!this.isApprover(msg.from)) {
      return this.reply(msg, "⛔ Solo i responsabili autorizzati possono approvare le commesse.");
    }
    const c = this.resolvePending(id, msg);
    if (typeof c === "string") return this.reply(msg, c);

    // Passaggio atomico in_attesa → in_corso: un secondo "ok" non riapplica la commessa.
    if (!this.store.transition(c.id, "in_attesa", "in_corso", { approvedBy: msg.from })) {
      return this.reply(msg, `La commessa #${c.id} non è più in attesa (stato: ${this.store.get(c.id)?.status}).`);
    }
    await this.reply(msg, `⏳ Commessa #${c.id} approvata, aggiorno il sito…`);

    const applied: AppliedOperation[] = [];
    try {
      for (const op of c.operations) {
        applied.push(await this.site.apply(op));
      }
    } catch (err) {
      const reason = errorMessage(err);
      console.error(`[bot] errore applicando la commessa #${c.id}:`, err);
      const rollbackErrors = await this.undoAll(applied.map((a) => a.undo));
      this.store.transition(c.id, "in_corso", "errore", { error: reason });
      const note = applied.length
        ? rollbackErrors.length
          ? `\n⚠️ Ripristino parziale non riuscito: ${rollbackErrors.join("; ")}. Controlla il sito.`
          : "\nLe modifiche già fatte sono state ripristinate."
        : "";
      // L'errore va comunque in chat: se la notifica fallisce, resta nei log.
      await this.notify(c, `❌ Commessa #${c.id} non completata: ${reason}${note}`);
      return;
    }

    this.store.transition(c.id, "in_corso", "completata", {
      resultUrls: [...new Set(applied.map((a) => a.url).filter(Boolean))],
      undo: applied.map((a) => a.undo),
    });
    const lines = [
      `✅ Commessa #${c.id} completata`,
      ...applied.map((a) => `• ${a.description}${a.url ? `\n  ${a.url}` : ""}`),
      "",
      `Per tornare indietro: *ripristina ${c.id}*`,
    ];
    await this.notify(c, lines.join("\n"));
  }

  private async cancel(id: number | undefined, msg: IncomingMessage): Promise<void> {
    const c = this.resolvePending(id, msg);
    if (typeof c === "string") return this.reply(msg, c);
    if (c.requesterId !== msg.from && !this.isApprover(msg.from)) {
      return this.reply(msg, "⛔ Può annullare la commessa solo chi l'ha chiesta o un responsabile.");
    }
    if (!this.store.transition(c.id, "in_attesa", "annullata")) {
      return this.reply(msg, `La commessa #${c.id} non è più in attesa.`);
    }
    await this.notify(c, `🗑️ Commessa #${c.id} annullata.`);
  }

  private async revert(id: number, msg: IncomingMessage): Promise<void> {
    if (!this.isApprover(msg.from)) {
      return this.reply(msg, "⛔ Solo i responsabili autorizzati possono ripristinare le modifiche.");
    }
    const c = this.findVisible(id, msg);
    if (!c) return this.reply(msg, `Commessa #${id} non trovata.`);
    if (c.status !== "completata") {
      return this.reply(msg, `Si possono ripristinare solo commesse completate (la #${id} è "${c.status}").`);
    }
    if (!this.store.transition(c.id, "completata", "in_corso")) {
      return this.reply(msg, `La commessa #${id} è già in lavorazione.`);
    }
    const errors = await this.undoAll(c.undo);
    if (errors.length) {
      this.store.transition(c.id, "in_corso", "completata");
      await this.notify(c, `❌ Ripristino della commessa #${id} non riuscito: ${errors.join("; ")}`);
      return;
    }
    this.store.transition(c.id, "in_corso", "ripristinata");
    await this.notify(c, `↩️ Modifiche della commessa #${id} annullate: il sito è tornato com'era prima.`);
  }

  // ------------------------------------------------------------ helper

  /** Annulla i passi in ordine inverso; restituisce gli errori incontrati. */
  private async undoAll(steps: UndoStep[]): Promise<string[]> {
    const errors: string[] = [];
    for (const step of [...steps].reverse()) {
      try {
        await this.site.undo(step);
      } catch (err) {
        console.error("[bot] errore nel ripristino:", err);
        errors.push(errorMessage(err));
      }
    }
    return errors;
  }

  private resolvePending(id: number | undefined, msg: IncomingMessage): Commessa | string {
    if (id !== undefined) {
      const c = this.findVisible(id, msg);
      if (!c) return `Commessa #${id} non trovata.`;
      if (c.status !== "in_attesa") return `La commessa #${id} non è in attesa (stato: ${c.status}).`;
      return c;
    }
    const pending = this.store.list(msg.chatId, ["in_attesa"]);
    if (pending.length === 0) return "Non ci sono commesse in attesa.";
    if (pending.length > 1) {
      return `Ci sono ${pending.length} commesse in attesa (${pending.map((p) => `#${p.id}`).join(", ")}): indica il numero, es. *ok ${pending[0].id}*.`;
    }
    return pending[0];
  }

  /** Una commessa è visibile nella chat in cui è nata, oppure a un responsabile ovunque. */
  private findVisible(id: number, msg: IncomingMessage): Commessa | undefined {
    const c = this.store.get(id);
    if (!c) return undefined;
    if (c.chatId === msg.chatId || this.isApprover(msg.from)) return c;
    return undefined;
  }

  private formatList(chatId: string): string {
    const open = this.store.list(chatId, ["in_attesa", "in_corso"]);
    const recent = this.store.list(chatId, ["completata", "errore", "ripristinata"], 5);
    if (!open.length && !recent.length) return "Nessuna commessa per questa chat.";
    const lines: string[] = [];
    if (open.length) {
      lines.push("*Commesse aperte*", ...open.map((c) => `• #${c.id} ${STATUS_LABEL[c.status]} – ${c.summary}`));
    }
    if (recent.length) {
      if (lines.length) lines.push("");
      lines.push("*Ultime chiuse*", ...recent.map((c) => `• #${c.id} ${STATUS_LABEL[c.status]} – ${c.summary}`));
    }
    return lines.join("\n");
  }

  private isAllowed(msg: IncomingMessage): boolean {
    if (msg.chatType === "group") return this.opts.allowedGroups.includes(msg.chatId);
    return this.opts.allowedSenders.includes(msg.from) || this.opts.approvers.includes(msg.from);
  }

  private isApprover(waId: string): boolean {
    // Senza APPROVERS configurati chiunque nelle chat autorizzate può approvare.
    return this.opts.approvers.length === 0 || this.opts.approvers.includes(waId);
  }

  private async reply(chat: Chat, text: string): Promise<void> {
    await this.messenger.sendText(chat.chatId, chat.chatType, text);
    this.store.addMessage(chat.chatId, { from: "bot", text, bot: true, timestamp: Math.floor(Date.now() / 1000) });
  }

  /** Come reply, ma non lancia eccezioni: usato per gli esiti, che sono già salvati nel database. */
  private async notify(c: Commessa, text: string): Promise<void> {
    try {
      await this.reply({ chatId: c.chatId, chatType: c.chatType }, text);
    } catch (err) {
      console.error(`[bot] impossibile notificare l'esito della commessa #${c.id}:`, err);
    }
  }
}

// ------------------------------------------------------------ testi

const STATUS_LABEL: Record<Commessa["status"], string> = {
  in_attesa: "🕒 in attesa",
  in_corso: "⏳ in corso",
  completata: "✅ completata",
  errore: "❌ errore",
  annullata: "🗑️ annullata",
  ripristinata: "↩️ ripristinata",
};

export function formatProposal(c: Commessa): string {
  const lines = [`📋 *Commessa #${c.id}*`, c.summary];
  if (c.details.length) lines.push("", ...c.details.map((d) => `• ${d}`));
  lines.push("", `Per applicarla: *ok ${c.id}*`, `Per scartarla: *annulla ${c.id}*`);
  return lines.join("\n");
}

function formatStatus(c: Commessa): string {
  const lines = [
    `📋 *Commessa #${c.id}* – ${STATUS_LABEL[c.status]}`,
    c.summary,
    ...c.details.map((d) => `• ${d}`),
    `Richiesta da: ${c.requesterName ?? c.requesterId} il ${new Date(c.createdAt).toLocaleString("it-IT", { timeZone: "Europe/Rome" })}`,
  ];
  if (c.approvedBy) lines.push(`Approvata da: ${c.approvedBy}`);
  if (c.resultUrls.length) lines.push(...c.resultUrls);
  if (c.error) lines.push(`Errore: ${c.error}`);
  return lines.join("\n");
}

const HELP_TEXT = `🤖 *Come funziono*
Scrivete nel gruppo cosa va cambiato sul sito, ad esempio:
• "Il tour di Parigi di maggio ora costa 590€"
• "Togliete la crociera in Grecia, è sold out"
• "Nuova offerta: weekend a Vienna, 3 notti da 349€"

Preparo una commessa con il riepilogo; quando un responsabile risponde *ok <numero>*, la applico al sito.

*Comandi*
• ok 12 – approva e applica la commessa 12
• annulla 12 – scarta la commessa 12
• ripristina 12 – annulla sul sito le modifiche della 12
• stato 12 – dettagli della commessa
• commesse – elenco delle commesse`;
