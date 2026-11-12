"use server";

import { createClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { DEV_COOKIE, devAuth, requireSession, supabaseServer } from "./auth";
import { withUser } from "./db";
import { encryptSecret } from "./secrets";

/**
 * Tutte le scritture della dashboard. Ogni azione gira con i permessi
 * dell'utente: se non gli spetta, è il database a rifiutarla.
 */

const text = (form: FormData, name: string): string => String(form.get(name) ?? "").trim();
const flag = (form: FormData, name: string): boolean => form.get(name) === "on" || form.get(name) === "true";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(form: FormData, name: string): string {
  const value = text(form, name);
  if (!UUID.test(value)) throw new Error("Identificativo non valido");
  return value;
}

/** Messaggio leggibile per gli errori di permesso del database. */
function explain(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (/row-level security|permission denied|permessi/i.test(message)) return "Non hai i permessi per questa operazione.";
  if (/duplicate key/i.test(message)) return "Esiste già.";
  return message;
}

function back(path: string, notice: { ok?: string; errore?: string }): never {
  const params = new URLSearchParams(notice as Record<string, string>);
  redirect(`${path}${path.includes("?") ? "&" : "?"}${params}`);
}

// ------------------------------------------------------------------ accesso

export async function login(form: FormData): Promise<void> {
  if (devAuth()) {
    (await cookies()).set(DEV_COOKIE, text(form, "user"), { httpOnly: true, sameSite: "lax", path: "/" });
    redirect("/");
  }
  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithPassword({ email: text(form, "email"), password: String(form.get("password") ?? "") });
  if (error) back("/login", { errore: "Email o password non corretti." });
  redirect("/");
}

export async function logout(): Promise<void> {
  if (devAuth()) (await cookies()).delete(DEV_COOKIE);
  else await (await supabaseServer()).auth.signOut();
  redirect("/login");
}

// ------------------------------------------------------------------ commesse

const COMMESSA_ACTIONS = ["approva", "annulla", "ripristina", "ripristina_forza", "riprova"];

/** Chiede al bot di eseguire un'azione su una commessa: il bot la esegue e avvisa il gruppo. */
export async function requestAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = Number(text(form, "commessa"));
  const tipo = text(form, "tipo");
  // Si torna solo a una pagina interna della dashboard.
  const requested = text(form, "from");
  const from = /^\/(?!\/)[\w\-/?=&%.]*$/.test(requested) ? requested : `/commesse/${id}`;
  if (!Number.isInteger(id) || !COMMESSA_ACTIONS.includes(tipo)) back(from, { errore: "Richiesta non valida." });
  try {
    await withUser(session.userId, async (q) => {
      const [c] = await q("select client_id from commesse where id = $1", [id]);
      if (!c) throw new Error("Commessa non trovata.");
      const busy = await q("select 1 from azioni where commessa_id = $1 and stato in ('in_coda', 'in_corso')", [id]);
      if (busy.length) throw new Error("C'è già un'azione in corso su questa commessa.");
      await q("insert into azioni (client_id, commessa_id, tipo) values ($1, $2, $3)", [c.client_id, id, tipo]);
    });
  } catch (err) {
    back(from, { errore: explain(err) });
  }
  revalidatePath("/", "layout");
  back(from, { ok: "Richiesta inviata: il bot la esegue tra qualche secondo." });
}

// ------------------------------------------------------------------ clienti

export async function createClientAction(form: FormData): Promise<void> {
  const session = await requireSession();
  const name = text(form, "name");
  if (!name) back("/clienti/nuovo", { errore: "Serve il nome del cliente." });
  let id = "";
  try {
    id = await withUser(session.userId, async (q) => {
      const [row] = await q("insert into clients (name, sector) values ($1, $2) returning id", [name, text(form, "sector")]);
      return String(row.id);
    });
  } catch (err) {
    back("/clienti/nuovo", { errore: explain(err) });
  }
  revalidatePath("/clienti");
  redirect(`/clienti/${id}?ok=${encodeURIComponent("Cliente creato. Ora collega il sito e il gruppo WhatsApp.")}`);
}

export async function saveClient(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = uuid(form, "client");
  const path = `/clienti/${id}`;
  const ttl = Number(text(form, "proposal_ttl_hours"));
  const budget = Number(text(form, "monthly_budget_usd").replace(",", "."));
  if (!text(form, "name")) back(path, { errore: "Serve il nome del cliente." });
  if (!Number.isFinite(ttl) || ttl <= 0) back(path, { errore: "La scadenza delle proposte deve essere un numero di ore maggiore di zero." });
  if (!Number.isFinite(budget) || budget < 0) back(path, { errore: "Il tetto di spesa deve essere un numero (0 = nessun tetto)." });
  try {
    await withUser(session.userId, async (q) => {
      const rows = await q(
        `update clients set name = $2, sector = $3, status = $4, profile = $5, trigger_prefix = $6,
           proposal_ttl_hours = $7, approval_rule = $8, monthly_budget_usd = $9, show_costs_to_client = $10,
           prefilter = $11, updated_at = now()
         where id = $1 returning id`,
        [
          id,
          text(form, "name"),
          text(form, "sector"),
          text(form, "status") === "sospeso" ? "sospeso" : "attivo",
          text(form, "profile"),
          text(form, "trigger_prefix"),
          Math.round(ttl),
          text(form, "approval_rule") === "agenzia" ? "agenzia" : "cliente",
          budget,
          flag(form, "show_costs_to_client"),
          flag(form, "prefilter"),
        ],
      );
      if (!rows.length) throw new Error("permission denied");
    });
  } catch (err) {
    back(path, { errore: explain(err) });
  }
  revalidatePath("/", "layout");
  back(path, { ok: "Impostazioni salvate." });
}

export async function saveSite(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = uuid(form, "client");
  const path = `/clienti/${id}`;
  let url = text(form, "url").replace(/\/+$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  const user = text(form, "wp_user");
  const password = String(form.get("wp_app_password") ?? "").trim();
  const types = text(form, "post_types").split(",").map((t) => t.trim()).filter(Boolean);
  if (!url || !user) back(path, { errore: "Servono l'indirizzo del sito e l'utente WordPress." });
  try {
    new URL(url);
  } catch {
    back(path, { errore: "L'indirizzo del sito non è valido." });
  }
  try {
    const encrypted = password ? encryptSecret(password) : null;
    await withUser(session.userId, async (q) => {
      await q(
        `insert into client_sites (client_id, url, wp_user, post_types, woocommerce, verify_public)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (client_id) do update set url = excluded.url, wp_user = excluded.wp_user,
           post_types = excluded.post_types, woocommerce = excluded.woocommerce,
           verify_public = excluded.verify_public, updated_at = now()`,
        [id, url, user, types.length ? types : ["post", "page"], flag(form, "woocommerce"), flag(form, "verify_public")],
      );
      if (encrypted) await q("select set_site_secret($1, $2)", [id, encrypted]);
      // Salvare e provare: il bot controlla il collegamento e scrive l'esito.
      const [{ has }] = await q("select has_site_secret($1) as has", [id]);
      if (has) await q("insert into azioni (client_id, tipo) values ($1, 'prova_sito')", [id]);
    });
  } catch (err) {
    back(path, { errore: explain(err) });
  }
  revalidatePath(path);
  back(path, { ok: "Sito salvato. Il bot sta provando la connessione: l'esito compare qui sotto tra qualche secondo." });
}

export async function testSite(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = uuid(form, "client");
  const path = `/clienti/${id}`;
  try {
    await withUser(session.userId, (q) => q("insert into azioni (client_id, tipo) values ($1, 'prova_sito')", [id]));
  } catch (err) {
    back(path, { errore: explain(err) });
  }
  revalidatePath(path);
  back(path, { ok: "Prova avviata: l'esito compare tra qualche secondo." });
}

export async function addChannel(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = uuid(form, "client");
  const path = `/clienti/${id}`;
  const chatId = text(form, "chat_id_manual") || text(form, "chat_id");
  if (!chatId) back(path, { errore: "Scegli un gruppo dall'elenco o scrivi il suo identificativo." });
  const chatType = text(form, "chat_type") === "individual" ? "individual" : "group";
  try {
    await withUser(session.userId, (q) =>
      q("insert into client_channels (client_id, chat_id, chat_type, name) values ($1, $2, $3, $4)", [
        id,
        chatType === "individual" ? chatId.replace(/[^\d]/g, "") : chatId,
        chatType,
        text(form, "name"),
      ]),
    );
  } catch (err) {
    back(path, { errore: /duplicate key/i.test(String(err)) ? "Questa chat è già collegata a un cliente." : explain(err) });
  }
  revalidatePath(path);
  back(path, { ok: "Chat collegata." });
}

export async function removeChannel(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = uuid(form, "client");
  const path = `/clienti/${id}`;
  try {
    await withUser(session.userId, (q) => q("delete from client_channels where id = $1 and client_id = $2", [uuid(form, "channel"), id]));
  } catch (err) {
    back(path, { errore: explain(err) });
  }
  revalidatePath(path);
  back(path, { ok: "Chat scollegata." });
}

export async function addContact(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = uuid(form, "client");
  const path = `/clienti/${id}`;
  const waId = text(form, "wa_id").replace(/[^\d]/g, "");
  if (waId.length < 8) back(path, { errore: "Scrivi il numero con il prefisso internazionale, es. 39 333 1234567." });
  try {
    await withUser(session.userId, (q) =>
      q(
        `insert into contacts (client_id, wa_id, name, can_approve) values ($1, $2, $3, $4)
         on conflict (client_id, wa_id) do update set name = excluded.name, can_approve = excluded.can_approve`,
        [id, waId, text(form, "name"), flag(form, "can_approve")],
      ),
    );
  } catch (err) {
    back(path, { errore: explain(err) });
  }
  revalidatePath(path);
  back(path, { ok: "Persona salvata." });
}

export async function removeContact(form: FormData): Promise<void> {
  const session = await requireSession();
  const id = uuid(form, "client");
  const path = `/clienti/${id}`;
  try {
    await withUser(session.userId, (q) => q("delete from contacts where id = $1 and client_id = $2", [uuid(form, "contact"), id]));
  } catch (err) {
    back(path, { errore: explain(err) });
  }
  revalidatePath(path);
  back(path, { ok: "Persona rimossa." });
}

// ------------------------------------------------------------------ utenti

const ROLES = ["admin_agenzia", "operatore_agenzia", "responsabile_cliente", "lettore_cliente"];

export async function addMember(form: FormData): Promise<void> {
  const session = await requireSession();
  const email = text(form, "email").toLowerCase();
  const role = text(form, "role");
  const clientId = text(form, "client");
  if (!email || !ROLES.includes(role)) back("/utenti", { errore: "Servono email e ruolo." });
  const needsClient = role === "responsabile_cliente" || role === "lettore_cliente";
  if (needsClient && !UUID.test(clientId)) back("/utenti", { errore: "Per questo ruolo va scelto il cliente." });
  const client = role === "admin_agenzia" || !UUID.test(clientId) ? null : clientId;

  let invited = false;
  try {
    let userId = await withUser(session.userId, async (q) => {
      const [p] = await q("select id from profiles where lower(email) = $1", [email]);
      return p ? String(p.id) : null;
    });
    if (!userId) {
      // L'utente non esiste ancora: lo invita Supabase via email (serve la chiave di servizio).
      if (!session.isAdmin) throw new Error("permission denied");
      if (!process.env.SUPABASE_SERVICE_ROLE_KEY || !process.env.NEXT_PUBLIC_SUPABASE_URL) {
        throw new Error("Questa persona non ha ancora un accesso. Creala in Supabase (Authentication → Users) oppure imposta SUPABASE_SERVICE_ROLE_KEY per invitarla da qui.");
      }
      const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
      const { data, error } = await admin.auth.admin.inviteUserByEmail(email, { data: { full_name: text(form, "name") } });
      if (error || !data.user) throw new Error(`Invito non riuscito: ${error?.message ?? "errore sconosciuto"}`);
      userId = data.user.id;
      invited = true;
    }
    await withUser(session.userId, (q) => q("insert into memberships (user_id, client_id, role) values ($1, $2, $3)", [userId, client, role]));
  } catch (err) {
    back("/utenti", { errore: /duplicate key/i.test(String(err)) ? "Questa persona ha già un ruolo su quel cliente." : explain(err) });
  }
  revalidatePath("/utenti");
  back("/utenti", { ok: invited ? "Invito inviato via email e ruolo assegnato." : "Ruolo assegnato." });
}

export async function removeMember(form: FormData): Promise<void> {
  const session = await requireSession();
  const membership = uuid(form, "membership");
  try {
    await withUser(session.userId, async (q) => {
      const [m] = await q("select user_id, client_id, role from memberships where id = $1", [membership]);
      if (m && m.user_id === session.userId && m.role === "admin_agenzia") {
        throw new Error("Non puoi togliere a te stesso il ruolo di admin.");
      }
      await q("delete from memberships where id = $1", [membership]);
    });
  } catch (err) {
    back("/utenti", { errore: explain(err) });
  }
  revalidatePath("/utenti");
  back("/utenti", { ok: "Ruolo rimosso." });
}
