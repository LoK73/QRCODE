import { Nav, type NavItem } from "@/components/nav";
import { SessionKeeper } from "@/components/session-keeper";
import { canManage, devAuth, requireSession, roleLabel } from "@/lib/auth";
import { logout } from "@/lib/actions";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  const items: NavItem[] = [];
  if (session.isAgency) items.push({ href: "/", label: "Panoramica", icon: "panoramica" });
  items.push({ href: "/commesse", label: session.isAgency || canManage(session) ? "Commesse" : "Modifiche al sito", icon: "commesse" });
  if (canManage(session)) items.push({ href: "/clienti", label: "Clienti", icon: "clienti" });
  if (session.isAgency) items.push({ href: "/report", label: "Report e costi", icon: "report" });
  if (session.isAdmin) items.push({ href: "/utenti", label: "Utenti", icon: "utenti" });
  const initials = session.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();

  return (
    <div className="shell">
      <nav className="side" aria-label="Navigazione principale">
        <div className="brand">
          <div className="brand-mark">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" /><path d="M9 12l2 2 4-4" />
            </svg>
          </div>
          <div>
            <span className="brand-name">Commesse sito</span>
            <span className="brand-sub">{process.env.NEXT_PUBLIC_AGENCY_NAME ?? "Dashboard"}</span>
          </div>
        </div>
        <Nav items={items} />
        <div className="me">
          <div className="avatar" aria-hidden="true">{initials}</div>
          <div>
            <a href="/profilo" className="me-name" title="Il mio profilo">{session.name}</a>
            <span className="me-role">{roleLabel(session)}</span>
          </div>
          <form action={logout}>
            <button type="submit" className="linklike">Esci</button>
          </form>
        </div>
      </nav>
      <main className="main">{children}</main>
      {!devAuth() && process.env.NEXT_PUBLIC_SUPABASE_URL && (
        <SessionKeeper url={process.env.NEXT_PUBLIC_SUPABASE_URL} anonKey={process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ""} />
      )}
    </div>
  );
}
