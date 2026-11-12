import type { Session } from "./auth";
import { withUser, type Row } from "./db";
import type { Status } from "./format";

/** Tutte le letture della dashboard. Ogni query gira con i permessi dell'utente (RLS). */

export interface ChangePreview {
  kind: "modifica" | "nuovo" | "prezzo";
  title: string;
  url: string;
  changes: Array<{ field: string; before: string; after: string }>;
}

export interface CommessaRow {
  id: number;
  clientId: string;
  clientName: string;
  summary: string;
  details: string[];
  status: Status;
  small: boolean;
  requesterName: string;
  createdAt: Date;
  updatedAt: Date;
  applyAt: Date | null;
  revertAt: Date | null;
  /** Azione chiesta dalla dashboard e non ancora eseguita dal bot. */
  pendingAction: string | null;
}

export interface CommessaDetail extends CommessaRow {
  originalText: string;
  preview: ChangePreview[];
  approvedBy: string | null;
  resultUrls: string[];
  error: string | null;
  approvalRule: "cliente" | "agenzia";
  chatName: string;
  messages: Array<{ sender: string; text: string; bot: boolean; at: Date; media: string | null }>;
  actions: Array<{ id: number; type: string; state: string; outcome: string | null; by: string; at: Date }>;
  costUsd: number | null;
}

const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : date(v));

function toCommessa(r: Row): CommessaRow {
  return {
    id: Number(r.id),
    clientId: String(r.client_id),
    clientName: String(r.client_name),
    summary: String(r.summary),
    details: (r.details as string[]) ?? [],
    status: r.status as Status,
    small: r.small === true,
    requesterName: String(r.requester_name ?? r.requester_id ?? ""),
    createdAt: date(r.created_at),
    updatedAt: date(r.updated_at),
    applyAt: dateOrNull(r.apply_at),
    revertAt: dateOrNull(r.revert_at),
    pendingAction: r.pending_action ? String(r.pending_action) : null,
  };
}

const COMMESSA_SELECT = `
  select k.id, k.client_id, c.name as client_name, k.summary, k.details, k.status, k.small,
         k.requester_name, k.requester_id, k.created_at, k.updated_at, k.apply_at, k.revert_at,
         (select a.tipo from azioni a where a.commessa_id = k.id and a.stato in ('in_coda', 'in_corso') order by a.id desc limit 1) as pending_action
  from commesse k join clients c on c.id = k.client_id`;

export const STATUS_GROUPS: Record<string, { label: string; statuses: Status[] }> = {
  tutte: { label: "Tutte", statuses: [] },
  attesa: { label: "Da approvare", statuses: ["in_attesa"] },
  programma: { label: "In programma", statuses: ["programmata", "in_corso", "in_ripristino"] },
  online: { label: "Online", statuses: ["completata"] },
  errore: { label: "Non riuscite", statuses: ["errore"] },
  chiuse: { label: "Annullate, scadute o ripristinate", statuses: ["annullata", "scaduta", "ripristinata"] },
};

export async function listCommesse(session: Session, filter: { group?: string; clientId?: string; limit?: number }) {
  const statuses = STATUS_GROUPS[filter.group ?? "tutte"]?.statuses ?? [];
  const clientId = filter.clientId && /^[0-9a-f-]{36}$/i.test(filter.clientId) ? filter.clientId : null;
  return withUser(session.userId, async (q) => {
    const rows = await q(
      `${COMMESSA_SELECT}
       where ($1::uuid is null or k.client_id = $1) and (cardinality($2::text[]) = 0 or k.status = any($2))
       order by k.id desc limit $3`,
      [clientId, statuses, filter.limit ?? 100],
    );
    const counts = await q(
      "select status, count(*)::int as n from commesse where ($1::uuid is null or client_id = $1) group by status",
      [clientId],
    );
    const byStatus = new Map(counts.map((r) => [String(r.status), Number(r.n)]));
    const groupCounts = Object.fromEntries(
      Object.entries(STATUS_GROUPS).map(([key, g]) => [
        key,
        g.statuses.length ? g.statuses.reduce((sum, s) => sum + (byStatus.get(s) ?? 0), 0) : [...byStatus.values()].reduce((a, b) => a + b, 0),
      ]),
    );
    return { rows: rows.map(toCommessa), groupCounts };
  });
}

export async function getCommessa(session: Session, id: number): Promise<CommessaDetail | null> {
  return withUser(session.userId, async (q) => {
    const [r] = await q(
      `select k.*, c.name as client_name, c.approval_rule,
              coalesce((select ch.name from client_channels ch where ch.chat_id = k.chat_id), '') as chat_name,
              (select a.tipo from azioni a where a.commessa_id = k.id and a.stato in ('in_coda', 'in_corso') order by a.id desc limit 1) as pending_action
       from commesse k join clients c on c.id = k.client_id where k.id = $1`,
      [id],
    );
    if (!r) return null;
    // La conversazione di questa commessa: dal messaggio con la richiesta (più un paio di righe
    // di contesto) fino all'ultimo messaggio del bot che la cita. Se non si trova il messaggio
    // d'origine si parte da un quarto d'ora prima.
    const messages = await q(
      `with bounds as (
         select coalesce(
                  (select id from messaggi where chat_id = $1 and message_id = $4),
                  (select min(id) from messaggi where chat_id = $1 and ts >= extract(epoch from $2::timestamptz) - 900)
                ) as first_id,
                (select max(id) from messaggi where chat_id = $1 and bot and text like '%(rif. ' || $5 || ')%') as last_id
       )
       select m.sender, m.sender_name, m.text, m.bot, m.ts, m.media
       from messaggi m, bounds b
       where m.chat_id = $1 and m.id >= b.first_id - 2
         and m.id <= coalesce(b.last_id, b.first_id + 6)
         and m.ts <= extract(epoch from $3::timestamptz) + 300
       order by m.id limit 40`,
      [r.chat_id, r.created_at, r.updated_at, r.source_message_id, String(r.id)],
    );
    const actions = await q(
      `select a.id, a.tipo, a.stato, a.esito, a.created_at,
              coalesce(nullif(p.full_name, ''), p.email, 'dashboard') as by
       from azioni a left join profiles p on p.id = a.richiesta_da
       where a.commessa_id = $1 order by a.id`,
      [id],
    );
    const cost = await q("select sum(cost_usd) as usd, count(*)::int as n from consumi_ai where commessa_id = $1", [id]);
    return {
      ...toCommessa(r),
      originalText: String(r.original_text),
      preview: (r.preview as ChangePreview[]) ?? [],
      approvedBy: r.approved_by ? String(r.approved_by) : null,
      resultUrls: (r.result_urls as string[]) ?? [],
      error: r.error ? String(r.error) : null,
      approvalRule: r.approval_rule as "cliente" | "agenzia",
      chatName: String(r.chat_name),
      messages: messages.map((m) => ({
        sender: m.bot ? "Assistente sito" : String(m.sender_name ?? m.sender),
        text: String(m.text),
        bot: m.bot === true,
        at: new Date(Number(m.ts) * 1000),
        media: m.media ? String((m.media as { kind?: string }).kind ?? "allegato") : null,
      })),
      actions: actions.map((a) => ({
        id: Number(a.id),
        type: String(a.tipo),
        state: String(a.stato),
        outcome: a.esito ? String(a.esito) : null,
        by: String(a.by),
        at: date(a.created_at),
      })),
      costUsd: Number(cost[0]?.n ?? 0) > 0 ? Number(cost[0].usd ?? 0) : null,
    };
  });
}

export interface ClientSummary {
  id: string;
  name: string;
  sector: string;
  status: string;
  pending: number;
  failed: number;
  lastRequest: Date | null;
  channels: number;
  siteOk: boolean | null;
  hasSite: boolean;
}

export async function listClients(session: Session): Promise<ClientSummary[]> {
  return withUser(session.userId, async (q) => {
    const rows = await q(
      `select c.id, c.name, c.sector, c.status,
              (select count(*)::int from commesse k where k.client_id = c.id and k.status = 'in_attesa') as pending,
              (select count(*)::int from commesse k where k.client_id = c.id and k.status = 'errore' and k.updated_at > now() - interval '7 days') as failed,
              (select max(k.created_at) from commesse k where k.client_id = c.id) as last_request,
              (select count(*)::int from client_channels ch where ch.client_id = c.id and ch.active) as channels,
              s.client_id is not null as has_site, (s.last_check ->> 'ok')::boolean as site_ok
       from clients c left join client_sites s on s.client_id = c.id
       order by c.status, c.name`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      sector: String(r.sector),
      status: String(r.status),
      pending: Number(r.pending),
      failed: Number(r.failed),
      lastRequest: dateOrNull(r.last_request),
      channels: Number(r.channels),
      siteOk: r.site_ok === null || r.site_ok === undefined ? null : r.site_ok === true,
      hasSite: r.has_site === true,
    }));
  });
}

export async function overview(session: Session, monthFrom: string) {
  return withUser(session.userId, async (q) => {
    const pending = (await q(`${COMMESSA_SELECT} where k.status = 'in_attesa' order by k.id desc limit 20`)).map(toCommessa);
    const failed = (
      await q(`${COMMESSA_SELECT} where k.status = 'errore' and k.updated_at > now() - interval '7 days' order by k.id desc limit 5`)
    ).map(toCommessa);
    const [stats] = await q(
      `select count(*) filter (where status = 'in_attesa')::int as pending,
              min(created_at) filter (where status = 'in_attesa') as oldest_pending,
              count(*) filter (where status = 'completata' and updated_at >= $1::timestamptz)::int as online,
              count(*) filter (where status = 'ripristinata' and updated_at >= $1::timestamptz)::int as reverted,
              count(*) filter (where status = 'errore' and updated_at >= $1::timestamptz)::int as failed,
              avg(extract(epoch from (updated_at - created_at)) / 60) filter (where status = 'completata' and updated_at >= $1::timestamptz) as avg_minutes
       from commesse`,
      [monthFrom],
    );
    const [cost] = await q("select coalesce(sum(cost_usd), 0) as usd from consumi_ai where created_at >= $1::timestamptz", [monthFrom]);
    const [budget] = await q("select coalesce(sum(monthly_budget_usd), 0) as usd from clients where status = 'attivo'");
    return {
      pending,
      failed,
      pendingCount: Number(stats.pending),
      oldestPending: dateOrNull(stats.oldest_pending),
      online: Number(stats.online),
      reverted: Number(stats.reverted),
      failedCount: Number(stats.failed),
      avgMinutes: stats.avg_minutes === null ? null : Number(stats.avg_minutes),
      costUsd: Number(cost.usd),
      budgetUsd: Number(budget.usd),
    };
  });
}

export interface ClientSettings {
  id: string;
  name: string;
  sector: string;
  status: string;
  profile: string;
  triggerPrefix: string;
  proposalTtlHours: number;
  approvalRule: string;
  monthlyBudgetUsd: number;
  showCostsToClient: boolean;
  prefilter: boolean;
  timezone: string;
  site: null | {
    url: string;
    user: string;
    postTypes: string[];
    woocommerce: boolean;
    verifyPublic: boolean;
    hasPassword: boolean;
    lastCheck: null | {
      ok: boolean;
      problems: string[];
      user?: { name: string; roles: string[] };
      availableTypes: Array<{ slug: string; name: string }>;
      acfVisible: boolean;
      woocommerce: boolean;
    };
    lastCheckAt: Date | null;
    checking: boolean;
    lastCheckOutcome: string | null;
  };
  channels: Array<{ id: string; chatId: string; chatType: string; name: string; active: boolean }>;
  contacts: Array<{ id: string; waId: string; name: string; canApprove: boolean }>;
  unlinkedChats: Array<{ chatId: string; lastSender: string; lastText: string; lastSeen: Date }>;
}

export async function getClient(session: Session, id: string): Promise<ClientSettings | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return withUser(session.userId, async (q) => {
    const [c] = await q("select * from clients where id = $1", [id]);
    if (!c) return null;
    const [s] = await q("select *, private.has_site_secret(client_id) as has_password from client_sites where client_id = $1", [id]);
    const [check] = await q(
      "select stato, esito from azioni where client_id = $1 and tipo = 'prova_sito' order by id desc limit 1",
      [id],
    );
    const channels = await q("select * from client_channels where client_id = $1 order by created_at", [id]);
    const contacts = await q("select * from contacts where client_id = $1 order by name, wa_id", [id]);
    const unlinked = await q("select * from chat_non_collegate order by last_seen desc limit 20");
    return {
      id: String(c.id),
      name: String(c.name),
      sector: String(c.sector),
      status: String(c.status),
      profile: String(c.profile),
      triggerPrefix: String(c.trigger_prefix),
      proposalTtlHours: Number(c.proposal_ttl_hours),
      approvalRule: String(c.approval_rule),
      monthlyBudgetUsd: Number(c.monthly_budget_usd),
      showCostsToClient: c.show_costs_to_client === true,
      prefilter: c.prefilter === true,
      timezone: String(c.timezone),
      site: s
        ? {
            url: String(s.url),
            user: String(s.wp_user),
            postTypes: s.post_types as string[],
            woocommerce: s.woocommerce === true,
            verifyPublic: s.verify_public !== false,
            hasPassword: s.has_password === true,
            lastCheck: (s.last_check as NonNullable<ClientSettings["site"]>["lastCheck"]) ?? null,
            lastCheckAt: dateOrNull(s.last_check_at),
            checking: check ? ["in_coda", "in_corso"].includes(String(check.stato)) : false,
            lastCheckOutcome: check?.esito ? String(check.esito) : null,
          }
        : null,
      channels: channels.map((r) => ({
        id: String(r.id),
        chatId: String(r.chat_id),
        chatType: String(r.chat_type),
        name: String(r.name),
        active: r.active === true,
      })),
      contacts: contacts.map((r) => ({ id: String(r.id), waId: String(r.wa_id), name: String(r.name), canApprove: r.can_approve === true })),
      unlinkedChats: unlinked.map((r) => ({
        chatId: String(r.chat_id),
        lastSender: String(r.last_sender ?? ""),
        lastText: String(r.last_text ?? ""),
        lastSeen: date(r.last_seen),
      })),
    };
  });
}

export interface ReportRow {
  clientId: string;
  client: string;
  requests: number;
  online: number;
  failed: number;
  pending: number;
  avgMinutes: number | null;
  costUsd: number;
  budgetUsd: number;
}

export async function report(session: Session, from: string, to: string): Promise<ReportRow[]> {
  return withUser(session.userId, async (q) => {
    const rows = await q(
      `select c.id, c.name, c.monthly_budget_usd,
              count(k.id)::int as requests,
              count(k.id) filter (where k.status = 'completata')::int as online,
              count(k.id) filter (where k.status = 'errore')::int as failed,
              count(k.id) filter (where k.status in ('in_attesa', 'programmata'))::int as pending,
              avg(extract(epoch from (k.updated_at - k.created_at)) / 60) filter (where k.status = 'completata') as avg_minutes,
              (select coalesce(sum(u.cost_usd), 0) from consumi_ai u where u.client_id = c.id and u.created_at >= $1::timestamptz and u.created_at < $2::timestamptz) as cost
       from clients c
       left join commesse k on k.client_id = c.id and k.created_at >= $1::timestamptz and k.created_at < $2::timestamptz
       group by c.id order by c.name`,
      [from, to],
    );
    return rows.map((r) => ({
      clientId: String(r.id),
      client: String(r.name),
      requests: Number(r.requests),
      online: Number(r.online),
      failed: Number(r.failed),
      pending: Number(r.pending),
      avgMinutes: r.avg_minutes === null ? null : Number(r.avg_minutes),
      costUsd: Number(r.cost),
      budgetUsd: Number(r.monthly_budget_usd),
    }));
  });
}

export interface MemberRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: string;
  clientId: string | null;
  clientName: string | null;
}

export async function listMembers(session: Session): Promise<MemberRow[]> {
  return withUser(session.userId, async (q) => {
    const rows = await q(
      `select m.id, m.user_id, m.role, m.client_id, p.full_name, p.email, c.name as client_name
       from memberships m left join profiles p on p.id = m.user_id left join clients c on c.id = m.client_id
       order by m.client_id nulls first, p.email`,
    );
    return rows.map((r) => ({
      id: String(r.id),
      userId: String(r.user_id),
      name: String(r.full_name ?? ""),
      email: String(r.email ?? ""),
      role: String(r.role),
      clientId: r.client_id ? String(r.client_id) : null,
      clientName: r.client_name ? String(r.client_name) : null,
    }));
  });
}

export async function clientOptions(session: Session): Promise<Array<{ id: string; name: string }>> {
  return withUser(session.userId, async (q) =>
    (await q("select id, name from clients order by name")).map((r) => ({ id: String(r.id), name: String(r.name) })),
  );
}
