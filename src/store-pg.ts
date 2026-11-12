import type { Operation } from "./operations.js";
import type {
  AiUsage,
  ChatMessage,
  Commessa,
  CommessaPatch,
  CommessaStatus,
  DataStore,
  Job,
  NewCommessa,
  UsageTotals,
} from "./store.js";
import type { IncomingMessage, MediaRef } from "./whatsapp.js";
import type { SiteCheck, UndoStep } from "./wordpress.js";

/** Il minimo che serve di un client Postgres: lo soddisfano sia `pg.Pool` sia PGlite (usato nei test). */
export interface Db {
  query(text: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

/** Un cliente con tutto ciò che serve al bot per lavorare sul suo sito e nelle sue chat. */
export interface Tenant {
  id: string;
  name: string;
  sector: string;
  profile: string;
  triggerPrefix: string;
  proposalTtlHours: number;
  approvalRule: "cliente" | "agenzia";
  monthlyBudgetUsd: number;
  prefilter: boolean;
  timezone: string;
  site?: {
    url: string;
    user: string;
    postTypes: string[];
    woocommerce: boolean;
    verifyPublic: boolean;
    /** Password applicazione cifrata (vedi secrets.ts); assente se non ancora inserita. */
    appPasswordEnc?: string;
  };
  channels: Array<{ chatId: string; chatType: "group" | "individual"; name: string }>;
  /** Numeri WhatsApp che possono dare l'ok dal gruppo. */
  approvers: string[];
}

export type ActionType = "approva" | "annulla" | "ripristina" | "ripristina_forza" | "riprova" | "prova_sito";

export interface Action {
  id: number;
  clientId: string;
  commessaId?: number;
  type: ActionType;
  /** Nome di chi l'ha chiesta dalla dashboard. */
  requestedBy: string;
}

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoOrUndefined = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : iso(v));
const text = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const json = (v: unknown): unknown => (typeof v === "string" ? JSON.parse(v) : v);

/**
 * Archivio su Postgres (Supabase) per la piattaforma multi-cliente.
 * Ogni riga porta il cliente a cui appartiene, ricavato dalla chat WhatsApp.
 */
export class PgStore implements DataStore {
  constructor(private readonly db: Db) {}

  private async rows(sql: string, params: unknown[] = []): Promise<Row[]> {
    return (await this.db.query(sql, params)).rows;
  }

  // ------------------------------------------------------------ coda dei messaggi

  async enqueue(msg: IncomingMessage): Promise<boolean> {
    const rows = await this.rows(
      `insert into inbox (message_id, chat_id, payload) values ($1, $2, $3::jsonb)
       on conflict (message_id) do nothing returning message_id`,
      [msg.id, msg.chatId, JSON.stringify(msg)],
    );
    return rows.length > 0;
  }

  async claimJob(messageId: string): Promise<number> {
    const rows = await this.rows(
      `update inbox set status = 'processing', attempts = attempts + 1, updated_at = now()
       where message_id = $1 and status = 'pending' returning attempts`,
      [messageId],
    );
    return rows.length ? Number(rows[0].attempts) : 0;
  }

  async finishJob(messageId: string, status: "done" | "failed" | "pending", error?: string): Promise<void> {
    await this.rows("update inbox set status = $2, error = $3, updated_at = now() where message_id = $1", [
      messageId,
      status,
      error ?? null,
    ]);
  }

  async resetInterruptedJobs(): Promise<number> {
    const rows = await this.rows(
      "update inbox set status = 'pending', updated_at = now() where status = 'processing' returning message_id",
    );
    return rows.length;
  }

  async pendingJobs(): Promise<Job[]> {
    const rows = await this.rows("select * from inbox where status = 'pending' order by created_at, message_id");
    return rows.map((r) => ({
      messageId: String(r.message_id),
      chatId: String(r.chat_id),
      message: json(r.payload) as IncomingMessage,
      attempts: Number(r.attempts),
    }));
  }

  async jobStatus(messageId: string): Promise<string | undefined> {
    const rows = await this.rows("select status from inbox where message_id = $1", [messageId]);
    return rows.length ? String(rows[0].status) : undefined;
  }

  async pruneJobs(days = 30): Promise<void> {
    await this.rows(
      "delete from inbox where status in ('done', 'failed') and updated_at < now() - make_interval(days => $1::int)",
      [days],
    );
  }

  // ------------------------------------------------------------ cronologia

  async addMessage(chatId: string, msg: ChatMessage): Promise<void> {
    await this.rows(
      `insert into messaggi (client_id, chat_id, sender, sender_name, text, bot, ts, message_id, media)
       values ((select client_id from client_channels where chat_id = $1), $1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       on conflict do nothing`,
      [
        chatId,
        msg.from,
        msg.fromName ?? null,
        msg.text,
        msg.bot,
        msg.timestamp,
        msg.messageId ?? null,
        msg.media ? JSON.stringify(msg.media) : null,
      ],
    );
  }

  async recentMessages(chatId: string, limit = 12): Promise<ChatMessage[]> {
    const rows = await this.rows("select * from messaggi where chat_id = $1 order by id desc limit $2", [chatId, limit]);
    return rows.reverse().map((r) => ({
      messageId: text(r.message_id),
      from: String(r.sender),
      fromName: text(r.sender_name),
      text: String(r.text),
      bot: r.bot === true,
      timestamp: Number(r.ts),
      media: r.media ? (json(r.media) as MediaRef) : undefined,
    }));
  }

  async recentMedia(chatId: string, sender: string, sinceTs: number, limit = 3): Promise<Array<{ rowId: number; media: MediaRef }>> {
    const rows = await this.rows(
      `select id, media from messaggi
       where chat_id = $1 and sender = $2 and not bot and media is not null and not media_used and ts >= $3
       order by id desc limit $4`,
      [chatId, sender, sinceTs, limit],
    );
    return rows
      .reverse()
      .map((r) => ({ rowId: Number(r.id), media: json(r.media) as MediaRef }))
      .filter((r) => r.media.kind !== "audio");
  }

  async markMediaUsed(rowIds: number[]): Promise<void> {
    for (const id of rowIds) await this.rows("update messaggi set media_used = true where id = $1", [id]);
  }

  // ------------------------------------------------------------ commesse

  async createCommessa(c: NewCommessa): Promise<Commessa> {
    const rows = await this.rows(
      `insert into commesse (client_id, chat_id, chat_type, requester_id, requester_name, original_text, summary,
         details, operations, preview, small, status, source_message_id, apply_at, revert_at)
       select ch.client_id, $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, 'in_attesa', $11, $12, $13
       from client_channels ch where ch.chat_id = $1
       returning *`,
      [
        c.chatId,
        c.chatType,
        c.requesterId,
        c.requesterName ?? null,
        c.originalText,
        c.summary,
        JSON.stringify(c.details),
        JSON.stringify(c.operations),
        JSON.stringify(c.preview ?? []),
        c.small ?? false,
        c.sourceMessageId ?? null,
        c.applyAt ?? null,
        c.revertAt ?? null,
      ],
    );
    if (!rows.length) throw new Error(`La chat ${c.chatId} non è collegata a nessun cliente`);
    return toCommessa(rows[0]);
  }

  async get(id: number): Promise<Commessa | undefined> {
    const rows = await this.rows("select * from commesse where id = $1", [id]);
    return rows.length ? toCommessa(rows[0]) : undefined;
  }

  async findBySourceMessage(messageId: string): Promise<Commessa | undefined> {
    const rows = await this.rows("select * from commesse where source_message_id = $1 order by id desc limit 1", [messageId]);
    return rows.length ? toCommessa(rows[0]) : undefined;
  }

  async findByProposalMessage(messageId: string): Promise<Commessa | undefined> {
    const rows = await this.rows("select * from commesse where proposal_message_id = $1 limit 1", [messageId]);
    return rows.length ? toCommessa(rows[0]) : undefined;
  }

  async list(chatId: string, statuses: CommessaStatus[], limit = 10): Promise<Commessa[]> {
    const rows = await this.rows(
      "select * from commesse where chat_id = $1 and status = any($2::text[]) order by id desc limit $3",
      [chatId, statuses, limit],
    );
    return rows.map(toCommessa);
  }

  async listByStatus(statuses: CommessaStatus[]): Promise<Commessa[]> {
    const rows = await this.rows("select * from commesse where status = any($1::text[]) order by id", [statuses]);
    return rows.map(toCommessa);
  }

  async dueToApply(nowIso: string): Promise<Commessa[]> {
    const rows = await this.rows(
      "select * from commesse where status = 'programmata' and apply_at is not null and apply_at <= $1::timestamptz order by id",
      [nowIso],
    );
    return rows.map(toCommessa);
  }

  async dueToRevert(nowIso: string): Promise<Commessa[]> {
    const rows = await this.rows(
      "select * from commesse where status = 'completata' and revert_at is not null and revert_at <= $1::timestamptz order by id",
      [nowIso],
    );
    return rows.map(toCommessa);
  }

  async transition(id: number, from: CommessaStatus, to: CommessaStatus, extra: CommessaPatch = {}): Promise<boolean> {
    const { sets, values } = patchSql(extra, 4);
    const rows = await this.rows(
      `update commesse set status = $3, updated_at = now()${sets.map((s) => `, ${s}`).join("")}
       where id = $1 and status = $2 returning id`,
      [id, from, to, ...values],
    );
    return rows.length > 0;
  }

  async update(id: number, patch: CommessaPatch): Promise<void> {
    const { sets, values } = patchSql(patch, 2);
    if (!sets.length) return;
    await this.rows(`update commesse set updated_at = now(), ${sets.join(", ")} where id = $1`, [id, ...values]);
  }

  async appendUndo(id: number, step: UndoStep): Promise<void> {
    await this.rows("update commesse set undo = undo || $2::jsonb, updated_at = now() where id = $1", [
      id,
      JSON.stringify([step]),
    ]);
  }

  // ------------------------------------------------------------ consumi AI

  async addUsage(chatId: string, usage: AiUsage, commessaId?: number): Promise<void> {
    await this.rows(
      `insert into consumi_ai (client_id, chat_id, commessa_id, model, purpose, calls, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, cost_usd)
       values ((select client_id from client_channels where chat_id = $1), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        chatId,
        commessaId ?? null,
        usage.model,
        usage.purpose,
        usage.calls,
        usage.inputTokens,
        usage.outputTokens,
        usage.cacheReadTokens,
        usage.cacheWriteTokens,
        usage.costUsd ?? null,
      ],
    );
  }

  /** Nella piattaforma multi-cliente il tetto di spesa vale per tutto il cliente, non per la singola chat. */
  async usageSince(chatId: string, sinceIso: string): Promise<UsageTotals> {
    const rows = await this.rows(
      `select coalesce(sum(calls), 0) as calls,
              coalesce(sum(input_tokens + cache_read_tokens + cache_write_tokens), 0) as input_tokens,
              coalesce(sum(output_tokens), 0) as output_tokens,
              coalesce(sum(cost_usd), 0) as cost_usd
       from consumi_ai
       where created_at >= $2::timestamptz
         and (chat_id = $1 or client_id = (select client_id from client_channels where chat_id = $1))`,
      [chatId, sinceIso],
    );
    const r = rows[0];
    return {
      calls: Number(r.calls),
      inputTokens: Number(r.input_tokens),
      outputTokens: Number(r.output_tokens),
      costUsd: Number(r.cost_usd),
    };
  }

  // ------------------------------------------------------------ clienti

  /** Tutti i clienti attivi con sito, chat e responsabili. */
  async tenants(): Promise<Tenant[]> {
    const clients = await this.rows(
      `select c.*, s.url, s.wp_user, s.post_types, s.woocommerce, s.verify_public, x.wp_app_password_enc
       from clients c
       left join client_sites s on s.client_id = c.id
       left join client_secrets x on x.client_id = c.id
       where c.status = 'attivo' order by c.name`,
    );
    const channels = await this.rows("select client_id, chat_id, chat_type, name from client_channels where active");
    const contacts = await this.rows("select client_id, wa_id from contacts where can_approve");
    return clients.map((c) => ({
      id: String(c.id),
      name: String(c.name),
      sector: String(c.sector),
      profile: String(c.profile),
      triggerPrefix: String(c.trigger_prefix),
      proposalTtlHours: Number(c.proposal_ttl_hours),
      approvalRule: c.approval_rule as Tenant["approvalRule"],
      monthlyBudgetUsd: Number(c.monthly_budget_usd),
      prefilter: c.prefilter === true,
      timezone: String(c.timezone),
      site: c.url
        ? {
            url: String(c.url).replace(/\/+$/, ""),
            user: String(c.wp_user),
            postTypes: c.post_types as string[],
            woocommerce: c.woocommerce === true,
            verifyPublic: c.verify_public !== false,
            appPasswordEnc: text(c.wp_app_password_enc),
          }
        : undefined,
      channels: channels
        .filter((ch) => ch.client_id === c.id)
        .map((ch) => ({ chatId: String(ch.chat_id), chatType: ch.chat_type as "group" | "individual", name: String(ch.name) })),
      approvers: contacts.filter((p) => p.client_id === c.id).map((p) => String(p.wa_id).replace(/[^\d]/g, "")),
    }));
  }

  async saveSiteCheck(clientId: string, check: SiteCheck): Promise<void> {
    await this.rows("update client_sites set last_check = $2::jsonb, last_check_at = now() where client_id = $1", [
      clientId,
      JSON.stringify(check),
    ]);
  }

  // ------------------------------------------------------------ azioni dalla dashboard

  /** Prende in carico la prossima azione in coda (una sola alla volta, anche con più processi). */
  async claimAction(): Promise<Action | undefined> {
    const rows = await this.rows(
      `update azioni a set stato = 'in_corso', updated_at = now()
       where a.id = (select id from azioni where stato = 'in_coda' order by id limit 1 for update skip locked)
       returning a.id, a.client_id, a.commessa_id, a.tipo,
         coalesce((select nullif(p.full_name, '') from profiles p where p.id = a.richiesta_da),
                  (select nullif(p.email, '') from profiles p where p.id = a.richiesta_da), 'dashboard') as requested_by`,
    );
    if (!rows.length) return undefined;
    const r = rows[0];
    return {
      id: Number(r.id),
      clientId: String(r.client_id),
      commessaId: r.commessa_id === null ? undefined : Number(r.commessa_id),
      type: r.tipo as ActionType,
      requestedBy: String(r.requested_by),
    };
  }

  async finishAction(id: number, ok: boolean, outcome: string): Promise<void> {
    await this.rows("update azioni set stato = $2, esito = $3, updated_at = now() where id = $1", [
      id,
      ok ? "fatta" : "fallita",
      outcome,
    ]);
  }

  /** Dopo un riavvio: le azioni rimaste a metà tornano in coda. */
  async resetInterruptedActions(): Promise<number> {
    const rows = await this.rows("update azioni set stato = 'in_coda', updated_at = now() where stato = 'in_corso' returning id");
    return rows.length;
  }
}

function patchSql(patch: CommessaPatch, firstParam: number): { sets: string[]; values: unknown[] } {
  const sets: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown, cast = "") => {
    values.push(value);
    sets.push(`${column} = $${firstParam + values.length - 1}${cast}`);
  };
  if (patch.approvedBy !== undefined) add("approved_by", patch.approvedBy);
  if (patch.resultUrls !== undefined) add("result_urls", JSON.stringify(patch.resultUrls), "::jsonb");
  if (patch.undo !== undefined) add("undo", JSON.stringify(patch.undo), "::jsonb");
  if (patch.error !== undefined) add("error", patch.error);
  if (patch.proposalMessageId !== undefined) add("proposal_message_id", patch.proposalMessageId);
  if (patch.revertAt !== undefined) add("revert_at", patch.revertAt, "::timestamptz");
  return { sets, values };
}

function toCommessa(r: Row): Commessa {
  return {
    id: Number(r.id),
    chatId: String(r.chat_id),
    chatType: r.chat_type as Commessa["chatType"],
    requesterId: String(r.requester_id),
    requesterName: text(r.requester_name),
    originalText: String(r.original_text),
    summary: String(r.summary),
    details: json(r.details) as string[],
    operations: json(r.operations) as Operation[],
    preview: json(r.preview) as Commessa["preview"],
    small: r.small === true,
    status: r.status as CommessaStatus,
    approvedBy: text(r.approved_by),
    resultUrls: json(r.result_urls) as string[],
    undo: json(r.undo) as UndoStep[],
    error: text(r.error),
    sourceMessageId: text(r.source_message_id),
    proposalMessageId: text(r.proposal_message_id),
    applyAt: isoOrUndefined(r.apply_at),
    revertAt: isoOrUndefined(r.revert_at),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
}
