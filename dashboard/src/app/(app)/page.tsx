import Link from "next/link";
import { redirect } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { CommessaItem } from "@/components/commessa-item";
import { Notice } from "@/components/ui";
import { requireSession } from "@/lib/auth";
import { listClients, overview } from "@/lib/data";
import { ago, currentMonth, day, duration, monthRange, usd } from "@/lib/format";

export const metadata = { title: "Panoramica" };

export default async function OverviewPage({ searchParams }: { searchParams: Promise<{ ok?: string; errore?: string }> }) {
  const session = await requireSession();
  // La panoramica è dell'agenzia: gli altri partono dall'elenco delle commesse.
  if (!session.isAgency) redirect("/commesse");
  const params = await searchParams;
  const month = monthRange(currentMonth());
  const [data, clients] = await Promise.all([overview(session, month.from), listClients(session)]);
  const active = clients.filter((c) => c.status === "attivo");
  const budgetShare = data.budgetUsd > 0 ? Math.min(100, Math.round((data.costUsd / data.budgetUsd) * 100)) : null;
  const today = day(new Date());

  return (
    <>
      <AutoRefresh seconds={10} />
      <div className="head">
        <div className="head-text">
          <h1>Panoramica</h1>
          <p className="sub">{today.charAt(0).toUpperCase() + today.slice(1)} · {active.length} {active.length === 1 ? "cliente attivo" : "clienti attivi"}</p>
        </div>
        <Link href="/clienti/nuovo" className="btn primary">Nuovo cliente</Link>
      </div>
      <Notice params={params} />

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Da approvare</span>
          <span className={`kpi-value ${data.pendingCount ? "attesa" : ""}`}>{data.pendingCount}</span>
          <span className="kpi-note">{data.oldestPending ? `la più vecchia è di ${ago(data.oldestPending)}` : "niente in sospeso"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Messe online a {month.label.split(" ")[0]}</span>
          <span className="kpi-value">{data.online}</span>
          <span className="kpi-note">{data.reverted} {data.reverted === 1 ? "ripristinata" : "ripristinate"}, {data.failedCount} non {data.failedCount === 1 ? "riuscita" : "riuscite"}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Dalla richiesta all'online</span>
          <span className="kpi-value">{duration(data.avgMinutes)}</span>
          <span className="kpi-note">tempo medio del mese</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Costo AI del mese</span>
          <span className="kpi-value">{usd(data.costUsd)}</span>
          {budgetShare !== null ? (
            <>
              <div className="meter" role="img" aria-label={`${budgetShare}% del tetto mensile`}><span style={{ width: `${budgetShare}%` }} /></div>
              <span className="kpi-note">{budgetShare}% del tetto di {usd(data.budgetUsd)}</span>
            </>
          ) : (
            <span className="kpi-note">nessun tetto di spesa impostato</span>
          )}
        </div>
      </div>

      <div className="row">
        <section className="card col-main" style={{ gap: 0 }} aria-labelledby="h-pending">
          <div className="card-head">
            <h2 id="h-pending">Da approvare</h2>
            <Link href="/commesse">Vedi tutte le commesse</Link>
          </div>
          {data.pending.length === 0 && <p className="empty">Nessuna modifica aspetta l'ok.</p>}
          {data.pending.map((c) => <CommessaItem key={c.id} c={c} canDecide from="/" />)}
          <p className="card-foot">Ogni approvazione viene eseguita dal bot, che poi avvisa il gruppo WhatsApp del cliente. Dall'elenco si approvano solo le modifiche piccole.</p>
        </section>

        <div className="col-side">
          <section className="card" aria-labelledby="h-errors">
            <div className="card-head"><h2 id="h-errors">Da guardare</h2></div>
            {data.failed.length === 0 && clients.every((c) => c.siteOk !== false) && <p className="empty">Tutto a posto.</p>}
            {data.failed.map((c) => (
              <div key={c.id} className="card-body" style={{ gap: 8, borderBottom: "1px solid var(--line)" }}>
                <div className="inline"><span className="badge errore">Non riuscita</span><span className="small muted">{c.clientName} · rif. {c.id}</span></div>
                <span className="strong" style={{ fontWeight: 500 }}>{c.summary}</span>
                <Link href={`/commesse/${c.id}`}>Apri la commessa</Link>
              </div>
            ))}
            {clients.filter((c) => c.siteOk === false).map((c) => (
              <div key={c.id} className="card-body" style={{ gap: 8, borderBottom: "1px solid var(--line)" }}>
                <div className="inline"><span className="badge errore">Sito non raggiungibile</span><span className="small muted">{c.name}</span></div>
                <Link href={`/clienti/${c.id}`}>Controlla il collegamento</Link>
              </div>
            ))}
          </section>

          <section className="card" aria-labelledby="h-clients">
            <div className="card-head"><h2 id="h-clients">Clienti</h2><Link href="/clienti">Gestisci</Link></div>
            {clients.length === 0 && <p className="empty">Nessun cliente: aggiungi il primo.</p>}
            {clients.map((c) => (
              <div key={c.id} className="line-row">
                <div>
                  <Link href={`/clienti/${c.id}`} style={{ color: "var(--ink)" }}>{c.name}</Link>
                  <div className="tiny muted">{c.sector || "—"}{c.lastRequest ? ` · ultima richiesta ${ago(c.lastRequest)}` : ""}</div>
                </div>
                {c.status !== "attivo" ? <span className="badge chiusa">Sospeso</span>
                  : !c.hasSite || c.channels === 0 ? <span className="badge attesa">Da completare</span>
                  : c.failed > 0 ? <span className="badge errore">{c.failed} non {c.failed === 1 ? "riuscita" : "riuscite"}</span>
                  : c.pending > 0 ? <span className="badge attesa">{c.pending} in sospeso</span>
                  : <span className="badge chiusa">Tutto a posto</span>}
              </div>
            ))}
          </section>
        </div>
      </div>
    </>
  );
}
