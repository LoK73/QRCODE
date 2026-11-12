import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { report } from "@/lib/data";
import { currentMonth, duration, monthRange, usd, validMonth } from "@/lib/format";

export const metadata = { title: "Report e costi" };

export default async function ReportPage({ searchParams }: { searchParams: Promise<{ mese?: string; vista?: string }> }) {
  const session = await requireSession();
  if (!session.isAgency) redirect("/commesse");
  const params = await searchParams;
  const month = validMonth(params.mese);
  const range = monthRange(month);
  const rows = await report(session, range.from, range.to);
  const byCost = params.vista === "costo";

  const total = rows.reduce(
    (t, r) => ({ requests: t.requests + r.requests, online: t.online + r.online, failed: t.failed + r.failed, pending: t.pending + r.pending, cost: t.cost + r.costUsd, budget: t.budget + r.budgetUsd }),
    { requests: 0, online: 0, failed: 0, pending: 0, cost: 0, budget: 0 },
  );
  const done = rows.filter((r) => r.avgMinutes !== null && r.online > 0);
  const avg = done.length ? done.reduce((s, r) => s + r.avgMinutes! * r.online, 0) / done.reduce((s, r) => s + r.online, 0) : null;
  const max = Math.max(1, ...rows.map((r) => (byCost ? r.costUsd : r.requests)));
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - i);
    return currentMonth(d);
  });

  return (
    <>
      <div className="head">
        <div className="head-text">
          <h1>Report e costi</h1>
          <p className="sub">{range.label.charAt(0).toUpperCase() + range.label.slice(1)} · {rows.length} {rows.length === 1 ? "cliente" : "clienti"}</p>
        </div>
        <div className="inline" style={{ alignItems: "flex-end" }}>
          <form className="field" style={{ flex: "0 1 220px" }}>
            <label htmlFor="mese" className="tiny muted">Mese</label>
            <div className="inline" style={{ flexWrap: "nowrap" }}>
              {byCost && <input type="hidden" name="vista" value="costo" />}
              <select id="mese" name="mese" defaultValue={month}>
                {months.map((m) => <option key={m} value={m}>{monthRange(m).label}</option>)}
              </select>
              <button type="submit" className="btn">Vai</button>
            </div>
          </form>
          <a href={`/report/export?mese=${month}`} className="btn">Esporta CSV</a>
        </div>
      </div>

      <div className="kpis">
        <div className="kpi"><span className="kpi-label">Richieste ricevute</span><span className="kpi-value">{total.requests}</span><span className="kpi-note">{total.pending} aspettano ancora l'ok</span></div>
        <div className="kpi"><span className="kpi-label">Messe online</span><span className="kpi-value">{total.online}</span><span className="kpi-note">{total.failed} non {total.failed === 1 ? "riuscita" : "riuscite"}</span></div>
        <div className="kpi"><span className="kpi-label">Dalla richiesta all'online</span><span className="kpi-value">{duration(avg)}</span><span className="kpi-note">quasi tutto è attesa dell'ok</span></div>
        <div className="kpi"><span className="kpi-label">Costo AI</span><span className="kpi-value">{usd(total.cost)}</span><span className="kpi-note">{total.requests ? `${usd(total.cost / total.requests)} in media per richiesta` : "nessuna richiesta"}</span></div>
      </div>

      <section className="card" aria-labelledby="h-chart">
        <div className="card-head">
          <h2 id="h-chart">{byCost ? "Costo AI per cliente" : "Richieste per cliente"}</h2>
          <nav className="pills" aria-label="Cosa mostrare">
            <a className="pill" href={`/report?mese=${month}`} aria-current={!byCost ? "true" : undefined}>Richieste</a>
            <a className="pill" href={`/report?mese=${month}&vista=costo`} aria-current={byCost ? "true" : undefined}>Costo AI</a>
          </nav>
        </div>
        <div className="card-body bars">
          {rows.length === 0 && <p className="muted">Nessun cliente.</p>}
          {rows.map((r) => {
            const value = byCost ? r.costUsd : r.requests;
            return (
              <div key={r.clientId} className="bar-row">
                <span className="name">{r.client}</span>
                <div className="track">
                  <div className="bar" aria-hidden="true" style={{ width: `${Math.round((value / max) * 100)}%` }} />
                  <span className="strong nowrap">{byCost ? usd(value) : value}</span>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <section className="card" aria-labelledby="h-table">
        <div className="card-head"><h2 id="h-table">Per cliente</h2></div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Cliente</th><th className="num">Richieste</th><th className="num">Online</th><th className="num">Non riuscite</th><th className="num">Tempo medio</th><th className="num">Costo AI</th><th>Tetto del mese</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const share = r.budgetUsd > 0 ? Math.min(100, Math.round((r.costUsd / r.budgetUsd) * 100)) : null;
                return (
                  <tr key={r.clientId}>
                    <td style={{ fontWeight: 500 }}>{r.client}</td>
                    <td className="num">{r.requests}</td>
                    <td className="num">{r.online}</td>
                    <td className="num">{r.failed}</td>
                    <td className="num nowrap">{duration(r.avgMinutes)}</td>
                    <td className="num strong nowrap">{usd(r.costUsd)}</td>
                    <td style={{ minWidth: 170 }}>
                      {share === null ? <span className="small muted">nessun tetto</span> : (
                        <div className="inline" style={{ flexWrap: "nowrap" }}>
                          <div className="meter" aria-hidden="true" style={{ flex: "1 1 auto" }}><span style={{ width: `${share}%` }} /></div>
                          <span className="small muted nowrap">{share}% di {usd(r.budgetUsd)}</span>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr><td>Totale</td><td className="num">{total.requests}</td><td className="num">{total.online}</td><td className="num">{total.failed}</td><td className="num nowrap">{duration(avg)}</td><td className="num nowrap">{usd(total.cost)}</td><td className="small muted" style={{ fontWeight: 400 }}>{total.budget > 0 ? `${Math.round((total.cost / total.budget) * 100)}% di ${usd(total.budget)}` : ""}</td></tr>
            </tfoot>
          </table>
        </div>
      </section>
      <p className="small muted">Il costo AI è stimato dai consumi registrati a ogni richiesta, in dollari. Superato il tetto del mese, il bot smette di analizzare i messaggi di quel cliente (le approvazioni continuano a funzionare).</p>
    </>
  );
}
