import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Operation } from "./operations.js";
import type { UndoStep } from "./wordpress.js";

export type CommessaStatus =
  | "in_attesa" // proposta, aspetta l'OK
  | "in_corso" // approvata, la sto applicando
  | "completata"
  | "errore"
  | "annullata"
  | "ripristinata";

export interface Commessa {
  id: number;
  chatId: string;
  chatType: "group" | "individual";
  requesterId: string;
  requesterName?: string;
  originalText: string;
  summary: string;
  details: string[];
  operations: Operation[];
  status: CommessaStatus;
  approvedBy?: string;
  resultUrls: string[];
  undo: UndoStep[];
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  from: string;
  fromName?: string;
  text: string;
  /** true se il messaggio l'ha scritto il bot */
  bot: boolean;
  timestamp: number;
}

/** Archivio delle commesse su SQLite (node:sqlite, nessuna dipendenza esterna). */
export class Store {
  private readonly db: DatabaseSync;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS commesse (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        requester_id TEXT NOT NULL,
        requester_name TEXT,
        original_text TEXT NOT NULL,
        summary TEXT NOT NULL,
        details TEXT NOT NULL DEFAULT '[]',
        operations TEXT NOT NULL,
        status TEXT NOT NULL,
        approved_by TEXT,
        result_urls TEXT NOT NULL DEFAULT '[]',
        undo TEXT NOT NULL DEFAULT '[]',
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS commesse_chat_status ON commesse(chat_id, status);
      CREATE TABLE IF NOT EXISTS messaggi (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_name TEXT,
        text TEXT NOT NULL,
        bot INTEGER NOT NULL DEFAULT 0,
        ts INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messaggi_chat ON messaggi(chat_id, id);
      CREATE TABLE IF NOT EXISTS processed (
        message_id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL
      );
    `);
  }

  /** Segna un messaggio come elaborato. Restituisce false se lo era già (webhook ripetuto). */
  markProcessed(messageId: string): boolean {
    const r = this.db
      .prepare("INSERT OR IGNORE INTO processed (message_id, ts) VALUES (?, ?)")
      .run(messageId, Date.now());
    return Number(r.changes) > 0;
  }

  addMessage(chatId: string, msg: ChatMessage): void {
    this.db
      .prepare("INSERT INTO messaggi (chat_id, sender, sender_name, text, bot, ts) VALUES (?, ?, ?, ?, ?, ?)")
      .run(chatId, msg.from, msg.fromName ?? null, msg.text, msg.bot ? 1 : 0, msg.timestamp);
  }

  /** Ultimi messaggi della chat, dal più vecchio al più recente. */
  recentMessages(chatId: string, limit = 12): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messaggi WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
      .all(chatId, limit) as Array<Record<string, unknown>>;
    return rows.reverse().map((r) => ({
      from: String(r.sender),
      fromName: (r.sender_name as string | null) ?? undefined,
      text: String(r.text),
      bot: r.bot === 1,
      timestamp: Number(r.ts),
    }));
  }

  createCommessa(
    c: Pick<
      Commessa,
      "chatId" | "chatType" | "requesterId" | "requesterName" | "originalText" | "summary" | "details" | "operations"
    >,
  ): Commessa {
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO commesse (chat_id, chat_type, requester_id, requester_name, original_text, summary, details,
           operations, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_attesa', ?, ?)`,
      )
      .run(
        c.chatId,
        c.chatType,
        c.requesterId,
        c.requesterName ?? null,
        c.originalText,
        c.summary,
        JSON.stringify(c.details),
        JSON.stringify(c.operations),
        now,
        now,
      );
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): Commessa | undefined {
    const row = this.db.prepare("SELECT * FROM commesse WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    return row ? toCommessa(row) : undefined;
  }

  list(chatId: string, statuses: CommessaStatus[], limit = 10): Commessa[] {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM commesse WHERE chat_id = ? AND status IN (${placeholders}) ORDER BY id DESC LIMIT ?`)
      .all(chatId, ...statuses, limit) as Array<Record<string, unknown>>;
    return rows.map(toCommessa);
  }

  /**
   * Cambia stato solo se la commessa è ancora nello stato atteso: evita che due
   * "ok" quasi simultanei applichino due volte la stessa modifica.
   */
  transition(id: number, from: CommessaStatus, to: CommessaStatus, extra: Partial<Commessa> = {}): boolean {
    const sets = ["status = ?", "updated_at = ?"];
    const values: Array<string | null> = [to, new Date().toISOString()];
    if (extra.approvedBy !== undefined) {
      sets.push("approved_by = ?");
      values.push(extra.approvedBy);
    }
    if (extra.resultUrls !== undefined) {
      sets.push("result_urls = ?");
      values.push(JSON.stringify(extra.resultUrls));
    }
    if (extra.undo !== undefined) {
      sets.push("undo = ?");
      values.push(JSON.stringify(extra.undo));
    }
    if (extra.error !== undefined) {
      sets.push("error = ?");
      values.push(extra.error);
    }
    const r = this.db
      .prepare(`UPDATE commesse SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
      .run(...values, id, from);
    return Number(r.changes) > 0;
  }

  close(): void {
    this.db.close();
  }
}

function toCommessa(r: Record<string, unknown>): Commessa {
  return {
    id: Number(r.id),
    chatId: String(r.chat_id),
    chatType: r.chat_type as Commessa["chatType"],
    requesterId: String(r.requester_id),
    requesterName: (r.requester_name as string | null) ?? undefined,
    originalText: String(r.original_text),
    summary: String(r.summary),
    details: JSON.parse(String(r.details)),
    operations: JSON.parse(String(r.operations)),
    status: r.status as CommessaStatus,
    approvedBy: (r.approved_by as string | null) ?? undefined,
    resultUrls: JSON.parse(String(r.result_urls)),
    undo: JSON.parse(String(r.undo)),
    error: (r.error as string | null) ?? undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
