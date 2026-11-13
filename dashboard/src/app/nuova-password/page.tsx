import { redirect } from "next/navigation";
import { Notice } from "@/components/ui";
import { setPassword } from "@/lib/actions";
import { authUser, devAuth, MIN_PASSWORD } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const metadata = { title: "Scegli la password" };

export default async function NewPasswordPage({ searchParams }: { searchParams: Promise<{ ok?: string; errore?: string }> }) {
  if (devAuth()) redirect("/");
  const user = await authUser();
  if (!user) redirect(`/login?errore=${encodeURIComponent("Apri il link che hai ricevuto via email, oppure chiedine uno nuovo.")}`);
  const params = await searchParams;
  return (
    <div className="login">
      <div className="card">
        <div className="card-head"><h1 style={{ fontSize: 22 }}>Scegli la password</h1></div>
        <div className="card-body">
          <Notice params={params} />
          <form action={setPassword} className="fields">
            <p className="small muted" style={{ margin: 0 }}>Account: {user.email}</p>
            <div className="field">
              <label htmlFor="password">Nuova password</label>
              <input id="password" name="password" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required />
              <span className="hint">Almeno {MIN_PASSWORD} caratteri.</span>
            </div>
            <div className="field">
              <label htmlFor="confirm">Ripeti la password</label>
              <input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={MIN_PASSWORD} required />
            </div>
            <button type="submit" className="btn primary">Salva la password</button>
          </form>
        </div>
      </div>
    </div>
  );
}
