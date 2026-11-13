import Link from "next/link";
import { Notice } from "@/components/ui";
import { saveProfile } from "@/lib/actions";
import { devAuth, requireSession, roleLabel } from "@/lib/auth";
import { withUser } from "@/lib/db";

export const metadata = { title: "Il mio profilo" };

export default async function ProfilePage({ searchParams }: { searchParams: Promise<{ ok?: string; errore?: string }> }) {
  const session = await requireSession();
  const params = await searchParams;
  const [profile] = await withUser(session.userId, (q) =>
    q("select full_name, email, email_notifications from profiles where id = auth.uid()"),
  );

  return (
    <>
      <div className="head-text">
        <h1>Il mio profilo</h1>
        <p className="sub">{roleLabel(session)} · {String(profile?.email ?? session.email)}</p>
      </div>
      <Notice params={params} />
      <section className="card" style={{ maxWidth: 640 }}>
        <div className="card-body">
          <form action={saveProfile} className="fields">
            <div className="field">
              <label htmlFor="full_name">Nome</label>
              <input id="full_name" name="full_name" type="text" defaultValue={String(profile?.full_name ?? "")} autoComplete="name" />
            </div>
            <label className="check">
              <input type="checkbox" name="email_notifications" defaultChecked={profile?.email_notifications !== false} />
              <span>
                Ricevi un'email quando c'è una modifica da approvare
                <span className="hint" style={{ display: "block" }}>Arriva solo per i clienti di cui puoi approvare le modifiche.</span>
              </span>
            </label>
            <div className="inline">
              <button type="submit" className="btn primary">Salva</button>
              {!devAuth() && <Link href="/nuova-password" className="btn">Cambia password</Link>}
            </div>
          </form>
        </div>
      </section>
    </>
  );
}
