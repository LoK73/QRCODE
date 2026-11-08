import type { Interpreter, InterpretInput } from "../src/ai.js";
import type { Messenger, SiteEditor } from "../src/bot.js";
import type { Interpretation, Operation } from "../src/operations.js";
import type { IncomingMessage } from "../src/whatsapp.js";
import type { AppliedOperation, UndoStep } from "../src/wordpress.js";

export const GROUP = "GROUP123";
export const BOSS = "393330000001";
export const STAFF = "393330000002";

let counter = 0;
export function groupMsg(text: string, from = STAFF): IncomingMessage {
  return {
    id: `wamid.${++counter}`,
    chatId: GROUP,
    chatType: "group",
    from,
    fromName: from === BOSS ? "Giulia" : "Marco",
    text,
    timestamp: Math.floor(Date.now() / 1000),
  };
}

export class FakeMessenger implements Messenger {
  sent: Array<{ chatId: string; text: string }> = [];
  async sendText(chatId: string, _type: "group" | "individual", text: string) {
    this.sent.push({ chatId, text });
  }
  get last(): string {
    return this.sent.at(-1)?.text ?? "";
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
  failOn?: number;
  async apply(op: Operation): Promise<AppliedOperation> {
    if (this.failOn === this.applied.length) throw new Error("WordPress non raggiungibile");
    this.applied.push(op);
    return {
      description: `applicata ${op.type}`,
      url: "https://agenzia.example/parigi",
      undo: { type: "trash_post", post_type: "post", id: this.applied.length },
    };
  }
  async undo(step: UndoStep): Promise<void> {
    this.undone.push(step);
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
