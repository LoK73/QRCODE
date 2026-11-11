import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyReplacements,
  normalizeText,
  UndoConflictError,
  WordPressClient,
  type UndoStep,
} from "../src/wordpress.js";

const ORIGINAL = "<p>Da <strong>650€</strong> a persona</p><p>Partenza da Milano</p>";

/** Un finto WordPress con una pagina (id 42) che si può leggere, modificare e guardare da fuori. */
function fakeWp() {
  const post = {
    id: 42,
    link: "https://agenzia.example/parigi",
    status: "publish",
    title: "Tour di Parigi",
    content: ORIGINAL,
    excerpt: "",
    acf: { prezzo: "650" } as Record<string, unknown>,
  };
  const state = { publicHtml: undefined as string | undefined, publicStatus: 200, trashed: [] as number[] };
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown> }> = [];
  const json = () => ({
    id: post.id,
    link: post.link,
    status: post.status,
    title: { raw: post.title },
    content: { raw: post.content },
    excerpt: { raw: post.excerpt },
    acf: post.acf,
  });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, url, body });

    if (!url.includes("/wp-json")) {
      return new Response(state.publicHtml ?? `<html><body><h1>${post.title}</h1>${post.content}</body></html>`, {
        status: state.publicStatus,
      });
    }
    const path = url.replace("https://agenzia.example/wp-json", "");
    if (path === "/wp/v2/types") {
      return Response.json({ page: { slug: "page", rest_base: "pages" }, post: { slug: "post", rest_base: "posts" } });
    }
    if (path.startsWith("/wp/v2/search")) {
      return Response.json([{ id: 42, title: post.title, url: post.link, subtype: "page" }]);
    }
    if (path.startsWith("/wp/v2/pages/42")) {
      if (method === "POST" && body) {
        const { acf, ...rest } = body as { acf?: Record<string, unknown> };
        Object.assign(post, rest);
        if (acf) post.acf = { ...post.acf, ...acf };
      }
      return Response.json(json());
    }
    if (path === "/wp/v2/posts" && method === "POST" && body) {
      return Response.json({ id: 77, link: "https://agenzia.example/?p=77", status: body.status, title: { raw: body.title } });
    }
    if (path.startsWith("/wp/v2/posts/77") && method === "DELETE") {
      state.trashed.push(77);
      return Response.json({ id: 77, status: "trash" });
    }
    return Response.json({ message: "not found" }, { status: 404 });
  }) as typeof fetch;

  const wp = new WordPressClient({
    url: "https://agenzia.example",
    user: "bot",
    appPassword: "abcd efgh",
    postTypes: ["post", "page"],
    woocommerce: false,
    fetch: fetchFn,
  });
  const writes = () => calls.filter((c) => c.method === "POST" || c.method === "PUT").length;
  return { wp, post, state, calls, writes };
}

const PRICE_OP = {
  type: "update_post" as const,
  post_type: "page",
  id: 42,
  content_replacements: [{ find: "<strong>650€</strong>", replace: "<strong>590€</strong>" }],
  acf: [{ field: "prezzo", value: "590" }],
};

describe("WordPress: modifiche", () => {
  it("applica sostituzioni univoche e rifiuta quelle ambigue o mancanti", () => {
    assert.equal(applyReplacements("Prezzo: 650€", [{ find: "650€", replace: "590€" }]), "Prezzo: 590€");
    assert.throws(() => applyReplacements("650€ e 650€", [{ find: "650€", replace: "590€" }]), /più volte/);
    assert.throws(() => applyReplacements("Prezzo: 700€", [{ find: "650€", replace: "590€" }]), /non trovato/);
  });

  it("registra come annullare prima di scrivere e salva ciò che ha scritto", async () => {
    const { wp, post, writes } = fakeWp();
    const recorded: Array<{ step: UndoStep; writesSoFar: number }> = [];
    const applied = await wp.apply(PRICE_OP, (step) => recorded.push({ step, writesSoFar: writes() }));

    assert.equal(recorded.length, 1);
    assert.equal(recorded[0].writesSoFar, 0, "il ripristino va registrato prima di toccare il sito");
    assert.equal(post.content, "<p>Da <strong>590€</strong> a persona</p><p>Partenza da Milano</p>");
    assert.deepEqual(post.acf, { prezzo: "590" });
    assert.deepEqual(applied.undo, {
      type: "restore_post",
      post_type: "page",
      id: 42,
      fields: { content: ORIGINAL, acf: { prezzo: "650" } },
      replacements: PRICE_OP.content_replacements,
      written: { content: post.content, acf: { prezzo: "590" } },
    });
    assert.equal(applied.outcome, "online");
    assert.deepEqual(applied.check, {
      url: "https://agenzia.example/parigi",
      present: ["<strong>590€</strong>"],
      absent: [],
    });
  });

  it("crea una bozza e sa come cestinarla", async () => {
    const { wp, state } = fakeWp();
    const recorded: UndoStep[] = [];
    const applied = await wp.apply(
      { type: "create_post", post_type: "post", title: "Weekend a Vienna", content: "<p>3 notti</p>", status: "draft" },
      (s) => recorded.push(s),
    );
    assert.equal(applied.outcome, "bozza");
    assert.equal(applied.check, undefined);
    assert.deepEqual(recorded, [{ type: "trash_post", post_type: "post", id: 77 }]);
    await wp.undo(applied.undo);
    assert.deepEqual(state.trashed, [77]);
  });

  it("togliere una pagina dal sito è un esito 'offline' da verificare", async () => {
    const { wp } = fakeWp();
    const applied = await wp.apply({ type: "update_post", post_type: "page", id: 42, status: "draft" });
    assert.equal(applied.outcome, "offline");
    assert.deepEqual(applied.check, { url: "https://agenzia.example/parigi", present: [], absent: [], gone: true });
  });

  it("rifiuta i tipi di contenuto non consentiti", async () => {
    const { wp } = fakeWp();
    await assert.rejects(wp.getContent("product", 1), /non è tra quelli consentiti/);
  });

  it("restituisce errori leggibili da WordPress", async () => {
    const { wp } = fakeWp();
    await assert.rejects(wp.getContent("page", 999), /404: not found/);
  });
});

describe("WordPress: ripristino", () => {
  it("rimette com'era se nessuno ha toccato la pagina", async () => {
    const { wp, post } = fakeWp();
    const applied = await wp.apply(PRICE_OP);
    await wp.undo(applied.undo);
    assert.equal(post.content, ORIGINAL);
    assert.deepEqual(post.acf, { prezzo: "650" });
  });

  it("se la pagina è cambiata altrove annulla solo la propria parte", async () => {
    const { wp, post } = fakeWp();
    const applied = await wp.apply(PRICE_OP);
    post.content = post.content.replace("Milano", "Roma"); // modifica fatta a mano da qualcun altro
    await wp.undo(applied.undo);
    assert.equal(post.content, "<p>Da <strong>650€</strong> a persona</p><p>Partenza da Roma</p>");
  });

  it("si ferma se qualcuno ha cambiato proprio il dato modificato", async () => {
    const { wp, post, writes } = fakeWp();
    const applied = await wp.apply(PRICE_OP);
    post.content = post.content.replace("590€", "570€");
    post.acf = { prezzo: "570" };
    const before = writes();

    await assert.rejects(wp.undo(applied.undo, { dryRun: true }), UndoConflictError);
    await assert.rejects(wp.undo(applied.undo), /modificata dopo la mia modifica \(il testo, il campo "prezzo"\)/);
    assert.equal(writes(), before, "in caso di conflitto non scrive nulla");

    await wp.undo(applied.undo, { force: true });
    assert.equal(post.content, ORIGINAL);
    assert.deepEqual(post.acf, { prezzo: "650" });
  });

  it("non scrive nulla se la pagina è già com'era, né in modalità di sola verifica", async () => {
    const { wp, post, writes } = fakeWp();
    const applied = await wp.apply(PRICE_OP);
    const before = writes();
    await wp.undo(applied.undo, { dryRun: true });
    assert.equal(writes(), before);
    post.content = ORIGINAL;
    post.acf = { prezzo: "650" };
    await wp.undo(applied.undo);
    assert.equal(writes(), before);
  });

  it("un passo registrato prima della scrittura (riavvio a metà) viene ripristinato comunque", async () => {
    const { wp, post } = fakeWp();
    const recorded: UndoStep[] = [];
    await wp.apply(PRICE_OP, (s) => recorded.push(s));
    await wp.undo(recorded[0]);
    assert.equal(post.content, ORIGINAL);
  });
});

describe("WordPress: verifica della pagina pubblica", () => {
  const check = { url: "https://agenzia.example/parigi", present: ["<strong>590€</strong>"], absent: [] };

  it("riconosce la modifica anche con entità e markup diversi", async () => {
    const { wp, state } = fakeWp();
    state.publicHtml = "<html><body><p>Da <b>590&euro;</b>&nbsp;a persona</p></body></html>";
    assert.equal(await wp.verifyPublic(check), "visibile");
  });

  it("segnala quando la pagina pubblica mostra ancora la versione vecchia", async () => {
    const { wp, state } = fakeWp();
    state.publicHtml = "<html><body><p>Da <strong>650€</strong> a persona</p></body></html>";
    assert.equal(await wp.verifyPublic(check), "non_visibile");
  });

  it("non si pronuncia se la pagina non si apre o non c'è nulla da controllare", async () => {
    const { wp, state } = fakeWp();
    state.publicStatus = 500;
    assert.equal(await wp.verifyPublic(check), "non_verificabile");
    state.publicStatus = 200;
    assert.equal(await wp.verifyPublic({ url: check.url, present: [], absent: [] }), "non_verificabile");
  });

  it("per una pagina tolta dal sito controlla che non sia più raggiungibile", async () => {
    const { wp, state } = fakeWp();
    const gone = { url: check.url, present: [], absent: [], gone: true };
    assert.equal(await wp.verifyPublic(gone), "non_visibile");
    state.publicStatus = 404;
    assert.equal(await wp.verifyPublic(gone), "visibile");
  });

  it("normalizza il testo per il confronto", () => {
    assert.equal(normalizeText("L&#8217;offerta &ndash; <em>590</em>&nbsp;&euro; <!-- wp:x --><script>x()</script>"), "l'offerta - 590 €");
  });
});

describe("WordPress: stesso dato in più punti", () => {
  it("trova dove compare un testo, con un estratto", async () => {
    const { wp } = fakeWp();
    const exact = await wp.findOccurrences("650€");
    assert.equal(exact.length, 1);
    assert.deepEqual(
      exact[0].matches.map((m) => m.where),
      ["content"],
    );
    assert.match(exact[0].matches[0].snippet, /<strong>650€<\/strong>/);

    const loose = await wp.findOccurrences("650");
    assert.deepEqual(
      loose[0].matches.map((m) => m.where),
      ["content", "acf.prezzo"],
    );
  });

  it("non restituisce i contenuti in cui il testo non c'è", async () => {
    const { wp } = fakeWp();
    assert.deepEqual(await wp.findOccurrences("Lisbona"), []);
  });
});
