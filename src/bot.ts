import { errorMessage, IMAGE_TYPES, type Attachment, type Interpreter } from "./ai.js";
import { parseCommand, type Command } from "./commands.js";
import { isSmallChange, type Operation } from "./operations.js";
import type { Prefilter } from "./prefilter.js";
import type { AiUsage, ChatMessage, Commessa, CommessaStatus, DataStore } from "./store.js";
import type { Transcriber } from "./transcribe.js";
import type { IncomingMessage } from "./whatsapp.js";
import {
  UndoConflictError,
  type AppliedOperation,
  type ChangePreview,
  type PublicCheck,
  type PublicCheckResult,
  type RecordUndo,
  type UndoOptions,
  type UndoStep,
} from "./wordpress.js";

export interface Messenger {
  /** Invia un messaggio e, se possibile, restituisce il suo ID. */
  sendText(chatId: string, chatType: "group" | "individual", text: string): Promise<string | undefined | void>;
  downloadMedia?(mediaId: string): Promise<{ data: Buffer; mimeType: string }>;
}

export interface SiteEditor {
  apply(op: Operation, record?: RecordUndo): Promise<AppliedOperation>;
  undo(step: UndoStep, opts?: UndoOptions): Promise<void>;
  verifyPublic?(check: PublicCheck): Promise<PublicCheckResult>;
  /** Descrive cosa cambierebbe un'operazione, senza applicarla. */
  preview?(op: Operation): Promise<ChangePreview>;
}

export interface BotOptions {
  allowedGroups: string[];
  allowedSenders: string[];
  approvers: string[];
  triggerPrefix: string;
  /** Dopo quante ore una proposta senza OK scade (default 24). */
  proposalTtlHours?: number;
  /** Fuso orario con cui scrivere le date nei messaggi (default Europe/Rome). */
  timezone?: string;
  /** Se presente, i vocali vengono trascritti e trattati come testo. */
  transcriber?: Transcriber;
  /** Foto e PDF mandati negli ultimi N minuti dalla stessa persona si considerano allegati alla richiesta. */
  mediaWindowMinutes?: number;
  /**
   * true = può approvare solo chi è elencato in `approvers` (piattaforma multi-cliente).
   * false = se l'elenco è vuoto può approvare chiunque nelle chat autorizzate.
   */
  strictApprovers?: boolean;
  /** false = le approvazioni si danno solo dalla dashboard, non da WhatsApp. */
  chatApproval?: boolean;
  /** Filtro economico: decide se un messaggio va fatto leggere al modello principale. */
  prefilter?: Prefilter;
  /** Tetto mensile di spesa AI in dollari: superato quello, il bot smette di analizzare i messaggi. */
  monthlyBudgetUsd?: number;
  /** Chiamata dopo l'invio di una nuova proposta (es. email ai responsabili). Gli errori finiscono nel log. */
  onProposal?: (c: Commessa) => Promise<void>;
  /** Avviso all'agenzia quando qualcosa va storto e serve un intervento. */
  onProblem?: (text: string) => void;
  /** Orologio, sostituibile nei test. */
  now?: () => Date;
}

/** Esito di un'azione chiesta dalla dashboard. */
export interface ActionResult {
  ok: boolean;
  message: string;
}

type Chat = Pick<IncomingMessage, "chatId" | "chatType">;

const MAX_ATTACHMENTS = 3;
const MAX_PDF_BYTES = 10 * 1024 * 1024;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Il cuore del bot: riceve i messaggi, riconosce i comandi, fa interpretare
 * le richieste all'AI, registra le commesse e le applica dopo l'approvazione.
 *
 * I testi sono scritti in tono colloquiale, come li scriverebbe un collega,
 * ma il bot non si spaccia per una persona: se glielo chiedono, lo dice.
 *
 * `handle` può essere richiamato più volte per lo stesso messaggio (la coda
 * riprova dopo un errore o un riavvio): ogni passo è scritto per non creare
 * doppioni.
 */
export class Bot {
  private schedulerBusy = false;

  constructor(
    private readonly store: DataStore,
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

    const history = (await this.store.recentMessages(msg.chatId)).filter((m) => m.messageId !== msg.id);

    let text = msg.text;
    const spoken = msg.media?.kind === "audio";
    if (spoken) {
      const heard = await this.listen(msg);
      if (heard === undefined) return;
      text = heard;
    }

    await this.store.addMessage(msg.chatId, {
      messageId: msg.id,
      from: msg.from,
      fromName: msg.fromName,
      text,
      bot: false,
      timestamp: msg.timestamp,
      media: msg.media,
    });

    const command = parseCommand(text);
    if (command) {
      const resolved = await this.resolveCommand(command, msg, history);
      if (resolved) {
        await this.handleCommand(resolved, msg);
        return;
      }
    }

    // Foto o PDF senza testo: restano in memoria e vengono allegati alla richiesta successiva.
    if (!text) return;

    if (this.opts.triggerPrefix) {
      const rest = stripPrefix(text, this.opts.triggerPrefix, spoken);
      if (!rest) return;
      text = rest;
    }

    await this.handleRequest(msg, text, history);
  }

  // ------------------------------------------------------------ vocali e allegati

  /** Trascrive un vocale. Restituisce undefined (dopo aver avvisato) se non è possibile. */
  private async listen(msg: IncomingMessage): Promise<string | undefined> {
    if (!this.opts.transcriber || !this.messenger.downloadMedia || !msg.media) {
      // Con un prefisso di attivazione il bot interviene solo su richiesta: niente avviso.
      if (!this.opts.triggerPrefix) await this.reply(msg, "I vocali non riesco ancora ad ascoltarli, me lo scrivete?");
      return undefined;
    }
    try {
      const { data, mimeType } = await this.messenger.downloadMedia(msg.media.id);
      const text = (await this.opts.transcriber.transcribe(data, mimeType)).trim();
      if (text) return text;
    } catch (err) {
      console.error("[bot] trascrizione del vocale non riuscita:", err);
    }
    if (!this.opts.triggerPrefix) await this.reply(msg, "Non sono riuscito a sentire bene il vocale, me lo scrivete?");
    return undefined;
  }

  /** Scarica foto e PDF mandati con la richiesta, o poco prima dalla stessa persona. */
  private async collectAttachments(
    msg: IncomingMessage,
  ): Promise<{ attachments: Attachment[]; notes: string[]; rowIds: number[] }> {
    const attachments: Attachment[] = [];
    const notes: string[] = [];
    const rowIds: number[] = [];
    if (!this.messenger.downloadMedia) return { attachments, notes, rowIds };

    const since = msg.timestamp - (this.opts.mediaWindowMinutes ?? 10) * 60;
    const recent = await this.store.recentMedia(msg.chatId, msg.from, since, MAX_ATTACHMENTS);
    for (const { rowId, media } of recent) {
      rowIds.push(rowId);
      const label = media.filename ?? (media.kind === "image" ? "foto" : "documento");
      try {
        const { data, mimeType } = await this.messenger.downloadMedia(media.id);
        if (media.kind === "image" && (IMAGE_TYPES as readonly string[]).includes(mimeType)) {
          if (data.length > MAX_IMAGE_BYTES) notes.push(`allegato non letto perché troppo grande: ${label}`);
          else attachments.push({ kind: "image", mediaType: mimeType, data });
        } else if (mimeType === "application/pdf") {
          if (data.length > MAX_PDF_BYTES) notes.push(`allegato non letto perché troppo grande: ${label}`);
          else attachments.push({ kind: "pdf", mediaType: mimeType, data, name: media.filename });
        } else {
          notes.push(`allegato in un formato che non so leggere: ${label}`);
        }
      } catch (err) {
        console.error("[bot] download dell'allegato non riuscito:", err);
        notes.push(`allegato che non sono riuscito a scaricare: ${label}`);
      }
    }
    return { attachments, notes, rowIds };
  }

  // ------------------------------------------------------------ richieste

  private async handleRequest(msg: IncomingMessage, text: string, history: ChatMessage[]): Promise<void> {
    // Messaggio già elaborato in un tentativo precedente: al massimo rimando la proposta.
    const existing = await this.store.findBySourceMessage(msg.id);
    if (existing) {
      if (!existing.proposalMessageId && existing.status === "in_attesa") await this.sendProposal(existing, msg);
      return;
    }

    if (await this.overBudget(msg.chatId)) return;

    const usages: AiUsage[] = [];
    const onUsage = (u: AiUsage) => usages.push(u);
    const { attachments, notes, rowIds } = await this.collectAttachments(msg);
    const pending = await this.pendingFor(msg.chatId);

    // Il filtro economico vale solo per i messaggi "sciolti": se ci sono allegati, proposte
    // in sospeso o l'ultimo a parlare è stato il bot, il messaggio va letto comunque.
    const loose = attachments.length === 0 && notes.length === 0 && pending.length === 0 && !history.at(-1)?.bot;
    if (this.opts.prefilter && loose) {
      const relevant = await this.opts.prefilter.relevant({ text, senderName: msg.fromName, history, onUsage });
      if (!relevant) {
        await this.saveUsage(msg.chatId, usages);
        return;
      }
    }

    let result;
    try {
      result = await this.interpreter.interpret({
        text,
        senderName: msg.fromName,
        history,
        attachments,
        attachmentNotes: notes,
        pending: pending.map((c) => ({ id: c.id, summary: c.summary, details: c.details })),
        now: this.now(),
        timezone: this.timezone,
        onUsage,
      });
    } catch (err) {
      console.error("[bot] errore AI:", err);
      await this.saveUsage(msg.chatId, usages);
      await this.reply(msg, "Scusate, in questo momento non riesco a guardarci. Me lo riscrivete tra un po'?");
      return;
    }

    if (result.kind !== "ignora" && rowIds.length) await this.store.markMediaUsed(rowIds);

    switch (result.kind) {
      case "ignora":
        await this.saveUsage(msg.chatId, usages);
        return;
      case "chiarimento":
        await this.saveUsage(msg.chatId, usages);
        await this.reply(msg, result.question ?? result.summary);
        return;
      case "risposta":
        await this.saveUsage(msg.chatId, usages);
        if (result.reply) await this.reply(msg, result.reply);
        return;
      case "commessa": {
        // Correzione di una proposta ancora in sospeso: la vecchia viene scartata.
        let corrected = false;
        if (result.replaces !== undefined) {
          const old = pending.find((c) => c.id === result.replaces);
          if (old) corrected = await this.store.transition(old.id, "in_attesa", "annullata");
        }
        const operations = result.operations ?? [];
        const commessa = await this.store.createCommessa({
          chatId: msg.chatId,
          chatType: msg.chatType,
          requesterId: msg.from,
          requesterName: msg.fromName,
          originalText: text,
          summary: result.summary,
          details: result.details ?? [],
          operations,
          preview: await this.previews(operations),
          small: isSmallChange(operations),
          sourceMessageId: msg.id,
          applyAt: toIso(result.scheduled_for),
          revertAt: toIso(result.revert_at),
        });
        await this.saveUsage(msg.chatId, usages, commessa.id);
        await this.sendProposal(commessa, msg, corrected);
        if (this.opts.onProposal) {
          await this.opts.onProposal(commessa).catch((err) => console.error("[bot] notifica della proposta non riuscita:", err));
        }
        return;
      }
    }
  }

  /** Anteprima prima/dopo delle operazioni; se non si riesce a calcolarla la commessa nasce lo stesso. */
  private async previews(operations: Operation[]): Promise<ChangePreview[]> {
    if (!this.site.preview) return [];
    const out: ChangePreview[] = [];
    for (const op of operations) {
      try {
        out.push(await this.site.preview(op));
      } catch (err) {
        console.warn("[bot] anteprima non calcolata:", errorMessage(err));
      }
    }
    return out;
  }

  private async saveUsage(chatId: string, usages: AiUsage[], commessaId?: number): Promise<void> {
    for (const u of usages) {
      try {
        await this.store.addUsage(chatId, u, commessaId);
      } catch (err) {
        console.error("[bot] impossibile registrare i consumi AI:", err);
      }
    }
  }

  /** true se la chat ha già speso questo mese più del tetto previsto. */
  private async overBudget(chatId: string): Promise<boolean> {
    const budget = this.opts.monthlyBudgetUsd;
    if (!budget || budget <= 0) return false;
    const now = this.now();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const spent = (await this.store.usageSince(chatId, monthStart)).costUsd;
    if (spent < budget) return false;
    console.warn(`[bot] tetto di spesa AI raggiunto per ${chatId}: ${spent.toFixed(2)} $ su ${budget} $. Messaggio non analizzato.`);
    return true;
  }

  private async sendProposal(c: Commessa, chat: Chat, corrected = false): Promise<void> {
    const id = await this.reply(chat, formatProposal(c, { corrected, timezone: this.timezone }));
    if (id) await this.store.update(c.id, { proposalMessageId: id });
  }

  // ------------------------------------------------------------ comandi

  /**
   * Decide se un comando va eseguito. Quelli con il numero valgono sempre.
   * Le conferme "naturali" senza numero ("sì vai", "lascia perdere") valgono se:
   *  - sono una risposta diretta al messaggio della proposta, oppure
   *  - l'ultimo messaggio del bot è la proposta di una commessa in attesa e
   *    chi scrive può decidere.
   * Altrimenti sono normale conversazione.
   */
  private async resolveCommand(cmd: Command, msg: IncomingMessage, history: ChatMessage[]): Promise<Command | undefined> {
    if ((cmd.type !== "approve" && cmd.type !== "cancel") || !cmd.loose) return cmd;

    if (msg.replyTo) {
      const target = await this.store.findByProposalMessage(msg.replyTo);
      const open: CommessaStatus[] = cmd.type === "approve" ? ["in_attesa"] : ["in_attesa", "programmata"];
      if (target && target.chatId === msg.chatId && open.includes(target.status)) {
        return { ...cmd, id: target.id, loose: false };
      }
    }

    const lastBot = [...history].reverse().find((m) => m.bot);
    if (!lastBot) return undefined;
    const pending = await this.pendingFor(msg.chatId);
    if (!pending.some((c) => lastBot.text.includes(refTag(c.id)))) return undefined;
    if (cmd.type === "approve") return this.isApprover(msg.from) ? cmd : undefined;
    return pending.some((c) => c.requesterId === msg.from) || this.isApprover(msg.from) ? cmd : undefined;
  }

  private async handleCommand(cmd: Command, msg: IncomingMessage): Promise<void> {
    switch (cmd.type) {
      case "help":
        await this.reply(msg, HELP_TEXT);
        return;
      case "list":
        await this.reply(msg, await this.formatList(msg.chatId));
        return;
      case "status": {
        const c = await this.findVisible(cmd.id, msg);
        await this.reply(msg, c ? formatStatus(c, this.timezone) : `Non trovo niente con rif. ${cmd.id}.`);
        return;
      }
      case "approve":
        return this.approve(cmd.id, msg);
      case "cancel":
        return this.cancel(cmd.id, msg);
      case "revert":
        return this.revert(cmd.id, msg, cmd.force);
      case "retry":
        return this.retry(cmd.id, msg);
    }
  }

  /** Rifà da capo l'analisi di una commessa non riuscita o scaduta, partendo dalla richiesta originale. */
  private async retry(id: number, msg: IncomingMessage): Promise<void> {
    const c = await this.findVisible(id, msg);
    if (!c) {
      await this.reply(msg, `Non trovo niente con rif. ${id}.`);
      return;
    }
    if (this.isExpired(c)) await this.store.transition(c.id, "in_attesa", "scaduta");
    else if (c.status !== "errore" && c.status !== "scaduta") {
      await this.reply(msg, `Quella (rif. ${id}) non ha bisogno di essere rifatta.`);
      return;
    }
    const history = (await this.store.recentMessages(msg.chatId)).filter((m) => m.messageId !== msg.id);
    await this.handleRequest(msg, c.originalText, history);
  }

  private async approve(id: number | undefined, msg: IncomingMessage): Promise<void> {
    if (!this.isApprover(msg.from)) {
      await this.reply(msg, "Per questa aspetto l'ok di un responsabile prima di procedere.");
      return;
    }
    if (this.opts.chatApproval === false) {
      await this.reply(msg, "Per questa serve l'ok dell'agenzia: lo danno dalla dashboard.");
      return;
    }
    const c = await this.resolveOpen(id, msg, ["in_attesa"]);
    if (typeof c === "string") {
      await this.reply(msg, c);
      return;
    }
    const problem = await this.startApproval(c, msg.from);
    if (problem) await this.reply(msg, problem);
  }

  /**
   * Fa partire una commessa in attesa: la applica subito oppure, se ha una
   * data futura, la mette in programma. Restituisce un messaggio solo se non
   * è stato possibile (qualcun altro l'ha già gestita).
   */
  private async startApproval(c: Commessa, approvedBy: string): Promise<string | undefined> {
    if (c.applyAt && Date.parse(c.applyAt) > this.now().getTime()) {
      if (!(await this.store.transition(c.id, "in_attesa", "programmata", { approvedBy }))) {
        return `Quella (rif. ${c.id}) è già stata gestita.`;
      }
      await this.notify(c, `Ok, la metto online ${formatWhen(c.applyAt, this.timezone)} ${refTag(c.id)}.`);
      return undefined;
    }
    // Passaggio atomico in_attesa → in_corso: un secondo "ok" non riapplica la commessa.
    if (!(await this.store.transition(c.id, "in_attesa", "in_corso", { approvedBy }))) {
      return `Quella (rif. ${c.id}) è già stata gestita.`;
    }
    await this.execute(c);
    return undefined;
  }

  /** Applica al sito una commessa già passata a "in_corso" e comunica l'esito. */
  private async execute(c: Commessa): Promise<void> {
    await this.store.update(c.id, { undo: [] });
    const applied: AppliedOperation[] = [];
    try {
      for (const op of c.operations) {
        // Il modo di annullare viene salvato subito: se il server si ferma a metà, al riavvio si rimedia.
        applied.push(await this.site.apply(op, (undo) => this.store.appendUndo(c.id, undo)));
      }
    } catch (err) {
      const reason = errorMessage(err);
      console.error(`[bot] errore applicando la commessa #${c.id}:`, err);
      const recorded = (await this.store.get(c.id))?.undo ?? [];
      const rollbackErrors = await this.undoAll(recorded, { force: true });
      await this.store.transition(c.id, "in_corso", "errore", { error: reason, undo: [] });
      let text = `Non sono riuscito a fare la modifica sul sito: ${reason}`;
      if (recorded.length) {
        text += rollbackErrors.length
          ? `\nAttenzione: una parte era già cambiata e non sono riuscito a rimetterla com'era (${rollbackErrors.join("; ")}), va controllata a mano.`
          : applied.length
            ? "\nHo rimesso com'era la parte che avevo già cambiato."
            : "";
      }
      this.problem(
        rollbackErrors.length
          ? `Commessa ${c.id} non riuscita e ripristino incompleto, il sito va controllato a mano: ${reason}; ${rollbackErrors.join("; ")}`
          : `Commessa ${c.id} non riuscita: ${reason}`,
      );
      // L'esito è già salvato: se la notifica fallisce, resta nei log.
      await this.notify(c, `${text} ${refTag(c.id)}`);
      return;
    }

    const checks = await this.verify(applied);
    const urls = [...new Set(applied.map((a) => a.url).filter(Boolean))];
    await this.store.transition(c.id, "in_corso", "completata", {
      resultUrls: urls,
      undo: applied.map((a) => a.undo),
    });
    const lines = [doneHeadline(c, applied, checks), ...urls];
    if (c.revertAt) lines.push(`Rimetto com'era ${formatWhen(c.revertAt, this.timezone)}.`);
    await this.notify(c, lines.join("\n"));
  }

  /** Controlla sulla pagina pubblica che le modifiche si vedano davvero. */
  private async verify(applied: AppliedOperation[]): Promise<PublicCheckResult[]> {
    const results: PublicCheckResult[] = [];
    if (!this.site.verifyPublic) return results;
    for (const a of applied) {
      if (!a.check) continue;
      try {
        results.push(await this.site.verifyPublic(a.check));
      } catch {
        results.push("non_verificabile");
      }
    }
    return results;
  }

  private async cancel(id: number | undefined, msg: IncomingMessage): Promise<void> {
    const c = await this.resolveOpen(id, msg, ["in_attesa", "programmata"]);
    if (typeof c === "string") {
      await this.reply(msg, c);
      return;
    }
    if (c.requesterId !== msg.from && !this.isApprover(msg.from)) {
      await this.reply(msg, "Questa la può annullare chi l'ha chiesta o un responsabile.");
      return;
    }
    if (!(await this.store.transition(c.id, c.status, "annullata"))) {
      await this.reply(msg, `Quella (rif. ${c.id}) è già stata gestita.`);
      return;
    }
    await this.notify(c, `Ok, lascio perdere ${refTag(c.id)}.`);
  }

  private async revert(id: number, msg: IncomingMessage, force: boolean): Promise<void> {
    if (!this.isApprover(msg.from)) {
      await this.reply(msg, "Per tornare indietro serve l'ok di un responsabile.");
      return;
    }
    const c = await this.findVisible(id, msg);
    if (!c) {
      await this.reply(msg, `Non trovo niente con rif. ${id}.`);
      return;
    }
    const result = await this.startRevert(c, force);
    // Gli esiti del ripristino vengono già scritti nel gruppo; qui restano solo i rifiuti immediati.
    if (!result.ok && !result.notified) await this.reply(msg, result.message);
  }

  /** Rimette il sito com'era per una commessa completata e scrive l'esito nel gruppo. */
  private async startRevert(c: Commessa, force: boolean): Promise<ActionResult & { notified?: boolean }> {
    const id = c.id;
    if (c.status !== "completata") {
      return { ok: false, message: `Quella (rif. ${id}) non è online per mano mia, non c'è niente da ripristinare.` };
    }
    if (!(await this.store.transition(id, "completata", "in_ripristino"))) {
      return { ok: false, message: `Ci sto già lavorando (rif. ${id}).` };
    }
    const result = await this.rollback(c, force);
    let message: string;
    if (result.conflicts.length) {
      message =
        `Non l'ho toccata: ${result.conflicts.join("; ")}. Se volete che rimetta comunque tutto com'era, ` +
        `perdendo quelle modifiche, scrivetemi "ripristina ${id} forza".`;
    } else if (result.errors.length) {
      message = `Non sono riuscito a rimettere com'era: ${result.errors.join("; ")} ${refTag(id)}`;
      this.problem(`Ripristino della commessa ${id} non riuscito: ${result.errors.join("; ")}`);
    } else {
      message = `Fatto, ho rimesso com'era prima ${refTag(id)}.`;
    }
    await this.notify(c, message);
    return { ok: !result.conflicts.length && !result.errors.length, message, notified: true };
  }

  // ------------------------------------------------------------ azioni dalla dashboard

  /** Approva una commessa per conto di un utente della dashboard. L'esito viene scritto anche nel gruppo. */
  async approveById(id: number, by: string): Promise<ActionResult> {
    const c = await this.ownedCommessa(id);
    if (!c) return { ok: false, message: `Commessa ${id} non trovata.` };
    if (this.isExpired(c)) {
      await this.store.transition(c.id, "in_attesa", "scaduta");
      return { ok: false, message: "La proposta è scaduta: va rifatta." };
    }
    if (c.status !== "in_attesa") return { ok: false, message: "La commessa è già stata gestita." };
    const problem = await this.startApproval(c, by);
    if (problem) return { ok: false, message: problem };
    const after = await this.store.get(id);
    return {
      ok: after?.status === "completata" || after?.status === "programmata",
      message: after?.status === "errore" ? (after.error ?? "Modifica non riuscita.") : `Stato: ${after?.status}`,
    };
  }

  /** Annulla una commessa in attesa o in programma per conto di un utente della dashboard. */
  async cancelById(id: number): Promise<ActionResult> {
    const c = await this.ownedCommessa(id);
    if (!c) return { ok: false, message: `Commessa ${id} non trovata.` };
    if (c.status !== "in_attesa" && c.status !== "programmata") {
      return { ok: false, message: "La commessa è già stata gestita." };
    }
    if (!(await this.store.transition(c.id, c.status, "annullata"))) {
      return { ok: false, message: "La commessa è già stata gestita." };
    }
    await this.notify(c, `Ok, lascio perdere ${refTag(c.id)}.`);
    return { ok: true, message: "Annullata." };
  }

  /** Rimette il sito com'era per conto di un utente della dashboard. */
  async revertById(id: number, force = false): Promise<ActionResult> {
    const c = await this.ownedCommessa(id);
    if (!c) return { ok: false, message: `Commessa ${id} non trovata.` };
    const { ok, message } = await this.startRevert(c, force);
    return { ok, message };
  }

  /** Rifà da capo una commessa non riuscita o scaduta e manda la nuova proposta nel gruppo. */
  async retryById(id: number): Promise<ActionResult> {
    const c = await this.ownedCommessa(id);
    if (!c) return { ok: false, message: `Commessa ${id} non trovata.` };
    if (this.isExpired(c)) await this.store.transition(c.id, "in_attesa", "scaduta");
    else if (c.status !== "errore" && c.status !== "scaduta") {
      return { ok: false, message: "Questa commessa non ha bisogno di essere rifatta." };
    }
    const msg: IncomingMessage = {
      id: `riprova-${c.id}-${this.now().getTime()}`,
      chatId: c.chatId,
      chatType: c.chatType,
      from: c.requesterId,
      fromName: c.requesterName,
      text: c.originalText,
      timestamp: Math.floor(this.now().getTime() / 1000),
    };
    await this.handleRequest(msg, c.originalText, await this.store.recentMessages(c.chatId));
    const created = await this.store.findBySourceMessage(msg.id);
    return created
      ? { ok: true, message: `Nuova proposta: rif. ${created.id}.` }
      : { ok: false, message: "Non ne è uscita una nuova proposta: guarda la conversazione nel gruppo." };
  }

  /** true se la commessa appartiene alle chat servite da questo bot. */
  owns(c: Pick<Commessa, "chatId" | "chatType">): boolean {
    if (c.chatType === "group") return this.opts.allowedGroups.includes(c.chatId);
    return this.opts.allowedSenders.includes(c.chatId) || this.opts.approvers.includes(c.chatId);
  }

  private async ownedCommessa(id: number): Promise<Commessa | undefined> {
    const c = await this.store.get(id);
    return c && this.owns(c) ? c : undefined;
  }

  /**
   * Rimette il sito com'era per una commessa in stato "in_ripristino".
   * Prima controlla tutti i passi senza scrivere: se la pagina è stata
   * modificata da altri nel frattempo non tocca nulla (a meno di `force`).
   */
  private async rollback(c: Commessa, force: boolean): Promise<{ conflicts: string[]; errors: string[] }> {
    const conflicts: string[] = [];
    const errors: string[] = [];
    if (!force) {
      for (const step of c.undo) {
        try {
          await this.site.undo(step, { dryRun: true });
        } catch (err) {
          (err instanceof UndoConflictError ? conflicts : errors).push(errorMessage(err));
        }
      }
    }
    if (!conflicts.length && !errors.length) errors.push(...(await this.undoAll(c.undo, { force })));

    if (conflicts.length || errors.length) {
      await this.store.transition(c.id, "in_ripristino", "completata");
    } else {
      await this.store.transition(c.id, "in_ripristino", "ripristinata", { revertAt: null });
    }
    return { conflicts, errors };
  }

  // ------------------------------------------------------------ scadenze e ripresa

  /**
   * Da chiamare periodicamente: applica le commesse programmate arrivate alla
   * loro data e rimette com'era il sito per quelle a tempo scadute.
   */
  async runDue(): Promise<void> {
    if (this.schedulerBusy) return;
    this.schedulerBusy = true;
    try {
      const nowIso = this.now().toISOString();
      for (const c of await this.store.dueToApply(nowIso)) {
        if (!this.owns(c)) continue;
        if (await this.store.transition(c.id, "programmata", "in_corso")) await this.execute(c);
      }
      for (const c of await this.store.dueToRevert(nowIso)) {
        if (!this.owns(c)) continue;
        if (!await this.store.transition(c.id, "completata", "in_ripristino")) continue;
        const result = await this.rollback(c, false);
        if (result.conflicts.length) {
          // Non riprovo all'infinito: tolgo la scadenza e lascio decidere alle persone.
          await this.store.update(c.id, { revertAt: null });
          await this.notify(
            c,
            `Oggi dovevo rimettere com'era la modifica ${refTag(c.id)}, ma non l'ho toccata: ${result.conflicts.join("; ")}. ` +
              `Se volete che lo faccia comunque scrivetemi "ripristina ${c.id} forza".`,
          );
        } else if (result.errors.length) {
          console.error(`[bot] ripristino programmato della commessa #${c.id} non riuscito:`, result.errors);
          this.problem(`Ripristino programmato della commessa ${c.id} non riuscito: ${result.errors.join("; ")}`);
        } else {
          await this.notify(c, `Come d'accordo ho rimesso com'era ${refTag(c.id)}.`);
        }
      }
    } finally {
      this.schedulerBusy = false;
    }
  }

  /**
   * Da chiamare all'avvio, prima di riprendere la coda: sistema le commesse
   * rimaste a metà per un riavvio. Le modifiche parziali vengono annullate e
   * la commessa torna in attesa (o programmata), così il messaggio di "ok"
   * rimasto in coda la riapplica da capo.
   */
  async recover(): Promise<void> {
    for (const c of await this.store.listByStatus(["in_corso"])) {
      if (!this.owns(c)) continue;
      const errors = await this.undoAll(c.undo, { force: true });
      if (errors.length) {
        console.error(`[bot] commessa #${c.id} interrotta e non ripristinata:`, errors);
        this.problem(`Commessa ${c.id} interrotta da un riavvio e non ripristinata, il sito va controllato: ${errors.join("; ")}`);
        await this.store.transition(c.id, "in_corso", "errore", { error: `Interrotta a metà: ${errors.join("; ")}` });
        await this.notify(
          c,
          `Mi sono interrotto mentre aggiornavo il sito e non sono riuscito a rimettere tutto com'era: ` +
            `controllate la pagina ${refTag(c.id)}.`,
        );
        continue;
      }
      // Se aveva una data ed era già approvata, la riprende lo scheduler al prossimo giro.
      const scheduled = Boolean(c.applyAt && c.approvedBy);
      await this.store.transition(c.id, "in_corso", scheduled ? "programmata" : "in_attesa", { undo: [] });
      console.warn(`[bot] commessa #${c.id} interrotta da un riavvio: rimessa ${scheduled ? "in programma" : "in attesa"}`);
    }
    for (const c of await this.store.listByStatus(["in_ripristino"])) {
      if (!this.owns(c)) continue;
      // I passi di ripristino si possono ripetere senza danni: basta riprovare.
      await this.store.transition(c.id, "in_ripristino", "completata");
      console.warn(`[bot] ripristino della commessa #${c.id} interrotto da un riavvio: si può riprovare`);
    }
  }

  // ------------------------------------------------------------ helper

  /** Annulla i passi in ordine inverso; restituisce gli errori incontrati. */
  private async undoAll(steps: UndoStep[], opts: UndoOptions = {}): Promise<string[]> {
    const errors: string[] = [];
    for (const step of [...steps].reverse()) {
      try {
        await this.site.undo(step, opts);
      } catch (err) {
        console.error("[bot] errore nel ripristino:", err);
        errors.push(errorMessage(err));
      }
    }
    return errors;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private get timezone(): string {
    return this.opts.timezone ?? "Europe/Rome";
  }

  private isExpired(c: Commessa): boolean {
    const ttlMs = (this.opts.proposalTtlHours ?? 24) * 3_600_000;
    return c.status === "in_attesa" && this.now().getTime() - Date.parse(c.createdAt) > ttlMs;
  }

  /** Proposte ancora valide in attesa di OK; quelle troppo vecchie vengono chiuse come scadute. */
  private async pendingFor(chatId: string): Promise<Commessa[]> {
    const out: Commessa[] = [];
    for (const c of await this.store.list(chatId, ["in_attesa"], 20)) {
      if (this.isExpired(c)) await this.store.transition(c.id, "in_attesa", "scaduta");
      else out.push(c);
    }
    return out;
  }

  private async resolveOpen(
    id: number | undefined,
    msg: IncomingMessage,
    statuses: CommessaStatus[],
  ): Promise<Commessa | string> {
    const expired = (ref: number) =>
      `Quella proposta (rif. ${ref}) è vecchia e nel frattempo il sito può essere cambiato: ` +
      `riscrivetemi la richiesta e la preparo di nuovo.`;
    if (id !== undefined) {
      const c = await this.findVisible(id, msg);
      if (!c) return `Non trovo niente con rif. ${id}.`;
      if (this.isExpired(c)) {
        await this.store.transition(c.id, "in_attesa", "scaduta");
        return expired(id);
      }
      if (c.status === "scaduta") return expired(id);
      if (!statuses.includes(c.status)) return `Quella (rif. ${id}) è già stata gestita.`;
      return c;
    }
    const pending = await this.pendingFor(msg.chatId);
    if (pending.length === 0) return "Non ho niente in sospeso al momento.";
    if (pending.length > 1) {
      const refs = pending.map((p) => p.id).reverse();
      return `Ne ho ${pending.length} in sospeso (rif. ${refs.join(", ")}), quale? Scrivetemi tipo "ok ${refs[0]}".`;
    }
    return pending[0];
  }

  /** Una commessa è visibile nella chat in cui è nata, oppure a un responsabile ovunque. */
  private async findVisible(id: number, msg: IncomingMessage): Promise<Commessa | undefined> {
    const c = await this.store.get(id);
    // Mai le commesse di un altro cliente, nemmeno conoscendone il numero.
    if (!c || !this.owns(c)) return undefined;
    if (c.chatId === msg.chatId || this.isApprover(msg.from)) return c;
    return undefined;
  }

  private async formatList(chatId: string): Promise<string> {
    const open = [
      ...(await this.pendingFor(chatId)),
      ...(await this.store.list(chatId, ["programmata", "in_corso"])),
    ].sort((a, b) => b.id - a.id);
    const recent = await this.store.list(chatId, ["completata", "errore", "ripristinata"], 5);
    if (!open.length && !recent.length) return "Per ora niente.";
    const label = (c: Commessa) =>
      c.status === "programmata" && c.applyAt
        ? `in programma ${formatWhen(c.applyAt, this.timezone)}`
        : STATUS_LABEL[c.status];
    const lines: string[] = [];
    if (open.length) {
      lines.push("In sospeso:", ...open.map((c) => `- rif. ${c.id}: ${c.summary} (${label(c)})`));
    }
    if (recent.length) {
      if (lines.length) lines.push("");
      lines.push("Ultime:", ...recent.map((c) => `- rif. ${c.id}: ${c.summary} (${label(c)})`));
    }
    return lines.join("\n");
  }

  private isAllowed(msg: IncomingMessage): boolean {
    if (msg.chatType === "group") return this.opts.allowedGroups.includes(msg.chatId);
    return this.opts.allowedSenders.includes(msg.from) || this.opts.approvers.includes(msg.from);
  }

  private isApprover(waId: string): boolean {
    if (this.opts.strictApprovers) return this.opts.approvers.includes(waId);
    // Senza APPROVERS configurati chiunque nelle chat autorizzate può approvare.
    return this.opts.approvers.length === 0 || this.opts.approvers.includes(waId);
  }

  private async reply(chat: Chat, text: string): Promise<string | undefined> {
    const id = (await this.messenger.sendText(chat.chatId, chat.chatType, text)) || undefined;
    await this.store.addMessage(chat.chatId, {
      messageId: id,
      from: "bot",
      text,
      bot: true,
      timestamp: Math.floor(Date.now() / 1000),
    });
    return id;
  }

  /** Come reply, ma non lancia eccezioni: usato per gli esiti, che sono già salvati nel database. */
  private async notify(c: Commessa, text: string): Promise<void> {
    try {
      await this.reply({ chatId: c.chatId, chatType: c.chatType }, text);
    } catch (err) {
      console.error(`[bot] impossibile notificare l'esito della commessa #${c.id}:`, err);
      this.problem(`Messaggio WhatsApp non consegnato per la commessa ${c.id}: ${errorMessage(err)}. Testo: «${text.slice(0, 200)}»`);
    }
  }

  private problem(text: string): void {
    try {
      this.opts.onProblem?.(text);
    } catch (err) {
      console.error("[bot] avviso non inviato:", err);
    }
  }
}

// ------------------------------------------------------------ testi

const STATUS_LABEL: Record<CommessaStatus, string> = {
  in_attesa: "aspetto l'ok",
  programmata: "in programma",
  in_corso: "ci sto lavorando",
  completata: "fatta",
  in_ripristino: "la sto rimettendo com'era",
  errore: "non riuscita",
  annullata: "annullata",
  ripristinata: "rimessa com'era",
  scaduta: "scaduta senza ok",
};

/** Il riferimento con cui il bot cita una commessa nei messaggi. */
export function refTag(id: number): string {
  return `(rif. ${id})`;
}

/** "il 1° dicembre alle 00:05", nel fuso indicato. */
export function formatWhen(iso: string, timeZone = "Europe/Rome"): string {
  const date = new Date(iso);
  const parts = new Intl.DateTimeFormat("it-IT", { timeZone, day: "numeric", month: "long" }).formatToParts(date);
  const day = Number(parts.find((p) => p.type === "day")?.value ?? "0");
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  const time = new Intl.DateTimeFormat("it-IT", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  const article = day === 8 || day === 11 ? "l'" : "il ";
  return `${article}${day}${day === 1 ? "°" : ""} ${month} alle ${time}`;
}

export function formatProposal(c: Commessa, opts: { corrected?: boolean; timezone?: string } = {}): string {
  let summary = c.summary.replace(/[.\s]+$/, "");
  if (opts.corrected) summary = `Corretto, ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
  const lines = c.details.length ? [`${summary}:`, ...c.details.map((d) => `- ${d}`)] : [`${summary}.`];
  if (c.applyAt) lines.push(`La metto online ${formatWhen(c.applyAt, opts.timezone)}.`);
  if (c.revertAt) lines.push(`Rimetto com'era ${formatWhen(c.revertAt, opts.timezone)}.`);
  lines.push(`${c.applyAt ? "Mi date l'ok?" : "Mi date l'ok e procedo?"} ${refTag(c.id)}`);
  return lines.join("\n");
}

/** Prima riga del messaggio di esito: dice "è online" solo se l'ho visto sulla pagina pubblica. */
function doneHeadline(c: Commessa, applied: AppliedOperation[], checks: PublicCheckResult[]): string {
  const ref = refTag(c.id);
  if (checks.includes("non_visibile")) {
    return (
      `Fatto, la modifica è salvata ${ref}, ma sul sito pubblico vedo ancora la versione di prima. ` +
      `Di solito è la cache: si aggiorna da sola in qualche minuto, altrimenti va svuotata.`
    );
  }
  const outcomes = new Set(applied.map((a) => a.outcome));
  if (outcomes.size === 1 && outcomes.has("bozza")) return `Fatto, è salvato in bozza ${ref}:`;
  if (outcomes.size === 1 && outcomes.has("offline")) return `Fatto, non è più online ${ref}:`;
  if (outcomes.has("online") && checks.length > 0 && checks.every((r) => r === "visibile")) {
    return `Fatto, è online ${ref}:`;
  }
  return `Fatto, modifica salvata ${ref}:`;
}

function formatStatus(c: Commessa, timeZone: string): string {
  const when = new Date(c.createdAt).toLocaleString("it-IT", { timeZone, dateStyle: "short", timeStyle: "short" });
  const lines = [
    `Rif. ${c.id} – ${STATUS_LABEL[c.status]}`,
    c.summary,
    ...c.details.map((d) => `- ${d}`),
    `Chiesta da ${c.requesterName ?? c.requesterId} il ${when}`,
  ];
  if (c.applyAt && (c.status === "in_attesa" || c.status === "programmata")) {
    lines.push(`Da mettere online ${formatWhen(c.applyAt, timeZone)}`);
  }
  if (c.revertAt && c.status !== "ripristinata") lines.push(`Da rimettere com'era ${formatWhen(c.revertAt, timeZone)}`);
  if (c.resultUrls.length) lines.push(...c.resultUrls);
  if (c.error) lines.push(`Problema: ${c.error}`);
  return lines.join("\n");
}

function toIso(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const t = Date.parse(value);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * Toglie il prefisso di attivazione (es. "#sito") dal testo. Nei vocali il
 * simbolo non si pronuncia, quindi basta la parola ("sito, cambiate…").
 * Restituisce undefined se il prefisso non c'è.
 */
function stripPrefix(text: string, prefix: string, spoken: boolean): string | undefined {
  const lower = text.toLowerCase();
  if (lower.startsWith(prefix.toLowerCase())) return text.slice(prefix.length).trim();
  if (spoken) {
    const word = prefix.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
    if (word && lower.startsWith(word) && !/[\p{L}\p{N}]/u.test(lower.charAt(word.length))) {
      return text.slice(word.length).replace(/^[\s,.:;-]+/, "").trim();
    }
  }
  return undefined;
}

const HELP_TEXT = `Scrivetemi qui le modifiche da fare al sito, anche a parole vostre (es. "Parigi di maggio ora costa 590", "togliete la crociera in Grecia che è sold out"). Vanno bene anche foto e PDF, e modifiche con una data ("dal 1° dicembre", "valida fino al 30"). Vi riscrivo cosa cambio e quando un responsabile dà l'ok la metto online.

Per dare l'ok basta rispondere al mio messaggio. Se vi serve:
- ok 12 → conferma
- annulla 12 → lascia perdere
- ripristina 12 → rimette com'era
- riprova 12 → la rifaccio da capo se non è riuscita
- stato 12 → a che punto è
- commesse → cosa c'è in sospeso

Sono un assistente automatico: le modifiche le faccio io, ma passano sempre dall'ok di un responsabile.`;
