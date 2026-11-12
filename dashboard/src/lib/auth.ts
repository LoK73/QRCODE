import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { withUser } from "./db";

export type Role = "admin_agenzia" | "operatore_agenzia" | "responsabile_cliente" | "lettore_cliente";

export interface Session {
  userId: string;
  name: string;
  email: string;
  /** Ruolo d'agenzia valido per tutti i clienti. */
  isAgency: boolean;
  isAdmin: boolean;
  /** Clienti che può gestire (impostazioni): tutti per l'agenzia, altrimenti quelli assegnati. */
  managedClients: string[];
  /** Clienti di cui può approvare le commesse come responsabile. */
  decidingClients: string[];
  /** Tutti i clienti su cui ha un ruolo. */
  clients: string[];
}

export const DEV_COOKIE = "dev_user";

/** Login di sviluppo: attivo solo in locale, quando Supabase non è configurato. */
export function devAuth(): boolean {
  return process.env.DEV_AUTH === "1" && !process.env.NEXT_PUBLIC_SUPABASE_URL;
}

export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Nei componenti server i cookie non si possono scrivere: li aggiorna il browser.
        }
      },
    },
  });
}

async function currentUserId(): Promise<string | null> {
  if (devAuth()) return (await cookies()).get(DEV_COOKIE)?.value ?? null;
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return null;
  const supabase = await supabaseServer();
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** L'utente collegato con i suoi ruoli, oppure null. Calcolato una volta per richiesta. */
export const getSession = cache(async (): Promise<Session | null> => {
  const userId = await currentUserId();
  if (!userId || !/^[0-9a-f-]{36}$/i.test(userId)) return null;
  return withUser(userId, async (q) => {
    const [profile] = await q("select full_name, email from profiles where id = auth.uid()");
    const roles = await q("select role, client_id from memberships where user_id = auth.uid()");
    if (!roles.length) return null;
    const agency = roles.filter((r) => r.client_id === null);
    const isAgency = agency.length > 0;
    const assigned = roles.filter((r) => r.client_id !== null);
    return {
      userId,
      name: String(profile?.full_name || profile?.email || "Utente"),
      email: String(profile?.email ?? ""),
      isAgency,
      isAdmin: agency.some((r) => r.role === "admin_agenzia"),
      managedClients: assigned.filter((r) => r.role === "operatore_agenzia").map((r) => String(r.client_id)),
      decidingClients: assigned.filter((r) => r.role === "responsabile_cliente").map((r) => String(r.client_id)),
      clients: assigned.map((r) => String(r.client_id)),
    };
  });
});

export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  return session;
}

/** Può gestire le impostazioni di almeno un cliente (agenzia o operatore assegnato). */
export function canManage(session: Session, clientId?: string): boolean {
  if (session.isAgency) return true;
  return clientId ? session.managedClients.includes(clientId) : session.managedClients.length > 0;
}

export function roleLabel(session: Session): string {
  if (session.isAdmin) return "Admin agenzia";
  if (session.isAgency || session.managedClients.length) return "Operatore agenzia";
  if (session.decidingClients.length) return "Responsabile";
  return "Lettore";
}
