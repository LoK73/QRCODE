import { redirect } from "next/navigation";
import { Notice } from "@/components/ui";
import { addMember, removeMember } from "@/lib/actions";
import { requireSession } from "@/lib/auth";
import { clientOptions, listMembers } from "@/lib/data";

export const metadata = { title: "Utenti" };

const ROLE_LABEL: Record<string, string> = {
  admin_agenzia: "Admin agenzia",
  operatore_agenzia: "Operatore agenzia",
  responsabile_cliente: "Responsabile del cliente",
  lettore_cliente: "Lettore del cliente",
};

export default async function UsersPage({ searchParams }: { searchParams: Promise<{ ok?: string; errore?: string }> }) {
  const session = await requireSession();
  if (!session.isAdmin) redirect("/");
  const params = await searchParams;
  const [members, clients] = await Promise.all([listMembers(session), clientOptions(session)]);

  return (
    <>
      <div className="head-text">
        <h1>Utenti</h1>
        <p className="sub">Chi può entrare in dashboard e cosa può fare.</p>
      </div>
      <Notice params={params} />
      <div className="row">
        <section className="card col-main" style={{ gap: 0 }} aria-label="Utenti e ruoli">
          <div className="table-wrap">
            <table>
              <thead><tr><th>Persona</th><th>Ruolo</th><th>Cliente</th><th><span className="sr">Azioni</span></th></tr></thead>
              <tbody>
                {members.map((m) => (
                  <tr key={m.id}>
                    <td><div style={{ fontWeight: 500 }}>{m.name || m.email}</div><div className="tiny muted">{m.email}</div></td>
                    <td>{ROLE_LABEL[m.role] ?? m.role}</td>
                    <td className="muted">{m.clientName ?? "Tutti i clienti"}</td>
                    <td>
                      <form action={removeMember}>
                        <input type="hidden" name="membership" value={m.id} />
                        <button type="submit" className="btn quiet">Rimuovi</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="card col-side" style={{ gap: 0 }} aria-labelledby="h-add">
          <div className="card-head"><h2 id="h-add">Aggiungi un ruolo</h2></div>
          <div className="card-body">
            <form action={addMember} className="fields">
              <div className="field"><label htmlFor="email">Email</label><input id="email" name="email" type="email" required autoComplete="off" /></div>
              <div className="field"><label htmlFor="name">Nome (per i nuovi utenti)</label><input id="name" name="name" type="text" autoComplete="off" /></div>
              <div className="field">
                <label htmlFor="role">Ruolo</label>
                <select id="role" name="role" defaultValue="responsabile_cliente">
                  {Object.entries(ROLE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                </select>
              </div>
              <div className="field">
                <label htmlFor="client">Cliente</label>
                <select id="client" name="client" defaultValue="">
                  <option value="">Tutti i clienti (solo ruoli d'agenzia)</option>
                  {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="inline"><button type="submit" className="btn primary">Aggiungi</button></div>
            </form>
            <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
              <li><strong>Admin agenzia</strong>: tutto, compresi utenti e clienti.</li>
              <li><strong>Operatore agenzia</strong>: commesse e impostazioni, di tutti i clienti o di uno solo.</li>
              <li><strong>Responsabile del cliente</strong>: vede e approva le modifiche del proprio sito.</li>
              <li><strong>Lettore del cliente</strong>: vede soltanto.</li>
            </ul>
          </div>
        </section>
      </div>
    </>
  );
}
