import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Operation } from "./operations.js";
import type { IncomingMessage, MediaRef } from "./whatsapp.js";
import type { UndoStep } from "./wordpress.js";

export type CommessaStatus =
  | "in_attesa" // proposta, aspetta l'OK
  | "programmata" // approvata, verrà applicata alla data indicata
  | "in_corso" // approvata, la sto applicando
  | "completata"
  | "in_ripristino" // sto rimettendo il sito com'era
  | "errore"
  | "annullata"
  | "ripristinata"
  | "scaduta"; // nessuno ha dato l'OK in tempo

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
  /** Messaggio WhatsApp da cui è nata: evita doppioni se il messaggio viene rielaborato. */
  sourceMessageId?: string;
  /** Messaggio con cui il bot l'ha proposta: permette di approvarla rispondendo a quel messaggio. */
  proposalMessageId?: string;
  /** Quando applicarla (ISO, UTC). Assente = subito dopo l'OK. */
  applyAt?: string;
  /** Quando rimettere il sito com'era (ISO, UTC). */
  revertAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessage {
  /** ID WhatsApp del messaggio, se noto. */
  messageId?: string;
  from: string;
  fromName?: string;
  text: string;
  /** true se il messaggio l'ha scritto il bot */
  bot: boolean;
  timestamp: number;
  media?: MediaRef;
}

export interface Job {
  messageId: string;
  chatId: string;
  message: IncomingMessage;
  attempts: number;
}

export type NewCommessa = Pick<
  Commessa,
  "chatId" | "chatType" | "requesterId" | "requesterName" | "originalText" | "summary" | "details" | "operations"
> &
  Partial<Pick<Commessa, "sourceMessageId" | "applyAt" | "revertAt">>;

type Row = Record<string, unknown>;

/** Archivio su SQLite (node:sqlite, nessuna dipendenza esterna): commesse, cronologia e coda dei messaggi. */
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
      CREATE TABLE IF NOT EXISTS inbox (
        message_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbox_status ON inbox(status);
    `);
    // Colonne aggiunte dopo la prima versione: le creo se il database è più vecchio.
    this.ensureColumn("commesse", "source_message_id", "TEXT");
    this.ensureColumn("commesse", "proposal_message_id", "TEXT");
    this.ensureColumn("commesse", "apply_at", "TEXT");
    this.ensureColumn("commesse", "revert_at", "TEXT");
    this.ensureColumn("messaggi", "message_id", "TEXT");
    this.ensureColumn("messaggi", "media", "TEXT");
    this.ensureColumn("messaggi", "media_used", "INTEGER NOT NULL DEFAULT 0");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS messaggi_message_id ON messaggi(message_id) WHERE message_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS commesse_source ON commesse(source_message_id);
      CREATE INDEX IF NOT EXISTS commesse_proposal ON commesse(proposal_message_id);
    `);
  }

  private ensureColumn(table: string, column: string, ddl: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  // ------------------------------------------------------------ coda dei messaggi

  /**
   * Salva un messaggio in arrivo prima di elaborarlo, così non va perso se il
   * server si riavvia. Restituisce false se era già stato ricevuto (Meta può
   * ripetere la stessa notifica).
   */
  enqueue(msg: IncomingMessage): boolean {
    const now = new Date().toISOString();
    const r = this.db
      .prepare("INSERT OR IGNORE INTO inbox (message_id, chat_id, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(msg.id, msg.chatId, JSON.stringify(msg), now, now);
    return Number(r.changes) > 0;
  }

  /** Prende in carico un messaggio in coda. Restituisce il numero del tentativo, 0 se non è più in coda. */
  claimJob(messageId: string): number {
    const r = this.db
      .prepare("UPDATE inbox SET status = 'processing', attempts = attempts + 1, updated_at = ? WHERE message_id = ? AND status = 'pending'")
      .run(new Date().toISOString(), messageId);
    if (Number(r.changes) === 0) return 0;
    const row = this.db.prepare("SELECT attempts FROM inbox WHERE message_id = ?").get(messageId) as Row;
    return Number(row.attempts);
  }

  finishJob(messageId: string, status: "done" | "failed" | "pending", error?: string): void {
    this.db
      .prepare("UPDATE inbox SET status = ?, error = ?, updated_at = ? WHERE message_id = ?")
      .run(status, error ?? null, new Date().toISOString(), messageId);
  }

  /** Dopo un riavvio: i messaggi rimasti a metà tornano in coda. */
  resetInterruptedJobs(): number {
    const r = this.db
      .prepare("UPDATE inbox SET status = 'pending', updated_at = ? WHERE status = 'processing'")
      .run(new Date().toISOString());
    return Number(r.changes);
  }

  pendingJobs(): Job[] {
    const rows = this.db.prepare("SELECT * FROM inbox WHERE status = 'pending' ORDER BY rowid").all() as Row[];
    return rows.map((r) => ({
      messageId: String(r.message_id),
      chatId: String(r.chat_id),
      message: JSON.parse(String(r.payload)) as IncomingMessage,
      attempts: Number(r.attempts),
    }));
  }

  jobStatus(messageId: string): string | undefined {
    const row = this.db.prepare("SELECT status FROM inbox WHERE message_id = ?").get(messageId) as Row | undefined;
    return row ? String(row.status) : undefined;
  }

  /** Elimina dalla coda i messaggi già elaborati più vecchi di N giorni. */
  pruneJobs(days = 30): void {
    const limit = new Date(Date.now() - days * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM inbox WHERE status IN ('done', 'failed') AND updated_at < ?").run(limit);
  }

  // ------------------------------------------------------------ cronologia

  addMessage(chatId: string, msg: ChatMessage): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO messaggi (chat_id, sender, sender_name, text, bot, ts, message_id, media)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        chatId,
        msg.from,
        msg.fromName ?? null,
        msg.text,
        msg.bot ? 1 : 0,
        msg.timestamp,
        msg.messageId ?? null,
        msg.media ? JSON.stringify(msg.media) : null,
      );
  }

  /** Ultimi messaggi della chat, dal più vecchio al più recente. */
  recentMessages(chatId: string, limit = 12): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM messaggi WHERE chat_id = ? ORDER BY id DESC LIMIT ?")
      .all(chatId, limit) as Row[];
    return rows.reverse().map((r) => ({
      messageId: (r.message_id as string | null) ?? undefined,
      from: String(r.sender),
      fromName: (r.sender_name as string | null) ?? undefined,
      text: String(r.text),
      bot: r.bot === 1,
      timestamp: Number(r.ts),
      media: r.media ? (JSON.parse(String(r.media)) as MediaRef) : undefined,
    }));
  }

  /** Foto e documenti mandati di recente da una persona e non ancora usati per una richiesta. */
  recentMedia(chatId: string, sender: string, sinceTs: number, limit = 3): Array<{ rowId: number; media: MediaRef }> {
    const rows = this.db
      .prepare(
        `SELECT id, media FROM messaggi
         WHERE chat_id = ? AND sender = ? AND bot = 0 AND media IS NOT NULL AND media_used = 0 AND ts >= ?
         ORDER BY id DESC LIMIT ?`,
      )
      .all(chatId, sender, sinceTs, limit) as Row[];
    return rows
      .reverse()
      .map((r) => ({ rowId: Number(r.id), media: JSON.parse(String(r.media)) as MediaRef }))
      .filter((r) => r.media.kind !== "audio");
  }

  markMediaUsed(rowIds: number[]): void {
    const stmt = this.db.prepare("UPDATE messaggi SET media_used = 1 WHERE id = ?");
    for (const id of rowIds) stmt.run(id);
  }

  // ------------------------------------------------------------ commesse

  createCommessa(c: NewCommessa): Commessa {
    const now = new Date().toISOString();
    const r = this.db
      .prepare(
        `INSERT INTO commesse (chat_id, chat_type, requester_id, requester_name, original_text, summary, details,
           operations, status, source_message_id, apply_at, revert_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'in_attesa', ?, ?, ?, ?, ?)`,
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
        c.sourceMessageId ?? null,
        c.applyAt ?? null,
        c.revertAt ?? null,
        now,
        now,
      );
    return this.get(Number(r.lastInsertRowid))!;
  }

  get(id: number): Commessa | undefined {
    const row = this.db.prepare("SELECT * FROM commesse WHERE id = ?").get(id) as Row | undefined;
    return row ? toCommessa(row) : undefined;
  }

  findBySourceMessage(messageId: string): Commessa | undefined {
    const row = this.db.prepare("SELECT * FROM commesse WHERE source_message_id = ? ORDER BY id DESC").get(messageId) as
      | Row
      | undefined;
    return row ? toCommessa(row) : undefined;
  }

  findByProposalMessage(messageId: string): Commessa | undefined {
    const row = this.db.prepare("SELECT * FROM commesse WHERE proposal_message_id = ?").get(messageId) as Row | undefined;
    return row ? toCommessa(row) : undefined;
  }

  list(chatId: string, statuses: CommessaStatus[], limit = 10): Commessa[] {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM commesse WHERE chat_id = ? AND status IN (${placeholders}) ORDER BY id DESC LIMIT ?`)
      .all(chatId, ...statuses, limit) as Row[];
    return rows.map(toCommessa);
  }

  /** Commesse di tutte le chat in un certo stato (per la ripresa dopo un riavvio). */
  listByStatus(statuses: CommessaStatus[]): Commessa[] {
    const placeholders = statuses.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT * FROM commesse WHERE status IN (${placeholders}) ORDER BY id`)
      .all(...statuses) as Row[];
    return rows.map(toCommessa);
  }

  /** Commesse programmate la cui data è arrivata. */
  dueToApply(nowIso: string): Commessa[] {
    const rows = this.db
      .prepare("SELECT * FROM commesse WHERE status = 'programmata' AND apply_at IS NOT NULL AND apply_at <= ? ORDER BY id")
      .all(nowIso) as Row[];
    return rows.map(toCommessa);
  }

  /** Commesse a tempo arrivate a scadenza: il sito va rimesso com'era. */
  dueToRevert(nowIso: string): Commessa[] {
    const rows = this.db
      .prepare("SELECT * FROM commesse WHERE status = 'completata' AND revert_at IS NOT NULL AND revert_at <= ? ORDER BY id")
      .all(nowIso) as Row[];
    return rows.map(toCommessa);
  }

  /**
   * Cambia stato solo se la commessa è ancora nello stato atteso: evita che due
   * "ok" quasi simultanei applichino due volte la stessa modifica.
   */
  transition(id: number, from: CommessaStatus, to: CommessaStatus, extra: CommessaPatch = {}): boolean {
    const { sets, values } = patchSql(extra);
    sets.push("status = ?", "updated_at = ?");
    values.push(to, new Date().toISOString());
    const r = this.db
      .prepare(`UPDATE commesse SET ${sets.join(", ")} WHERE id = ? AND status = ?`)
      .run(...values, id, from);
    return Number(r.changes) > 0;
  }

  /** Aggiorna alcuni campi senza cambiare stato. */
  update(id: number, patch: CommessaPatch): void {
    const { sets, values } = patchSql(patch);
    if (!sets.length) return;
    sets.push("updated_at = ?");
    values.push(new Date().toISOString());
    this.db.prepare(`UPDATE commesse SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
  }

  /** Registra subito come annullare un'operazione in corso, così un riavvio non la lascia a metà. */
  appendUndo(id: number, step: UndoStep): void {
    const current = this.get(id);
    if (!current) return;
    this.update(id, { undo: [...current.undo, step] });
  }

  close(): void {
    this.db.close();
  }
}

export interface CommessaPatch {
  approvedBy?: string;
  resultUrls?: string[];
  undo?: UndoStep[];
  error?: string;
  proposalMessageId?: string;
  /** null cancella la data. */
  revertAt?: string | null;
}

function patchSql(patch: CommessaPatch): { sets: string[]; values: Array<string | null> } {
  const sets: string[] = [];
  const values: Array<string | null> = [];
  if (patch.approvedBy !== undefined) {
    sets.push("approved_by = ?");
    values.push(patch.approvedBy);
  }
  if (patch.resultUrls !== undefined) {
    sets.push("result_urls = ?");
    values.push(JSON.stringify(patch.resultUrls));
  }
  if (patch.undo !== undefined) {
    sets.push("undo = ?");
    values.push(JSON.stringify(patch.undo));
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    values.push(patch.error);
  }
  if (patch.proposalMessageId !== undefined) {
    sets.push("proposal_message_id = ?");
    values.push(patch.proposalMessageId);
  }
  if (patch.revertAt !== undefined) {
    sets.push("revert_at = ?");
    values.push(patch.revertAt);
  }
  return { sets, values };
}

function toCommessa(r: Row): Commessa {
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
    sourceMessageId: (r.source_message_id as string | null) ?? undefined,
    proposalMessageId: (r.proposal_message_id as string | null) ?? undefined,
    applyAt: (r.apply_at as string | null) ?? undefined,
    revertAt: (r.revert_at as string | null) ?? undefined,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}
