import Link from "next/link";
import { redirect } from "next/navigation";
import { Notice } from "@/components/ui";
import { canManage, requireSession } from "@/lib/auth";
import { listClients } from "@/lib/data";
import { ago } from "@/lib/format";

export const metadata = { title: "Clienti" };

export default async function ClientsPage({ searchParams }: { searchParams: Promise<{ ok?: string; errore?: string }> }) {
  const session = await requireSession();
  if (!canManage(session)) redirect("/commesse");
  const params = await searchParams;
  const clients = (await listClients(session)).filter((c) => canManage(session, c.id));

  return (
    <>
      <div className="head">
        <div className="head-text">
          <h1>Clienti</h1>
          <p className="sub">{clients.length} {clients.length === 1 ? "cliente" : "clienti"}</p>
        </div>
        {session.isAgency && <Link href="/clienti/nuovo" className="btn primary">Nuovo cliente</Link>}
      </div>
      <Notice params={params} />
      <section className="card" aria-label="Elenco dei clienti">
        {clients.length === 0 ? (
          <p className="empty">Nessun cliente: aggiungi il primo per collegare il suo sito e il suo gruppo WhatsApp.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Cliente</th><th>Sito</th><th>WhatsApp</th><th>In sospeso</th><th>Ultima richiesta</th><th>Stato</th></tr></thead>
              <tbody>
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td><Link href={`/clienti/${c.id}`} style={{ color: "var(--ink)" }}>{c.name}</Link><div className="tiny muted">{c.sector}</div></td>
                    <td>{!c.hasSite ? <span className="badge attesa">Da collegare</span> : c.siteOk === false ? <span className="badge errore">Non raggiungibile</span> : c.siteOk ? <span className="badge ok">Collegato</span> : <span className="badge chiusa">Da provare</span>}</td>
                    <td>{c.channels ? <span className="badge ok">{c.channels} chat</span> : <span className="badge attesa">Da collegare</span>}</td>
                    <td className="num">{c.pending}</td>
                    <td className="muted nowrap">{c.lastRequest ? ago(c.lastRequest) : "—"}</td>
                    <td>{c.status === "attivo" ? <span className="badge ok">Attivo</span> : <span className="badge chiusa">Sospeso</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
