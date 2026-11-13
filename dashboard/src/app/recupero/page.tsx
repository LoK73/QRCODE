import Link from "next/link";
import { redirect } from "next/navigation";
import { Notice } from "@/components/ui";
import { requestPasswordReset } from "@/lib/actions";
import { devAuth } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Recupera la password" };

export default async function RecoverPage({ searchParams }: { searchParams: Promise<{ ok?: string; errore?: string }> }) {
  if (devAuth()) redirect("/login");
  const params = await searchParams;
  return (
    <div className="login">
      <div className="card">
        <div className="card-head"><h1 style={{ fontSize: 22 }}>Recupera la password</h1></div>
        <div className="card-body">
          <Notice params={params} />
          <form action={requestPasswordReset} className="fields">
            <div className="field">
              <label htmlFor="email">Email</label>
              <input id="email" name="email" type="email" autoComplete="email" required />
              <span className="hint">Ti mandiamo un link per scegliere una nuova password.</span>
            </div>
            <button type="submit" className="btn primary">Manda il link</button>
            <Link href="/login" className="small">Torna all'accesso</Link>
          </form>
        </div>
      </div>
    </div>
  );
}
