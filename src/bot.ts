import { errorMessage, type Interpreter } from "./ai.js";
import { parseCommand, type Command } from "./commands.js";
import type { Operation } from "./operations.js";
import type { ChatMessage, Commessa, Store } from "./store.js";
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
 *
 * I testi sono scritti in tono colloquiale, come li scriverebbe un collega,
 * ma il bot non si spaccia per una persona: se glielo chiedono, lo dice.
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
    if (command && this.acceptCommand(command, msg, history)) {
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

  /**
   * Le conferme "naturali" senza numero ("sì vai", "procedi", "lascia perdere")
   * valgono solo se l'ultimo messaggio del bot è la proposta di una commessa
   * ancora in attesa e chi scrive può decidere. Altrimenti sono conversazione.
   */
  private acceptCommand(cmd: Command, msg: IncomingMessage, history: ChatMessage[]): boolean {
    if (!("loose" in cmd) || !cmd.loose) return true;
    const lastBot = [...history].reverse().find((m) => m.bot);
    if (!lastBot) return false;
    const pending = this.store.list(msg.chatId, ["in_attesa"]);
    const proposed = pending.find((c) => lastBot.text.includes(refTag(c.id)));
    if (!proposed) return false;
    if (cmd.type === "approve") return this.isApprover(msg.from);
    return pending.some((c) => c.requesterId === msg.from) || this.isApprover(msg.from);
  }

  // ------------------------------------------------------------ richieste

  private async handleRequest(msg: IncomingMessage, text: string, history: ChatMessage[]) {
    let result;
    try {
      result = await this.interpreter.interpret({ text, senderName: msg.fromName, history });
    } catch (err) {
      console.error("[bot] errore AI:", err);
      await this.reply(msg, "Scusate, in questo momento non riesco a guardarci. Me lo riscrivete tra un po'?");
      return;
    }

    switch (result.kind) {
      case "ignora":
        return;
      case "chiarimento":
        return this.reply(msg, result.question ?? result.summary);
      case "risposta":
        if (result.reply) await this.reply(msg, result.reply);
        return;
      case "commessa": {
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
        return this.reply(msg, formatProposal(commessa));
      }
    }
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
        return this.reply(msg, c ? formatStatus(c) : `Non trovo niente con rif. ${cmd.id}.`);
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
      return this.reply(msg, "Per questa aspetto l'ok di un responsabile prima di procedere.");
    }
    const c = this.resolvePending(id, msg);
    if (typeof c === "string") return this.reply(msg, c);

    // Passaggio atomico in_attesa → in_corso: un secondo "ok" non riapplica la commessa.
    if (!this.store.transition(c.id, "in_attesa", "in_corso", { approvedBy: msg.from })) {
      return this.reply(msg, `Quella (rif. ${c.id}) è già stata gestita.`);
    }

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
      let text = `Non sono riuscito a fare la modifica sul sito: ${reason}`;
      if (applied.length) {
        text += rollbackErrors.length
          ? `\nAttenzione: una parte era già cambiata e non sono riuscito a rimetterla com'era (${rollbackErrors.join("; ")}), va controllata a mano.`
          : "\nHo rimesso com'era la parte che avevo già cambiato.";
      }
      // L'esito è già salvato: se la notifica fallisce, resta nei log.
      await this.notify(c, `${text} (rif. ${c.id})`);
      return;
    }

    const urls = [...new Set(applied.map((a) => a.url).filter(Boolean))];
    this.store.transition(c.id, "in_corso", "completata", {
      resultUrls: urls,
      undo: applied.map((a) => a.undo),
    });
    const lines = [urls.length ? `Fatto, è online (rif. ${c.id}):` : `Fatto (rif. ${c.id}).`, ...urls];
    await this.notify(c, lines.join("\n"));
  }

  private async cancel(id: number | undefined, msg: IncomingMessage): Promise<void> {
    const c = this.resolvePending(id, msg);
    if (typeof c === "string") return this.reply(msg, c);
    if (c.requesterId !== msg.from && !this.isApprover(msg.from)) {
      return this.reply(msg, "Questa la può annullare chi l'ha chiesta o un responsabile.");
    }
    if (!this.store.transition(c.id, "in_attesa", "annullata")) {
      return this.reply(msg, `Quella (rif. ${c.id}) è già stata gestita.`);
    }
    await this.notify(c, `Ok, lascio perdere (rif. ${c.id}).`);
  }

  private async revert(id: number, msg: IncomingMessage): Promise<void> {
    if (!this.isApprover(msg.from)) {
      return this.reply(msg, "Per tornare indietro serve l'ok di un responsabile.");
    }
    const c = this.findVisible(id, msg);
    if (!c) return this.reply(msg, `Non trovo niente con rif. ${id}.`);
    if (c.status !== "completata") {
      return this.reply(msg, `Quella (rif. ${id}) non era stata messa online, non c'è niente da ripristinare.`);
    }
    if (!this.store.transition(c.id, "completata", "in_corso")) {
      return this.reply(msg, `Ci sto già lavorando (rif. ${id}).`);
    }
    const errors = await this.undoAll(c.undo);
    if (errors.length) {
      this.store.transition(c.id, "in_corso", "completata");
      await this.notify(c, `Non sono riuscito a rimettere com'era: ${errors.join("; ")} (rif. ${id})`);
      return;
    }
    this.store.transition(c.id, "in_corso", "ripristinata");
    await this.notify(c, `Fatto, ho rimesso com'era prima (rif. ${id}).`);
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
      if (!c) return `Non trovo niente con rif. ${id}.`;
      if (c.status !== "in_attesa") return `Quella (rif. ${id}) è già stata gestita.`;
      return c;
    }
    const pending = this.store.list(msg.chatId, ["in_attesa"]);
    if (pending.length === 0) return "Non ho niente in sospeso al momento.";
    if (pending.length > 1) {
      const refs = pending.map((p) => p.id).reverse();
      return `Ne ho ${pending.length} in sospeso (rif. ${refs.join(", ")}), quale? Scrivetemi tipo "ok ${refs[0]}".`;
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
    if (!open.length && !recent.length) return "Per ora niente.";
    const lines: string[] = [];
    if (open.length) {
      lines.push("In sospeso:", ...open.map((c) => `- rif. ${c.id}: ${c.summary} (${STATUS_LABEL[c.status]})`));
    }
    if (recent.length) {
      if (lines.length) lines.push("");
      lines.push("Ultime:", ...recent.map((c) => `- rif. ${c.id}: ${c.summary} (${STATUS_LABEL[c.status]})`));
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
  in_attesa: "aspetto l'ok",
  in_corso: "ci sto lavorando",
  completata: "fatta",
  errore: "non riuscita",
  annullata: "annullata",
  ripristinata: "rimessa com'era",
};

/** Il riferimento con cui il bot cita una commessa nei messaggi. */
export function refTag(id: number): string {
  return `(rif. ${id})`;
}

export function formatProposal(c: Commessa): string {
  const summary = c.summary.replace(/[.\s]+$/, "");
  const lines = c.details.length ? [`${summary}:`, ...c.details.map((d) => `- ${d}`)] : [`${summary}.`];
  lines.push(`Mi date l'ok e procedo? ${refTag(c.id)}`);
  return lines.join("\n");
}

function formatStatus(c: Commessa): string {
  const when = new Date(c.createdAt).toLocaleString("it-IT", {
    timeZone: "Europe/Rome",
    dateStyle: "short",
    timeStyle: "short",
  });
  const lines = [
    `Rif. ${c.id} – ${STATUS_LABEL[c.status]}`,
    c.summary,
    ...c.details.map((d) => `- ${d}`),
    `Chiesta da ${c.requesterName ?? c.requesterId} il ${when}`,
  ];
  if (c.resultUrls.length) lines.push(...c.resultUrls);
  if (c.error) lines.push(`Problema: ${c.error}`);
  return lines.join("\n");
}

const HELP_TEXT = `Scrivetemi qui le modifiche da fare al sito, anche a parole vostre (es. "Parigi di maggio ora costa 590", "togliete la crociera in Grecia che è sold out"). Vi riscrivo cosa cambio e quando un responsabile dà l'ok la metto online.

Se vi serve:
- ok 12 → conferma
- annulla 12 → lascia perdere
- ripristina 12 → rimette com'era
- stato 12 → a che punto è
- commesse → cosa c'è in sospeso

Sono un assistente automatico: le modifiche le faccio io, ma passano sempre dall'ok di un responsabile.`;
