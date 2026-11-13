import Link from "next/link";
import { redirect } from "next/navigation";
import { Notice } from "@/components/ui";
import { login } from "@/lib/actions";
import { devAuth, getSession } from "@/lib/auth";
import { devUsers } from "@/lib/db";

export const dynamic = "force-dynamic";
export const metadata = { title: "Accedi" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ ok?: string; errore?: string }> }) {
  if (await getSession()) redirect("/");
  const params = await searchParams;
  const dev = devAuth();
  const users = dev ? await devUsers() : [];
  const configured = dev || Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);

  return (
    <div className="login">
      <div className="card">
        <div className="card-head"><h1 style={{ fontSize: 22 }}>Commesse sito</h1></div>
        <div className="card-body">
          <Notice params={params} />
          {!configured && (
            <p role="alert" className="notice errore">Il login non è configurato: mancano i dati di Supabase (vedi README).</p>
          )}
          <form action={login} className="fields">
            {dev ? (
              <div className="field">
                <label htmlFor="user">Utente (login di sviluppo)</label>
                <select id="user" name="user" required>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.name || u.email} · {u.email}</option>
                  ))}
                </select>
                <span className="hint">Modalità locale senza Supabase: scegli con quale utente entrare.</span>
              </div>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="email">Email</label>
                  <input id="email" name="email" type="email" autoComplete="email" required />
                </div>
                <div className="field">
                  <label htmlFor="password">Password</label>
                  <input id="password" name="password" type="password" autoComplete="current-password" required />
                </div>
              </>
            )}
            <button type="submit" className="btn primary" disabled={!configured}>Accedi</button>
            {!dev && configured && <Link href="/recupero" className="small">Password dimenticata?</Link>}
          </form>
        </div>
      </div>
    </div>
  );
}
