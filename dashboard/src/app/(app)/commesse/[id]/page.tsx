import Link from "next/link";
import { notFound } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Diff, Notice, StatusBadge } from "@/components/ui";
import { requestAction } from "@/lib/actions";
import { requireSession } from "@/lib/auth";
import { getCommessa } from "@/lib/data";
import { dateTime, usd } from "@/lib/format";

export const metadata = { title: "Dettaglio commessa" };

const ACTION_TEXT: Record<string, string> = {
  approva: "ha chiesto di approvarla",
  annulla: "ha chiesto di annullarla",
  ripristina: "ha chiesto di rimettere il sito com'era",
  ripristina_forza: "ha chiesto di rimettere comunque il sito com'era",
  riprova: "ha chiesto di rifarla",
};

function ActionButton({ id, tipo, label, className = "btn" }: { id: number; tipo: string; label: string; className?: string }) {
  return (
    <form action={requestAction}>
      <input type="hidden" name="commessa" value={id} />
      <input type="hidden" name="tipo" value={tipo} />
      <button type="submit" className={className}>{label}</button>
    </form>
  );
}

export default async function CommessaPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; errore?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  const notice = await searchParams;
  const c = /^\d+$/.test(id) ? await getCommessa(session, Number(id)) : null;
  if (!c) notFound();

  const agency = session.isAgency || session.managedClients.includes(c.clientId);
  const canDecide = agency || (session.decidingClients.includes(c.clientId) && c.approvalRule === "cliente");
  const busy = c.pendingAction !== null;
  const lastFailed = [...c.actions].reverse().find((a) => a.state === "fallita");
  const conflict = c.status === "completata" && lastFailed?.type === "ripristina" && /Non l'ho toccata/.test(lastFailed.outcome ?? "");

  return (
    <>
      {(busy || c.status === "in_corso" || c.status === "in_ripristino") && <AutoRefresh seconds={3} />}
      <Link href="/commesse" className="inline" style={{ minHeight: 44, alignSelf: "flex-start" }}>← Tutte le commesse</Link>

      <div className="head" style={{ alignItems: "flex-start" }}>
        <div className="head-text" style={{ flex: "1 1 420px", gap: 8 }}>
          <div className="inline small muted">
            <span className="strong" style={{ color: "var(--ink)" }}>{c.clientName}</span>
            <span>rif. {c.id}</span>
            <StatusBadge status={c.status} />
          </div>
          <h1 style={{ fontSize: 26, lineHeight: 1.2 }}>{c.summary}</h1>
        </div>
        {canDecide && !busy && (
          <div className="inline">
            {c.status === "in_attesa" && <><ActionButton id={c.id} tipo="annulla" label="Annulla" /><ActionButton id={c.id} tipo="approva" label={c.applyAt ? "Approva e metti in programma" : "Approva e metti online"} className="btn primary" /></>}
            {c.status === "programmata" && <ActionButton id={c.id} tipo="annulla" label="Annulla la programmazione" />}
            {c.status === "completata" && !conflict && <ActionButton id={c.id} tipo="ripristina" label="Rimetti com'era" />}
            {conflict && <ActionButton id={c.id} tipo="ripristina_forza" label="Rimetti com'era comunque" className="btn danger" />}
            {(c.status === "errore" || c.status === "scaduta") && <ActionButton id={c.id} tipo="riprova" label="Rifai la proposta" className="btn outline" />}
          </div>
        )}
      </div>

      {/* L'avviso di "richiesta inviata" vale finché il bot lavora; gli errori restano. */}
      <Notice params={busy ? {} : { errore: notice.errore }} />
      {busy && <p role="status" className="notice info">Il bot sta eseguendo la richiesta: questa pagina si aggiorna da sola.</p>}
      {!busy && lastFailed && lastFailed.id === c.actions.at(-1)?.id && <p role="alert" className="notice errore">{lastFailed.outcome}</p>}
      {c.status === "errore" && c.error && <p role="alert" className="notice errore">La modifica non è riuscita: {c.error}</p>}
      {!canDecide && c.status === "in_attesa" && (
        <p className="notice info">{c.approvalRule === "agenzia" ? "Questa modifica verrà approvata dall'agenzia." : "Puoi vedere questa modifica; l'ok lo dà un responsabile."}</p>
      )}

      <div className="row">
        <div className="col-main">
          <section className="card" aria-labelledby="h-diff">
            <div className="card-head">
              <h2 id="h-diff">Cosa cambia sul sito</h2>
              <span className="small muted">{c.preview.length} {c.preview.length === 1 ? "contenuto" : "contenuti"}</span>
            </div>
            <div className="card-body">
              {c.preview.length === 0 && (
                <ul style={{ margin: 0, paddingLeft: 18 }}>{c.details.map((d, i) => <li key={i}>{d}</li>)}</ul>
              )}
              {c.preview.map((p, i) => (
                <div key={i} className="stack" style={{ gap: 12 }}>
                  <div>
                    <div className="strong">{p.kind === "nuovo" ? `Nuovo contenuto: ${p.title}` : p.title}</div>
                    {p.url && <div className="mono muted">{p.url.replace(/^https?:\/\//, "")}</div>}
                  </div>
                  {p.changes.map((ch, j) =>
                    ch.field === "Testo" || ch.before.length > 60 || ch.after.length > 60 ? (
                      <div key={j} className="stack" style={{ gap: 6 }}>
                        {ch.field !== "Testo" && <span className="small muted">{ch.field}</span>}
                        <Diff before={ch.before} after={ch.after} />
                      </div>
                    ) : (
                      <div key={j} className="inline small">
                        <span className="muted" style={{ minWidth: 140 }}>{ch.field}</span>
                        {ch.before && <span className="old">{ch.before}</span>}
                        {ch.before && <span className="muted">→</span>}
                        <span className="new">{ch.after || "(vuoto)"}</span>
                      </div>
                    ),
                  )}
                </div>
              ))}
              {c.applyAt && c.status !== "completata" && <p className="small">Da mettere online il {dateTime(c.applyAt)}.</p>}
              {c.revertAt && <p className="small">Da rimettere com'era il {dateTime(c.revertAt)}.</p>}
              <p className="small muted">I valori di prima vengono salvati: la modifica si può annullare in qualsiasi momento.</p>
            </div>
          </section>

          <section className="card" aria-labelledby="h-chat">
            <div className="card-head">
              <h2 id="h-chat">Conversazione su WhatsApp</h2>
              {c.chatName && <span className="small muted">{c.chatName}</span>}
            </div>
            <div className="card-body chat">
              {c.messages.length === 0 && <p className="muted">Richiesta: «{c.originalText}»</p>}
              {c.messages.map((m, i) => (
                <div key={i} className={`bubble ${m.bot ? "bot" : ""}`}>
                  <span className="who">{m.sender} · {dateTime(m.at)}{m.media ? ` · ${m.media === "audio" ? "vocale" : m.media === "image" ? "foto" : "documento"}` : ""}</span>
                  <div className="text">{m.text || "(allegato senza testo)"}</div>
                </div>
              ))}
            </div>
          </section>
        </div>

        <div className="col-side">
          <section className="card" aria-labelledby="h-info">
            <div className="card-head"><h2 id="h-info">Dettagli</h2></div>
            <div className="card-body">
              <dl className="facts">
                <dt>Chiesta da</dt><dd>{c.requesterName}</dd>
                <dt>Ricevuta</dt><dd>{dateTime(c.createdAt)}</dd>
                <dt>Approvazione</dt><dd>{c.approvalRule === "agenzia" ? "Solo l'agenzia" : "Responsabile del cliente o agenzia"}</dd>
                {c.approvedBy && <><dt>Approvata da</dt><dd>{c.approvedBy}</dd></>}
                {c.resultUrls.length > 0 && <><dt>Pagina</dt><dd>{c.resultUrls.map((u) => <a key={u} href={u} target="_blank" rel="noreferrer" style={{ display: "block" }}>{u.replace(/^https?:\/\//, "")}</a>)}</dd></>}
                {agency && c.costUsd !== null && <><dt>Costo AI</dt><dd>{usd(c.costUsd)}</dd></>}
              </dl>
            </div>
          </section>

          <section className="card" aria-labelledby="h-log">
            <div className="card-head"><h2 id="h-log">Cronologia</h2></div>
            <div className="card-body">
              <ol className="timeline">
                <li><span className="dot" aria-hidden="true" /><div><div style={{ fontWeight: 500 }}>Richiesta di {c.requesterName} nel gruppo</div><div className="tiny muted">{dateTime(c.createdAt)}</div></div></li>
                <li><span className="dot attesa" aria-hidden="true" /><div><div style={{ fontWeight: 500 }}>Proposta inviata nel gruppo</div><div className="tiny muted">{dateTime(c.createdAt)}</div></div></li>
                {c.actions.map((a) => (
                  <li key={a.id}>
                    <span className={`dot ${a.state === "fallita" ? "errore" : a.state === "fatta" ? "accent" : ""}`} aria-hidden="true" />
                    <div>
                      <div style={{ fontWeight: 500 }}>{a.by} {ACTION_TEXT[a.type] ?? a.type} dalla dashboard</div>
                      <div className="tiny muted">{dateTime(a.at)}{a.state === "fallita" && a.outcome ? ` · non riuscita` : a.state === "in_coda" || a.state === "in_corso" ? " · in corso" : ""}</div>
                    </div>
                  </li>
                ))}
                {c.approvedBy && !c.actions.some((a) => a.type === "approva" && a.state === "fatta") && (
                  <li><span className="dot accent" aria-hidden="true" /><div><div style={{ fontWeight: 500 }}>Approvata su WhatsApp da {c.approvedBy}</div></div></li>
                )}
                {["completata", "errore", "annullata", "ripristinata", "scaduta", "programmata"].includes(c.status) && (
                  <li>
                    <span className={`dot ${c.status === "completata" ? "ok" : c.status === "errore" ? "errore" : ""}`} aria-hidden="true" />
                    <div>
                      <div style={{ fontWeight: 500 }}>
                        {{ completata: "Messa online", errore: "Modifica non riuscita", annullata: "Annullata", ripristinata: "Sito rimesso com'era", scaduta: "Scaduta senza ok", programmata: "Messa in programma" }[c.status as string]}
                      </div>
                      <div className="tiny muted">{dateTime(c.updatedAt)}</div>
                    </div>
                  </li>
                )}
              </ol>
            </div>
          </section>
        </div>
      </div>
    </>
  );
}
