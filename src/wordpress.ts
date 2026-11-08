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

/** Come annullare un'operazione già applicata. */
export type UndoStep =
  | {
      type: "restore_post";
      post_type: string;
      id: number;
      fields: { title?: string; content?: string; excerpt?: string; status?: string; acf?: Record<string, unknown> };
    }
  | { type: "trash_post"; post_type: string; id: number }
  | { type: "restore_price"; product_id: number; regular_price: string; sale_price: string };

export interface AppliedOperation {
  description: string;
  url: string;
  undo: UndoStep;
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

  // ---------------------------------------------------------------- lettura

  async search(query: string): Promise<SearchResult[]> {
    const params = new URLSearchParams({
      search: query,
      per_page: "10",
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

  // ---------------------------------------------------------------- scrittura

  /** Controlla che l'operazione sia applicabile, senza modificare nulla. */
  async validate(op: Operation): Promise<void> {
    switch (op.type) {
      case "update_post": {
        const current = await this.getContent(op.post_type, op.id);
        applyReplacements(current.content, op.content_replacements ?? []);
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

  async apply(op: Operation): Promise<AppliedOperation> {
    switch (op.type) {
      case "update_post":
        return this.applyUpdatePost(op);
      case "create_post":
        return this.applyCreatePost(op);
      case "update_product_price":
        return this.applyUpdatePrice(op);
    }
  }

  async undo(step: UndoStep): Promise<void> {
    switch (step.type) {
      case "restore_post": {
        const base = await this.restBase(step.post_type);
        await this.request("POST", `/wp/v2/${base}/${step.id}`, step.fields);
        return;
      }
      case "trash_post": {
        const base = await this.restBase(step.post_type);
        // senza force=true il contenuto va nel cestino (recuperabile da WordPress)
        await this.request("DELETE", `/wp/v2/${base}/${step.id}`);
        return;
      }
      case "restore_price":
        this.ensureWoo();
        await this.request("PUT", `/wc/v3/products/${step.product_id}`, {
          regular_price: step.regular_price,
          sale_price: step.sale_price,
        });
        return;
    }
  }

  private async applyUpdatePost(op: UpdatePostOp): Promise<AppliedOperation> {
    const base = await this.restBase(op.post_type);
    const current = await this.getContent(op.post_type, op.id);

    const update: Record<string, unknown> = {};
    const previous: Extract<UndoStep, { type: "restore_post" }>["fields"] = {};

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
    if (op.content !== undefined || op.content_replacements?.length) {
      let content = op.content ?? current.content;
      content = applyReplacements(content, op.content_replacements ?? []);
      update.content = content;
      previous.content = current.content;
    }
    if (op.acf?.length) {
      update.acf = Object.fromEntries(op.acf.map((f) => [f.field, f.value]));
      previous.acf = Object.fromEntries(op.acf.map((f) => [f.field, current.acf?.[f.field] ?? ""]));
    }
    if (Object.keys(update).length === 0) {
      throw new WordPressError(`Nessuna modifica indicata per ${op.post_type} #${op.id}`);
    }

    const updated = await this.request<WpPost>("POST", `/wp/v2/${base}/${op.id}`, update);
    return {
      description: `Aggiornato "${rendered(updated.title) || current.title}" (${Object.keys(update).join(", ")})`,
      url: updated.link ?? current.url,
      undo: { type: "restore_post", post_type: op.post_type, id: op.id, fields: previous },
    };
  }

  private async applyCreatePost(op: CreatePostOp): Promise<AppliedOperation> {
    const base = await this.restBase(op.post_type);
    const body: Record<string, unknown> = {
      title: op.title,
      content: op.content,
      status: op.status,
    };
    if (op.excerpt !== undefined) body.excerpt = op.excerpt;
    if (op.acf?.length) body.acf = Object.fromEntries(op.acf.map((f) => [f.field, f.value]));

    const created = await this.request<WpPost>("POST", `/wp/v2/${base}`, body);
    return {
      description: `Creato "${op.title}" (${op.status === "draft" ? "bozza" : "pubblicato"})`,
      url: created.link ?? `${this.opts.url}/?p=${created.id}`,
      undo: { type: "trash_post", post_type: op.post_type, id: created.id },
    };
  }

  private async applyUpdatePrice(op: UpdateProductPriceOp): Promise<AppliedOperation> {
    const current = await this.getProduct(op.product_id);
    const body: Record<string, string> = {};
    if (op.regular_price !== undefined) body.regular_price = op.regular_price;
    if (op.sale_price !== undefined) body.sale_price = op.sale_price;
    if (Object.keys(body).length === 0) {
      throw new WordPressError(`Nessun prezzo indicato per il prodotto #${op.product_id}`);
    }
    const updated = toProductDetails(await this.request<WcProduct>("PUT", `/wc/v3/products/${op.product_id}`, body));
    return {
      description: `Prezzo di "${updated.name}": ${formatPrice(current)} → ${formatPrice(updated)}`,
      url: updated.url,
      undo: {
        type: "restore_price",
        product_id: op.product_id,
        regular_price: current.regular_price,
        sale_price: current.sale_price,
      },
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

function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
