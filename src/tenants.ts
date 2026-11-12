import { ClaudeInterpreter, type Interpreter } from "./ai.js";
import { Bot, type Messenger, type SiteEditor } from "./bot.js";
import type { Prefilter } from "./prefilter.js";
import { decryptSecret } from "./secrets.js";
import type { PgStore, Tenant } from "./store-pg.js";
import type { Transcriber } from "./transcribe.js";
import { WordPressClient } from "./wordpress.js";

export interface TenantEntry {
  tenant: Tenant;
  /** Assente finché il cliente non ha un sito collegato con la sua password. */
  bot?: Bot;
  wordpress?: WordPressClient;
  /** Perché il bot non può lavorare per questo cliente, se è così. */
  problem?: string;
}

export interface TenantDeps {
  store: PgStore;
  messenger: Messenger;
  credentialsKey: string;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  prefilter?: Prefilter;
  transcriber?: Transcriber;
  /** Ogni quanti millisecondi rileggere i clienti dal database (default 60 secondi). */
  refreshMs?: number;
  /** Sostituibili nei test. */
  siteFetch?: (tenant: Tenant) => typeof fetch | undefined;
  makeInterpreter?: (wordpress: WordPressClient, tenant: Tenant) => Interpreter;
  now?: () => Date;
}

/**
 * Tiene in memoria un bot per ogni cliente attivo, costruito con il suo sito,
 * le sue chat, i suoi responsabili e le sue regole. I clienti vengono riletti
 * dal database ogni minuto, così le modifiche fatte in dashboard arrivano da sole.
 */
export class TenantRegistry {
  private byChat = new Map<string, TenantEntry>();
  private byClient = new Map<string, TenantEntry>();
  private loadedAt = 0;
  private loading?: Promise<void>;

  constructor(private readonly deps: TenantDeps) {}

  /** Rilegge tutti i clienti dal database e ricostruisce i bot. */
  async refresh(): Promise<void> {
    this.loading ??= this.load().finally(() => {
      this.loading = undefined;
    });
    await this.loading;
  }

  private async load(): Promise<void> {
    const tenants = await this.deps.store.tenants();
    const byChat = new Map<string, TenantEntry>();
    const byClient = new Map<string, TenantEntry>();
    for (const tenant of tenants) {
      const entry = this.build(tenant);
      byClient.set(tenant.id, entry);
      for (const ch of tenant.channels) byChat.set(ch.chatId, entry);
    }
    this.byChat = byChat;
    this.byClient = byClient;
    this.loadedAt = Date.now();
  }

  private build(tenant: Tenant): TenantEntry {
    if (!tenant.site) return { tenant, problem: "sito non ancora collegato" };
    if (!tenant.site.appPasswordEnc) return { tenant, problem: "manca la password applicazione di WordPress" };

    let appPassword: string;
    try {
      appPassword = decryptSecret(tenant.site.appPasswordEnc, this.deps.credentialsKey);
    } catch {
      return { tenant, problem: "la password salvata non si riesce a leggere (CREDENTIALS_KEY cambiata?)" };
    }

    const wordpress = new WordPressClient({
      url: tenant.site.url,
      user: tenant.site.user,
      appPassword,
      postTypes: tenant.site.postTypes,
      woocommerce: tenant.site.woocommerce,
      fetch: this.deps.siteFetch?.(tenant),
    });
    const site: SiteEditor = {
      apply: (op, record) => wordpress.apply(op, record),
      undo: (step, opts) => wordpress.undo(step, opts),
      preview: (op) => wordpress.preview(op),
      ...(tenant.site.verifyPublic ? { verifyPublic: (check) => wordpress.verifyPublic(check) } : {}),
    };
    const profile = [`Cliente: ${tenant.name}${tenant.sector ? ` (${tenant.sector})` : ""}.`, tenant.profile].filter(Boolean).join("\n");
    const interpreter =
      this.deps.makeInterpreter?.(wordpress, tenant) ??
      new ClaudeInterpreter(wordpress, { model: this.deps.model, effort: this.deps.effort, profile });

    const bot = new Bot(this.deps.store, interpreter, site, this.deps.messenger, {
      allowedGroups: tenant.channels.filter((c) => c.chatType === "group").map((c) => c.chatId),
      allowedSenders: tenant.channels.filter((c) => c.chatType === "individual").map((c) => c.chatId),
      approvers: tenant.approvers,
      strictApprovers: true,
      chatApproval: tenant.approvalRule === "cliente",
      triggerPrefix: tenant.triggerPrefix,
      proposalTtlHours: tenant.proposalTtlHours,
      timezone: tenant.timezone,
      transcriber: this.deps.transcriber,
      prefilter: tenant.prefilter ? this.deps.prefilter : undefined,
      monthlyBudgetUsd: tenant.monthlyBudgetUsd,
      now: this.deps.now,
    });
    return { tenant, bot, wordpress };
  }

  private async fresh(): Promise<void> {
    if (Date.now() - this.loadedAt > (this.deps.refreshMs ?? 60_000)) await this.refresh();
  }

  /** Il cliente a cui appartiene una chat WhatsApp. Una chat sconosciuta provoca una rilettura (un gruppo appena collegato). */
  async forChat(chatId: string): Promise<TenantEntry | undefined> {
    await this.fresh();
    if (!this.byChat.has(chatId) && Date.now() - this.loadedAt > 5_000) await this.refresh();
    return this.byChat.get(chatId);
  }

  /** Il cliente con quell'ID, riletto dal database: le azioni dalla dashboard devono vedere le impostazioni appena salvate. */
  async forClient(clientId: string): Promise<TenantEntry | undefined> {
    await this.refresh();
    return this.byClient.get(clientId);
  }

  async all(): Promise<TenantEntry[]> {
    await this.fresh();
    return [...this.byClient.values()];
  }
}
