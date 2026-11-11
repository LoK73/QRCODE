import type { Interpreter, InterpretInput } from "../src/ai.js";
import type { Messenger, SiteEditor } from "../src/bot.js";
import type { Interpretation, Operation } from "../src/operations.js";
import type { Transcriber } from "../src/transcribe.js";
import type { IncomingMessage, MediaRef } from "../src/whatsapp.js";
import {
  UndoConflictError,
  type AppliedOperation,
  type PublicCheck,
  type PublicCheckResult,
  type RecordUndo,
  type UndoOptions,
  type UndoStep,
} from "../src/wordpress.js";

export const GROUP = "GROUP123";
export const BOSS = "393330000001";
export const STAFF = "393330000002";

let counter = 0;
export function groupMsg(text: string, from = STAFF, extra: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    id: `wamid.${++counter}`,
    chatId: GROUP,
    chatType: "group",
    from,
    fromName: from === BOSS ? "Giulia" : "Marco",
    text,
    timestamp: Math.floor(Date.now() / 1000),
    ...extra,
  };
}

export function mediaMsg(media: MediaRef, caption = "", from = STAFF): IncomingMessage {
  return groupMsg(caption, from, { media });
}

export class FakeMessenger implements Messenger {
  sent: Array<{ id: string; chatId: string; text: string }> = [];
  media = new Map<string, { data: Buffer; mimeType: string }>();
  failNext = 0;

  async sendText(chatId: string, _type: "group" | "individual", text: string): Promise<string> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error("WhatsApp non raggiungibile");
    }
    const id = `bot.${this.sent.length + 1}`;
    this.sent.push({ id, chatId, text });
    return id;
  }

  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    const m = this.media.get(mediaId);
    if (!m) throw new Error(`media ${mediaId} non trovato`);
    return m;
  }

  get last(): string {
    return this.sent.at(-1)?.text ?? "";
  }

  get lastId(): string {
    return this.sent.at(-1)?.id ?? "";
  }
}

export class FakeInterpreter implements Interpreter {
  calls: InterpretInput[] = [];
  constructor(public next: Interpretation | Error) {}
  async interpret(input: InterpretInput): Promise<Interpretation> {
    this.calls.push(input);
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}

export class FakeSite implements SiteEditor {
  applied: Operation[] = [];
  undone: UndoStep[] = [];
  checked: PublicCheck[] = [];
  /** Indice dell'operazione su cui fallire. */
  failOn?: number;
  /** Se true, il ripristino trova la pagina modificata da altri. */
  conflict = false;
  publicResult: PublicCheckResult = "visibile";
  outcome: AppliedOperation["outcome"] = "online";

  async apply(op: Operation, record?: RecordUndo): Promise<AppliedOperation> {
    if (this.failOn === this.applied.length) throw new Error("WordPress non raggiungibile");
    this.applied.push(op);
    const undo: UndoStep = { type: "trash_post", post_type: "post", id: this.applied.length };
    record?.(undo);
    return {
      description: `applicata ${op.type}`,
      url: "https://agenzia.example/parigi",
      undo,
      outcome: this.outcome,
      check: { url: "https://agenzia.example/parigi", present: ["590€"], absent: [] },
    };
  }

  async undo(step: UndoStep, opts: UndoOptions = {}): Promise<void> {
    if (this.conflict && !opts.force) throw new UndoConflictError('"Tour di Parigi" è stata modificata dopo la mia modifica (il testo)');
    if (opts.dryRun) return;
    this.undone.push(step);
  }

  async verifyPublic(check: PublicCheck): Promise<PublicCheckResult> {
    this.checked.push(check);
    return this.publicResult;
  }
}

export class FakeTranscriber implements Transcriber {
  calls = 0;
  constructor(public text: string | Error) {}
  async transcribe(): Promise<string> {
    this.calls++;
    if (this.text instanceof Error) throw this.text;
    return this.text;
  }
}

export const PRICE_CHANGE: Interpretation = {
  kind: "commessa",
  summary: "Cambio il prezzo del tour di Parigi di maggio",
  details: ["prezzo 650€ → 590€"],
  operations: [
    {
      type: "update_post",
      post_type: "page",
      id: 42,
      content_replacements: [{ find: "<strong>650€</strong>", replace: "<strong>590€</strong>" }],
    },
  ],
};
