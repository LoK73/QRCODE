/**
 * Un finto sito WordPress in memoria (un'agenzia di viaggi con otto contenuti)
 * su cui far lavorare l'AI durante le prove, senza toccare nessun sito vero.
 */

export interface FixturePage {
  id: number;
  type: "page" | "post";
  slug: string;
  status: string;
  title: string;
  content: string;
  excerpt: string;
  acf: Record<string, unknown>;
}

const p = (text: string) => `<!-- wp:paragraph -->\n<p>${text}</p>\n<!-- /wp:paragraph -->`;

export function fixturePages(): FixturePage[] {
  return [
    {
      id: 101, type: "page", slug: "tour-parigi-maggio", status: "publish", title: "Tour di Parigi – Maggio", excerpt: "",
      content: [p("Quattro giorni a Parigi con volo da Milano, hotel 3 stelle in centro e visita guidata al Louvre."), p("Partenza: 15 maggio. Quota a persona: <strong>650€</strong>")].join("\n\n"),
      acf: { prezzo: "650", data_partenza: "2027-05-15" },
    },
    {
      id: 102, type: "page", slug: "tour-parigi-giugno", status: "publish", title: "Tour di Parigi – Giugno", excerpt: "",
      content: [p("Quattro giorni a Parigi con volo da Milano e crociera sulla Senna."), p("Partenza: 12 giugno. Quota a persona: <strong>690€</strong>")].join("\n\n"),
      acf: { prezzo: "690", data_partenza: "2027-06-12" },
    },
    {
      id: 103, type: "page", slug: "crociera-isole-greche", status: "publish", title: "Crociera nelle isole greche", excerpt: "",
      content: [p("Sette notti tra Santorini, Mykonos e Creta in cabina esterna."), p("Quota a persona: <strong>1.290€</strong>, tasse portuali incluse.")].join("\n\n"),
      acf: { prezzo: "1290" },
    },
    {
      id: 104, type: "page", slug: "weekend-vienna", status: "publish", title: "Weekend a Vienna", excerpt: "",
      content: [p("Tre notti a Vienna con volo da Bergamo e hotel 4 stelle vicino al Ring."), p("Quota a persona: <strong>349€</strong>")].join("\n\n"),
      acf: { prezzo: "349" },
    },
    {
      id: 105, type: "page", slug: "offerte-del-mese", status: "publish", title: "Offerte del mese", excerpt: "",
      content: [
        p("Le nostre proposte in evidenza:"),
        "<!-- wp:list -->\n<ul><li>Tour di Parigi – Maggio, da 650€</li><li>Weekend a Vienna, da 349€</li><li>Crociera nelle isole greche, da 1.290€</li></ul>\n<!-- /wp:list -->",
      ].join("\n\n"),
      acf: {},
    },
    {
      id: 106, type: "page", slug: "contatti", status: "publish", title: "Contatti", excerpt: "",
      content: [p("Siamo in via Roma 12, Milano. Telefono: 02 1234567"), p("Orari: dal lunedì al venerdì 9:00–18:00, sabato 9:00–13:00.")].join("\n\n"),
      acf: {},
    },
    {
      id: 107, type: "post", slug: "capodanno-lisbona", status: "publish", title: "Capodanno a Lisbona", excerpt: "Quattro notti con cenone incluso.",
      content: [p("Dal 29 dicembre al 2 gennaio, volo da Malpensa e cenone di capodanno incluso."), p("Quota a persona: <strong>890€</strong>")].join("\n\n"),
      acf: { prezzo: "890" },
    },
    {
      id: 108, type: "page", slug: "chi-siamo", status: "publish", title: "Chi siamo", excerpt: "",
      content: p("Organizziamo viaggi di gruppo dal 1998, con accompagnatore dall'Italia."),
      acf: {},
    },
  ];
}

const SITE = "https://sito-di-prova.example";
const BASES = { page: "pages", post: "posts" } as const;

/** Restituisce un `fetch` che risponde come la REST API di WordPress per le pagine indicate. */
export function fixtureFetch(pages: FixturePage[] = fixturePages()): typeof fetch {
  const toJson = (pg: FixturePage) => ({
    id: pg.id,
    link: `${SITE}/${pg.slug}`,
    status: pg.status,
    title: { raw: pg.title },
    content: { raw: pg.content },
    excerpt: { raw: pg.excerpt },
    acf: pg.acf,
  });
  let nextId = 900;

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    // Pagina pubblica, come la vede un visitatore: serve alla verifica dopo la pubblicazione.
    if (!url.pathname.startsWith("/wp-json")) {
      const pg = pages.find((x) => `/${x.slug}` === url.pathname.replace(/\/$/, "") && x.status === "publish");
      if (!pg) return new Response("<h1>Pagina non trovata</h1>", { status: 404 });
      return new Response(`<html><body><h1>${pg.title}</h1>${pg.content}</body></html>`, { headers: { "Content-Type": "text/html" } });
    }
    const path = url.pathname.replace("/wp-json", "");

    if (path === "/wp/v2/types") {
      return Response.json({
        page: { slug: "page", name: "Pagine", rest_base: "pages" },
        post: { slug: "post", name: "Articoli", rest_base: "posts" },
      });
    }
    if (path === "/wp/v2/users/me") {
      return Response.json({ name: "Bot di prova", roles: ["editor"], capabilities: { edit_others_posts: true, edit_others_pages: true } });
    }
    const list = path.match(/^\/wp\/v2\/(pages|posts)$/);
    if (list && method === "GET") {
      return Response.json(pages.filter((pg) => BASES[pg.type] === list[1]).slice(0, 1).map(toJson));
    }
    if (path === "/wp/v2/search") {
      const words = (url.searchParams.get("search") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const found = pages.filter((pg) => {
        const hay = `${pg.title} ${pg.content} ${pg.excerpt}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
      return Response.json(found.slice(0, 10).map((pg) => ({ id: pg.id, title: pg.title, url: `${SITE}/${pg.slug}`, subtype: pg.type })));
    }
    const item = path.match(/^\/wp\/v2\/(pages|posts)\/(\d+)$/);
    if (item) {
      const pg = pages.find((x) => x.id === Number(item[2]) && BASES[x.type] === item[1]);
      if (!pg) return Response.json({ message: "ID articolo non valido." }, { status: 404 });
      if (method === "POST" && body) {
        const { acf, ...rest } = body as { acf?: Record<string, unknown> };
        Object.assign(pg, rest);
        if (acf) pg.acf = { ...pg.acf, ...acf };
      }
      return Response.json(toJson(pg));
    }
    const collection = path.match(/^\/wp\/v2\/(pages|posts)$/);
    if (collection && method === "POST" && body) {
      const pg: FixturePage = {
        id: nextId++,
        type: collection[1] === "pages" ? "page" : "post",
        slug: `nuovo-${nextId}`,
        status: String(body.status ?? "draft"),
        title: String(body.title ?? ""),
        content: String(body.content ?? ""),
        excerpt: String(body.excerpt ?? ""),
        acf: (body.acf as Record<string, unknown>) ?? {},
      };
      pages.push(pg);
      return Response.json(toJson(pg));
    }
    return Response.json({ message: "Nessun percorso corrisponde." }, { status: 404 });
  }) as typeof fetch;
}

export const FIXTURE_SITE_URL = SITE;
