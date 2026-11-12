import Link from "next/link";
import { AutoRefresh } from "@/components/auto-refresh";
import { CommessaItem } from "@/components/commessa-item";
import { Change, Notice, Pill, StatusBadge } from "@/components/ui";
import { canManage, requireSession } from "@/lib/auth";
import { clientOptions, listCommesse, STATUS_GROUPS } from "@/lib/data";
import { ago } from "@/lib/format";

export const metadata = { title: "Commesse" };

export default async function CommessePage({
  searchParams,
}: {
  searchParams: Promise<{ stato?: string; cliente?: string; ok?: string; errore?: string }>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const staff = session.isAgency || canManage(session);
  const group = params.stato && STATUS_GROUPS[params.stato] ? params.stato : staff ? "tutte" : "attesa";
  const [{ rows, groupCounts }, clients] = await Promise.all([
    listCommesse(session, { group, clientId: params.cliente }),
    clientOptions(session),
  ]);
  const href = (g: string, client = params.cliente) => {
    const q = new URLSearchParams();
    if (g !== "tutte") q.set("stato", g);
    if (client) q.set("cliente", client);
    return `/commesse${q.size ? `?${q}` : ""}`;
  };
  const here = href(group);
  const canDecide = (clientId: string) => session.isAgency || session.managedClients.includes(clientId) || session.decidingClients.includes(clientId);
  // Per chi segue un solo cliente (il portale del cliente) le proposte in attesa sono schede da approvare.
  const cards = !staff && group === "attesa";

  return (
    <>
      <AutoRefresh seconds={10} />
      <div className="head">
        <div className="head-text">
          <h1>{staff ? "Commesse" : "Modifiche al sito"}</h1>
          <p className="sub">{rows.length} {rows.length === 1 ? "commessa" : "commesse"} · l'elenco si aggiorna da solo quando arriva una richiesta</p>
        </div>
        {clients.length > 1 && (
          <form className="field" style={{ flex: "0 1 260px" }}>
            <label htmlFor="cliente" className="tiny muted">Cliente</label>
            <div className="inline" style={{ flexWrap: "nowrap" }}>
              {group !== "tutte" && <input type="hidden" name="stato" value={group} />}
              <select id="cliente" name="cliente" defaultValue={params.cliente ?? ""}>
                <option value="">Tutti i clienti</option>
                {clients.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <button type="submit" className="btn">Filtra</button>
            </div>
          </form>
        )}
      </div>
      <Notice params={params} />

      <nav className="pills" aria-label="Filtra per stato">
        {Object.entries(STATUS_GROUPS).map(([key, g]) => (
          <Pill key={key} href={href(key)} current={key === group} label={g.label} count={groupCounts[key]} />
        ))}
      </nav>

      {cards ? (
        <section className="card" aria-label="Da approvare">
          {rows.length === 0 && <p className="empty">Nessuna modifica aspetta il tuo ok.</p>}
          {rows.map((c) => <CommessaItem key={c.id} c={c} canDecide={canDecide(c.clientId)} from={here} showClient={clients.length > 1} />)}
          <p className="card-foot">Le modifiche le prepara un assistente automatico. Vanno online solo dopo l'ok, e si possono sempre annullare.</p>
        </section>
      ) : (
        <section className="card" aria-label="Elenco delle commesse">
          {rows.length === 0 ? (
            <p className="empty">Nessuna commessa con questi filtri.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr><th>Rif.</th>{clients.length > 1 && <th>Cliente</th>}<th>Richiesta</th><th>Chiesta da</th><th>Quando</th><th>Stato</th><th><span className="sr">Apri</span></th></tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr key={c.id}>
                      <td className="muted num">{c.id}</td>
                      {clients.length > 1 && <td className="strong" style={{ fontWeight: 500 }}>{c.clientName}</td>}
                      <td style={{ minWidth: 280 }}>
                        <div style={{ fontWeight: 500 }}>{c.summary}</div>
                        {c.details[0] && <Change detail={c.details[0]} />}
                      </td>
                      <td className="muted nowrap">{c.requesterName}</td>
                      <td className="muted nowrap">{ago(c.createdAt)}</td>
                      <td>{c.pendingAction ? <span className="badge corso">In lavorazione…</span> : <StatusBadge status={c.status} />}</td>
                      <td><Link href={`/commesse/${c.id}`} className="btn quiet" style={{ color: "var(--accent)" }}>Apri</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
