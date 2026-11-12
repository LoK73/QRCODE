import type { CreatePostOp, Operation, UpdatePostOp, UpdateProductPriceOp } from "./operations.js";

/**
 * Client minimale per la REST API di WordPress (e, opzionalmente, WooCommerce).
 * Autenticazione con "Application Password" (Utenti → Profilo → Password applicazioni).
 */

export interface WordPressOptions {
  url: string;
  user: string;
  appPassword: string;
  postTypes: string[];
  woocommerce: boolean;
  fetch?: typeof fetch;
}

export interface SearchResult {
  id: number;
  title: string;
  url: string;
  post_type: string;
}

export interface ContentDetails {
  id: number;
  post_type: string;
  title: string;
  status: string;
  url: string;
  excerpt: string;
  content: string;
  acf?: Record<string, unknown>;
  modified?: string;
}

export interface ProductDetails {
  id: number;
  name: string;
  url: string;
  status: string;
  regular_price: string;
  sale_price: string;
}

/** Anteprima di cosa cambia in un contenuto, da mostrare a chi deve approvare. */
export interface ChangePreview {
  kind: "modifica" | "nuovo" | "prezzo";
  title: string;
  url: string;
  changes: Array<{ field: string; before: string; after: string }>;
}

/** Esito del controllo di collegamento a un sito WordPress. */
export interface SiteCheck {
  ok: boolean;
  /** Cosa non va, in parole semplici (vuoto se è tutto a posto). */
  problems: string[];
  user?: { name: string; roles: string[] };
  /** Tipi di contenuto presenti sul sito e modificabili via REST. */
  availableTypes: Array<{ slug: string; name: string }>;
  /** Tipi configurati per il bot che sul sito non esistono. */
  missingTypes: string[];
  /** true se i campi personalizzati ACF sono esposti nella REST API. */
  acfVisible: boolean;
  woocommerce: boolean;
}

/** Un punto del sito in cui compare un certo testo. */
export interface Occurrence {
  id: number;
  post_type: string;
  title: string;
  url: string;
  status: string;
  matches: Array<{ where: string; snippet: string }>;
}

export interface PostFields {
  title?: string;
  content?: string;
  excerpt?: string;
  status?: string;
  acf?: Record<string, unknown>;
}

/**
 * Come annullare un'operazione già applicata.
 *
 * `fields` sono i valori di prima, `written` quelli che WordPress ha salvato
 * dopo la nostra modifica: al ripristino servono per capire se nel frattempo
 * qualcuno ha cambiato la pagina a mano. Senza `written` (passo registrato
 * prima della scrittura, per sicurezza in caso di riavvio) il ripristino è
 * incondizionato.
 */
export type UndoStep =
  | {
      type: "restore_post";
      post_type: string;
      id: number;
      fields: PostFields;
      written?: PostFields;
      replacements?: Array<{ find: string; replace: string }>;
    }
  | { type: "trash_post"; post_type: string; id: number }
  | {
      type: "restore_price";
      product_id: number;
      regular_price: string;
      sale_price: string;
      written?: { regular_price: string; sale_price: string };
    };

export interface UndoOptions {
  /** Rimette com'era anche se la pagina è stata modificata nel frattempo. */
  force?: boolean;
  /** Controlla soltanto se il ripristino è possibile, senza scrivere nulla. */
  dryRun?: boolean;
}

/** Chiamata appena si sa come annullare un'operazione (per le modifiche: prima di scrivere). */
export type RecordUndo = (undo: UndoStep) => unknown;

/** Com'è il contenuto dopo l'operazione: visibile sul sito, in bozza, o tolto dal sito. */
export type Outcome = "online" | "bozza" | "offline";

/** Cosa controllare sulla pagina pubblica per sapere se la modifica si vede davvero. */
export interface PublicCheck {
  url: string;
  /** Testi che devono comparire nella pagina. */
  present: string[];
  /** Testi che non devono più comparire. */
  absent: string[];
  /** true se la pagina non deve più essere raggiungibile. */
  gone?: boolean;
}

export type PublicCheckResult = "visibile" | "non_visibile" | "non_verificabile";

export interface AppliedOperation {
  description: string;
  url: string;
  undo: UndoStep;
  outcome: Outcome;
  check?: PublicCheck;
}

export class WordPressError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "WordPressError";
  }
}

/** Il contenuto è stato modificato dopo la nostra modifica: il ripristino lo sovrascriverebbe. */
export class UndoConflictError extends WordPressError {
  constructor(message: string) {
    super(message);
    this.name = "UndoConflictError";
  }
}

/** Contenuti più lunghi di così vengono troncati quando li mostriamo all'AI. */
const MAX_CONTENT_CHARS = 60_000;

export class WordPressClient {
  private readonly fetchFn: typeof fetch;
  private readonly auth: string;
  private restBases?: Map<string, string>;

  constructor(private readonly opts: WordPressOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.auth = "Basic " + Buffer.from(`${opts.user}:${opts.appPassword.replace(/\s+/g, "")}`).toString("base64");
  }

  get postTypes(): string[] {
    return this.opts.postTypes;
  }

  get woocommerceEnabled(): boolean {
    return this.opts.woocommerce;
  }

  // ---------------------------------------------------------------- HTTP

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.opts.url}/wp-json${path}`, {
      method,
      headers: {
        Authorization: this.auth,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      // risposta non JSON (es. pagina di errore del server)
    }
    if (!res.ok) {
      const msg =
        (data && typeof data === "object" && "message" in data && String((data as { message: unknown }).message)) ||
        text.slice(0, 200) ||
        res.statusText;
      throw new WordPressError(`WordPress ${method} ${path} → ${res.status}: ${msg}`, res.status);
    }
    return data as T;
  }

  /** Mappa slug del tipo di contenuto → rest_base (es. post → posts). */
  private async restBase(postType: string): Promise<string> {
    if (!this.opts.postTypes.includes(postType)) {
      throw new WordPressError(
        `Il tipo di contenuto "${postType}" non è tra quelli consentiti (${this.opts.postTypes.join(", ")})`,
      );
    }
    if (!this.restBases) {
      const types = await this.request<Record<string, { slug: string; rest_base: string }>>("GET", "/wp/v2/types");
      this.restBases = new Map(Object.values(types).map((t) => [t.slug, t.rest_base || t.slug]));
    }
    const base = this.restBases.get(postType);
    if (!base) throw new WordPressError(`Tipo di contenuto "${postType}" non trovato sul sito`);
    return base;
  }

  // ---------------------------------------------------------------- controllo

  /**
   * Verifica che il bot riesca a lavorare su questo sito, senza modificare
   * nulla: accesso, permessi, tipi di contenuto, campi ACF, WooCommerce.
   */
  async checkConnection(): Promise<SiteCheck> {
    const result: SiteCheck = {
      ok: false,
      problems: [],
      availableTypes: [],
      missingTypes: [],
      acfVisible: false,
      woocommerce: false,
    };

    let me: { name?: string; roles?: string[]; capabilities?: Record<string, boolean> };
    try {
      me = await this.request("GET", "/wp/v2/users/me?context=edit");
    } catch (err) {
      const status = err instanceof WordPressError ? err.status : undefined;
      result.problems.push(
        status === 401 || status === 403
          ? "Accesso rifiutato: utente o password applicazione non corretti."
          : status === 404
            ? "Il sito non espone la REST API di WordPress (wp-json): controlla l'indirizzo o i plugin di sicurezza."
            : `Sito non raggiungibile: ${err instanceof Error ? err.message : String(err)}`,
      );
      return result;
    }
    result.user = { name: me.name ?? this.opts.user, roles: me.roles ?? [] };
    if (me.capabilities && !me.capabilities.edit_others_posts && !me.capabilities.edit_others_pages) {
      result.problems.push("L'utente non può modificare i contenuti degli altri: serve almeno il ruolo Editor.");
    }

    try {
      const types = await this.request<Record<string, { slug: string; name: string; rest_base: string; viewable?: boolean }>>(
        "GET",
        "/wp/v2/types?context=edit",
      );
      const hidden = new Set(["attachment", "nav_menu_item", "wp_block", "wp_template", "wp_template_part", "wp_navigation", "wp_global_styles", "wp_font_family", "wp_font_face"]);
      result.availableTypes = Object.values(types)
        .filter((t) => !hidden.has(t.slug))
        .map((t) => ({ slug: t.slug, name: t.name }));
      const slugs = new Set(Object.keys(types));
      result.missingTypes = this.opts.postTypes.filter((t) => !slugs.has(t));
      if (result.missingTypes.length) {
        result.problems.push(`Tipi di contenuto non trovati sul sito: ${result.missingTypes.join(", ")}.`);
      }
      this.restBases = new Map(Object.values(types).map((t) => [t.slug, t.rest_base || t.slug]));
    } catch (err) {
      result.problems.push(`Non riesco a leggere i tipi di contenuto: ${err instanceof Error ? err.message : String(err)}`);
    }

    // ACF: se è attivo "Show in REST API", ogni contenuto ha la chiave "acf".
    const firstType = this.opts.postTypes.find((t) => !result.missingTypes.includes(t));
    if (firstType && this.restBases?.has(firstType)) {
      try {
        const items = await this.request<Array<{ acf?: unknown }>>(
          "GET",
          `/wp/v2/${this.restBases.get(firstType)}?per_page=1&context=edit&status=any`,
        );
        result.acfVisible = items.some((i) => i.acf !== undefined);
      } catch {
        // non determinante
      }
    }

    try {
      await this.request("GET", "/wc/v3/system_status?_fields=environment");
      result.woocommerce = true;
    } catch {
      result.woocommerce = false;
    }
    if (this.opts.woocommerce && !result.woocommerce) {
      result.problems.push("WooCommerce è attivato nelle impostazioni ma sul sito non risponde (o l'utente non ha i permessi).");
    }

    result.ok = result.problems.length === 0;
    return result;
  }

  // ---------------------------------------------------------------- lettura

  async search(query: string, perPage = 10): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      search: query,
      per_page: String(perPage),
      type: "post",
      subtype: this.opts.postTypes.join(","),
    });
    const results = await this.request<Array<{ id: number; title: string; url: string; subtype: string }>>(
      "GET",
      `/wp/v2/search?${params}`,
    );
    return results.map((r) => ({ id: r.id, title: r.title, url: r.url, post_type: r.subtype }));
  }

  async getContent(postType: string, id: number): Promise<ContentDetails> {
    const base = await this.restBase(postType);
    const p = await this.request<WpPost>("GET", `/wp/v2/${base}/${id}?context=edit`);
    return toContentDetails(p, postType);
  }

  /**
   * Cerca in quali contenuti compare esattamente un testo (es. "650€"): serve a
   * trovare lo stesso dato ripetuto in home, elenchi, altre lingue.
   */
  async findOccurrences(text: string, limit = 10): Promise<Occurrence[]> {
    const needle = text.trim().toLowerCase();
    if (needle.length < 2) throw new WordPressError("Testo da cercare troppo corto");
    const results = await this.search(text, limit);
    const out: Occurrence[] = [];
    for (const r of results) {
      let c: ContentDetails;
      try {
        c = await this.getContent(r.post_type, r.id);
      } catch {
        continue;
      }
      const matches: Occurrence["matches"] = [];
      const scan = (where: string, value: unknown) => {
        if (typeof value !== "string" && typeof value !== "number") return;
        const hay = String(value);
        let from = 0;
        for (let n = 0; n < 3; n++) {
          const i = hay.toLowerCase().indexOf(needle, from);
          if (i === -1) break;
          matches.push({ where, snippet: hay.slice(Math.max(0, i - 80), i + needle.length + 80) });
          from = i + needle.length;
        }
      };
      scan("title", c.title);
      scan("excerpt", c.excerpt);
      scan("content", c.content);
      for (const [name, value] of Object.entries(c.acf ?? {})) scan(`acf.${name}`, value);
      if (matches.length) {
        out.push({ id: c.id, post_type: c.post_type, title: c.title, url: c.url, status: c.status, matches });
      }
    }
    return out;
  }

  async searchProducts(query: string): Promise<ProductDetails[]> {
    this.ensureWoo();
    const params = new URLSearchParams({ search: query, per_page: "10" });
    const products = await this.request<WcProduct[]>("GET", `/wc/v3/products?${params}`);
    return products.map(toProductDetails);
  }

  async getProduct(id: number): Promise<ProductDetails> {
    this.ensureWoo();
    return toProductDetails(await this.request<WcProduct>("GET", `/wc/v3/products/${id}`));
  }

  /** Versione del contenuto adatta a essere passata all'AI (troncata se enorme). */
  static forModel(c: ContentDetails): ContentDetails & { truncated?: boolean } {
    if (c.content.length <= MAX_CONTENT_CHARS) return c;
    return { ...c, content: c.content.slice(0, MAX_CONTENT_CHARS), truncated: true };
  }

  /**
   * Apre la pagina pubblica, come farebbe un visitatore, e controlla se la
   * modifica si vede. Se c'è una cache può comparire ancora la versione vecchia.
   */
  async verifyPublic(check: PublicCheck): Promise<PublicCheckResult> {
    if (!check.gone && check.present.length === 0 && check.absent.length === 0) return "non_verificabile";
    let res: Response;
    try {
      res = await this.fetchFn(check.url, {
        headers: { Accept: "text/html" },
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      return "non_verificabile";
    }
    if (check.gone) {
      if (res.status === 404 || res.status === 410) return "visibile";
      return res.ok ? "non_visibile" : "non_verificabile";
    }
    if (!res.ok) return "non_verificabile";
    const page = normalizeText(await res.text());
    const ok =
      check.present.every((t) => page.includes(normalizeText(t))) &&
      check.absent.every((t) => !page.includes(normalizeText(t)));
    return ok ? "visibile" : "non_visibile";
  }

  /**
   * Descrive cosa cambierebbe un'operazione, senza applicarla: per ogni punto
   * modificato il testo di prima e quello di dopo, in forma leggibile.
   */
  async preview(op: Operation): Promise<ChangePreview> {
    if (op.type === "create_post") {
      const changes = [
        { field: "Titolo", before: "", after: op.title },
        { field: "Testo", before: "", after: clip(plainText(op.content)) },
      ];
      if (op.excerpt) changes.push({ field: "Riassunto", before: "", after: op.excerpt });
      for (const f of op.acf ?? []) changes.push({ field: `Campo «${f.field}»`, before: "", after: f.value });
      changes.push({ field: "Stato", before: "", after: STATUS_LABEL[op.status] ?? op.status });
      return { kind: "nuovo", title: op.title, url: "", changes };
    }
    if (op.type === "update_product_price") {
      const product = await this.getProduct(op.product_id);
      const changes: ChangePreview["changes"] = [];
      if (op.regular_price !== undefined) {
        changes.push({ field: "Prezzo", before: product.regular_price, after: op.regular_price });
      }
      if (op.sale_price !== undefined) {
        changes.push({ field: "Prezzo in offerta", before: product.sale_price, after: op.sale_price });
      }
      return { kind: "prezzo", title: product.name, url: product.url, changes };
    }

    const current = await this.getContent(op.post_type, op.id);
    const changes: ChangePreview["changes"] = [];
    if (op.title !== undefined) changes.push({ field: "Titolo", before: current.title, after: op.title });
    if (op.status !== undefined) {
      changes.push({
        field: "Stato",
        before: STATUS_LABEL[current.status] ?? current.status,
        after: STATUS_LABEL[op.status] ?? op.status,
      });
    }
    if (op.excerpt !== undefined) changes.push({ field: "Riassunto", before: current.excerpt, after: op.excerpt });
    if (op.content !== undefined) {
      changes.push({ field: "Testo", before: clip(plainText(current.content)), after: clip(plainText(op.content)) });
    }
    // Per ogni sostituzione mostro il blocco di testo in cui cade, prima e dopo.
    let working = op.content ?? current.content;
    for (const r of op.content_replacements ?? []) {
      const at = working.indexOf(r.find);
      if (at === -1) continue;
      const blockStart = working.lastIndexOf("\n\n", at);
      const start = Math.max(blockStart === -1 ? 0 : blockStart + 2, at - 400);
      const blockEnd = working.indexOf("\n\n", at + r.find.length);
      const end = Math.min(blockEnd === -1 ? working.length : blockEnd, at + r.find.length + 400);
      const block = working.slice(start, end);
      changes.push({
        field: "Testo",
        before: clip(plainText(block)),
        after: clip(plainText(block.replace(r.find, () => r.replace))),
      });
      working = working.slice(0, at) + r.replace + working.slice(at + r.find.length);
    }
    for (const f of op.acf ?? []) {
      const before = current.acf?.[f.field];
      changes.push({
        field: `Campo «${f.field}»`,
        before: before === undefined || before === null ? "" : String(before),
        after: f.value,
      });
    }
    return { kind: "modifica", title: current.title, url: current.url, changes };
  }

  // ---------------------------------------------------------------- scrittura

  /** Controlla che l'operazione sia applicabile, senza modificare nulla. */
  async validate(op: Operation): Promise<void> {
    switch (op.type) {
      case "update_post": {
        const current = await this.getContent(op.post_type, op.id);
        applyReplacements(op.content ?? current.content, op.content_replacements ?? []);
        return;
      }
      case "create_post":
        await this.restBase(op.post_type);
        return;
      case "update_product_price":
        await this.getProduct(op.product_id);
        return;
    }
  }

  async apply(op: Operation, record?: RecordUndo): Promise<AppliedOperation> {
    switch (op.type) {
      case "update_post":
        return this.applyUpdatePost(op, record);
      case "create_post":
        return this.applyCreatePost(op, record);
      case "update_product_price":
        return this.applyUpdatePrice(op, record);
    }
  }

  /**
   * Annulla un'operazione. Se il contenuto è stato modificato dopo la nostra
   * modifica, annulla solo la parte che avevamo cambiato noi; se non è
   * possibile lancia UndoConflictError (a meno di `force`).
   */
  async undo(step: UndoStep, opts: UndoOptions = {}): Promise<void> {
    switch (step.type) {
      case "restore_post":
        return this.undoRestorePost(step, opts);
      case "trash_post": {
        if (opts.dryRun) return;
        const base = await this.restBase(step.post_type);
        // senza force=true il contenuto va nel cestino (recuperabile da WordPress)
        await this.request("DELETE", `/wp/v2/${base}/${step.id}`);
        return;
      }
      case "restore_price": {
        this.ensureWoo();
        const previous = { regular_price: step.regular_price, sale_price: step.sale_price };
        if (step.written && !opts.force) {
          const current = await this.getProduct(step.product_id);
          const now = { regular_price: current.regular_price, sale_price: current.sale_price };
          if (same(now, previous)) return;
          if (!same(now, step.written)) {
            throw new UndoConflictError(`il prezzo di "${current.name}" è stato cambiato di nuovo dopo la mia modifica`);
          }
        }
        if (opts.dryRun) return;
        await this.request("PUT", `/wc/v3/products/${step.product_id}`, previous);
        return;
      }
    }
  }

  private async undoRestorePost(step: Extract<UndoStep, { type: "restore_post" }>, opts: UndoOptions): Promise<void> {
    const base = await this.restBase(step.post_type);
    const unconditional = opts.force || !step.written;
    let body: PostFields = {};

    if (unconditional) {
      body = step.fields;
    } else {
      const current = await this.getContent(step.post_type, step.id);
      const written = step.written!;
      const conflicts: string[] = [];

      for (const key of ["title", "excerpt", "status", "content"] as const) {
        if (!(key in step.fields)) continue;
        const prev = step.fields[key];
        const cur = current[key];
        if (cur === prev) continue; // già com'era
        if (written[key] === undefined || cur === written[key]) {
          body[key] = prev;
          continue;
        }
        if (key === "content" && step.replacements?.length) {
          // La pagina è cambiata altrove: tolgo solo i pezzi che avevo messo io.
          try {
            const inverse = [...step.replacements].reverse().map((r) => ({ find: r.replace, replace: r.find }));
            body.content = applyReplacements(cur, inverse);
            continue;
          } catch {
            // il mio testo non c'è più o non è univoco: è un conflitto vero
          }
        }
        conflicts.push(FIELD_LABEL[key]);
      }

      for (const [name, prev] of Object.entries(step.fields.acf ?? {})) {
        const cur = current.acf?.[name] ?? "";
        if (same(cur, prev)) continue;
        const wr = written.acf?.[name];
        if (wr === undefined || same(cur, wr)) {
          body.acf = { ...(body.acf ?? {}), [name]: prev };
          continue;
        }
        conflicts.push(`il campo "${name}"`);
      }

      if (conflicts.length) {
        throw new UndoConflictError(
          `"${current.title}" è stata modificata dopo la mia modifica (${conflicts.join(", ")})`,
        );
      }
    }

    if (opts.dryRun || Object.keys(body).length === 0) return;
    await this.request("POST", `/wp/v2/${base}/${step.id}`, body);
  }

  private async applyUpdatePost(op: UpdatePostOp, record?: RecordUndo): Promise<AppliedOperation> {
    const base = await this.restBase(op.post_type);
    const current = await this.getContent(op.post_type, op.id);

    const update: PostFields = {};
    const previous: PostFields = {};

    if (op.title !== undefined) {
      update.title = op.title;
      previous.title = current.title;
    }
    if (op.excerpt !== undefined) {
      update.excerpt = op.excerpt;
      previous.excerpt = current.excerpt;
    }
    if (op.status !== undefined) {
      update.status = op.status;
      previous.status = current.status;
    }
    const replacements = op.content_replacements ?? [];
    if (op.content !== undefined || replacements.length) {
      update.content = applyReplacements(op.content ?? current.content, replacements);
      previous.content = current.content;
    }
    if (op.acf?.length) {
      update.acf = Object.fromEntries(op.acf.map((f) => [f.field, f.value]));
      previous.acf = Object.fromEntries(op.acf.map((f) => [f.field, current.acf?.[f.field] ?? ""]));
    }
    if (Object.keys(update).length === 0) {
      throw new WordPressError(`Nessuna modifica indicata per ${op.post_type} #${op.id}`);
    }

    const undo: Extract<UndoStep, { type: "restore_post" }> = {
      type: "restore_post",
      post_type: op.post_type,
      id: op.id,
      fields: previous,
      // le sostituzioni si possono invertire solo se partivano dal contenuto esistente
      ...(op.content === undefined && replacements.length ? { replacements } : {}),
    };
    await record?.(undo);

    const updated = toContentDetails(await this.request<WpPost>("POST", `/wp/v2/${base}/${op.id}`, update), op.post_type);

    const written: PostFields = {};
    for (const key of ["title", "excerpt", "status", "content"] as const) {
      if (key in previous) written[key] = updated[key];
    }
    if (previous.acf && updated.acf) {
      written.acf = Object.fromEntries(Object.keys(previous.acf).map((name) => [name, updated.acf![name]]));
    }

    const url = updated.url || current.url;
    const wasLive = current.status === "publish";
    const isLive = updated.status === "publish";
    const outcome: Outcome = isLive ? "online" : wasLive ? "offline" : "bozza";

    let check: PublicCheck | undefined;
    if (outcome === "offline") {
      check = { url: current.url, present: [], absent: [], gone: true };
    } else if (outcome === "online") {
      const present: string[] = [];
      const absent: string[] = [];
      if (op.title !== undefined) present.push(op.title);
      for (const r of replacements) {
        const added = normalizeText(r.replace);
        const removed = normalizeText(r.find);
        if (added.length >= 2) present.push(r.replace);
        else if (removed.length >= 4) absent.push(r.find);
      }
      check = { url, present, absent };
    }

    return {
      description: `Aggiornato "${updated.title || current.title}" (${Object.keys(update).join(", ")})`,
      url,
      undo: { ...undo, written },
      outcome,
      check,
    };
  }

  private async applyCreatePost(op: CreatePostOp, record?: RecordUndo): Promise<AppliedOperation> {
    const base = await this.restBase(op.post_type);
    const body: Record<string, unknown> = {
      title: op.title,
      content: op.content,
      status: op.status,
    };
    if (op.excerpt !== undefined) body.excerpt = op.excerpt;
    if (op.acf?.length) body.acf = Object.fromEntries(op.acf.map((f) => [f.field, f.value]));

    const created = await this.request<WpPost>("POST", `/wp/v2/${base}`, body);
    const undo: UndoStep = { type: "trash_post", post_type: op.post_type, id: created.id };
    await record?.(undo);
    const url = created.link ?? `${this.opts.url}/?p=${created.id}`;
    const live = created.status === "publish";
    return {
      description: `Creato "${op.title}" (${live ? "pubblicato" : "bozza"})`,
      url,
      undo,
      outcome: live ? "online" : "bozza",
      check: live ? { url, present: [op.title], absent: [] } : undefined,
    };
  }

  private async applyUpdatePrice(op: UpdateProductPriceOp, record?: RecordUndo): Promise<AppliedOperation> {
    const current = await this.getProduct(op.product_id);
    const body: Record<string, string> = {};
    if (op.regular_price !== undefined) body.regular_price = op.regular_price;
    if (op.sale_price !== undefined) body.sale_price = op.sale_price;
    if (Object.keys(body).length === 0) {
      throw new WordPressError(`Nessun prezzo indicato per il prodotto #${op.product_id}`);
    }
    const undo: Extract<UndoStep, { type: "restore_price" }> = {
      type: "restore_price",
      product_id: op.product_id,
      regular_price: current.regular_price,
      sale_price: current.sale_price,
    };
    await record?.(undo);
    const updated = toProductDetails(await this.request<WcProduct>("PUT", `/wc/v3/products/${op.product_id}`, body));
    return {
      description: `Prezzo di "${updated.name}": ${formatPrice(current)} → ${formatPrice(updated)}`,
      url: updated.url,
      undo: { ...undo, written: { regular_price: updated.regular_price, sale_price: updated.sale_price } },
      outcome: updated.status === "publish" ? "online" : "bozza",
    };
  }

  private ensureWoo(): void {
    if (!this.opts.woocommerce) {
      throw new WordPressError("WooCommerce non è abilitato (WP_WOOCOMMERCE=true)");
    }
  }
}

// ------------------------------------------------------------------ helper

interface WpPost {
  id: number;
  link?: string;
  status: string;
  modified?: string;
  title: { raw?: string; rendered?: string } | string;
  content?: { raw?: string; rendered?: string };
  excerpt?: { raw?: string; rendered?: string };
  acf?: Record<string, unknown> | unknown[];
}

interface WcProduct {
  id: number;
  name: string;
  permalink: string;
  status: string;
  regular_price: string;
  sale_price: string;
}

const STATUS_LABEL: Record<string, string> = {
  publish: "pubblicato",
  draft: "bozza",
  private: "privato",
  pending: "in revisione",
  future: "programmato",
};

function clip(text: string, max = 600): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const FIELD_LABEL = {
  title: "il titolo",
  excerpt: "il riassunto",
  status: "lo stato",
  content: "il testo",
} as const;

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function rendered(field: WpPost["title"] | undefined): string {
  if (!field) return "";
  if (typeof field === "string") return field;
  return field.raw ?? field.rendered ?? "";
}

function toContentDetails(p: WpPost, postType: string): ContentDetails {
  return {
    id: p.id,
    post_type: postType,
    title: rendered(p.title),
    status: p.status,
    url: p.link ?? "",
    excerpt: p.excerpt?.raw ?? p.excerpt?.rendered ?? "",
    content: p.content?.raw ?? p.content?.rendered ?? "",
    // ACF restituisce [] quando non ci sono campi
    acf: p.acf && !Array.isArray(p.acf) ? p.acf : undefined,
    modified: p.modified,
  };
}

function toProductDetails(p: WcProduct): ProductDetails {
  return {
    id: p.id,
    name: p.name,
    url: p.permalink,
    status: p.status,
    regular_price: p.regular_price,
    sale_price: p.sale_price,
  };
}

function formatPrice(p: ProductDetails): string {
  if (p.sale_price) return `${p.sale_price}€ (invece di ${p.regular_price}€)`;
  return p.regular_price ? `${p.regular_price}€` : "nessun prezzo";
}

/**
 * Applica le sostituzioni di testo. Ogni testo da cercare deve comparire
 * esattamente una volta: se manca o è ambiguo è meglio fermarsi che
 * modificare la parte sbagliata della pagina.
 */
export function applyReplacements(content: string, replacements: Array<{ find: string; replace: string }>): string {
  let result = content;
  for (const { find, replace } of replacements) {
    if (!find) throw new WordPressError("Testo da cercare vuoto");
    const first = result.indexOf(find);
    if (first === -1) {
      throw new WordPressError(`Testo non trovato nella pagina: "${truncate(find)}"`);
    }
    if (result.indexOf(find, first + find.length) !== -1) {
      throw new WordPressError(`Il testo "${truncate(find)}" compare più volte: serve un riferimento più preciso`);
    }
    result = result.slice(0, first) + replace + result.slice(first + find.length);
  }
  return result;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "€",
  rsquo: "'",
  lsquo: "'",
  ldquo: '"',
  rdquo: '"',
  ndash: "-",
  mdash: "-",
  hellip: "...",
  agrave: "à",
  egrave: "è",
  eacute: "é",
  igrave: "ì",
  ograve: "ò",
  ugrave: "ù",
};

function codePoint(n: number, fallback: string): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

/** Toglie markup e commenti da un pezzo di HTML e ne restituisce il testo leggibile. */
export function plainText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (m, n: string) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => codePoint(parseInt(n, 16), m))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .trim();
}

/**
 * Riduce HTML o testo a parole confrontabili: via tag e commenti, entità
 * decodificate, virgolette e trattini tipografici uniformati, spazi compressi.
 */
export function normalizeText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (m, n: string) => codePoint(Number(n), m))
    .replace(/&#x([0-9a-f]+);/gi, (m, n: string) => codePoint(parseInt(n, 16), m))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
