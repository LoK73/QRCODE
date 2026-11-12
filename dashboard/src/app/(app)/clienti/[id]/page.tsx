import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AutoRefresh } from "@/components/auto-refresh";
import { Notice } from "@/components/ui";
import { addChannel, addContact, removeChannel, removeContact, saveClient, saveSite, testSite } from "@/lib/actions";
import { canManage, requireSession } from "@/lib/auth";
import { getClient } from "@/lib/data";
import { ago, dateTime } from "@/lib/format";

export const metadata = { title: "Cliente" };

export default async function ClientPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; errore?: string }>;
}) {
  const session = await requireSession();
  const { id } = await params;
  if (!canManage(session, id)) redirect("/commesse");
  const notice = await searchParams;
  const c = await getClient(session, id);
  if (!c) notFound();

  const site = c.site;
  const check = site?.lastCheck ?? null;
  const steps = [
    { label: "Dati del cliente", done: true },
    { label: "Sito web", done: Boolean(site?.hasPassword && check?.ok) },
    { label: "Chat WhatsApp", done: c.channels.length > 0 },
    { label: "Responsabili", done: c.approvalRule === "agenzia" || c.contacts.some((p) => p.canApprove) },
  ];
  const ready = steps.every((s) => s.done);

  return (
    <>
      {site?.checking && <AutoRefresh seconds={3} />}
      <Link href="/clienti" className="inline" style={{ minHeight: 44, alignSelf: "flex-start" }}>← Clienti</Link>
      <div className="head">
        <div className="head-text">
          <h1>{c.name}</h1>
          <p className="sub">{c.sector || "Settore non indicato"} · {c.status === "attivo" ? (ready ? "il bot è operativo" : "configurazione da completare") : "sospeso"}</p>
        </div>
        <Link href={`/commesse?cliente=${c.id}`} className="btn">Vedi le commesse</Link>
      </div>
      <Notice params={notice} />

      <ol className="steps" aria-label="Passaggi di configurazione">
        {steps.map((s, i) => (
          <li key={s.label} className={s.done ? "done" : "todo"}>
            <span className="n">{s.done ? "✓" : i + 1}</span>{s.label}
          </li>
        ))}
      </ol>

      <div className="row">
        <div className="col-main">
          {/* ---------------- sito */}
          <section className="card" aria-labelledby="h-site">
            <div className="card-head">
              <h2 id="h-site">Sito WordPress</h2>
              {site?.hasPassword && (
                <form action={testSite}>
                  <input type="hidden" name="client" value={c.id} />
                  <button type="submit" className="btn outline" disabled={site.checking}>{site.checking ? "Controllo in corso…" : "Prova connessione"}</button>
                </form>
              )}
            </div>
            <div className="card-body">
              <form action={saveSite} className="fields">
                <input type="hidden" name="client" value={c.id} />
                <div className="field">
                  <label htmlFor="url">Indirizzo del sito</label>
                  <input id="url" name="url" type="text" inputMode="url" autoComplete="off" defaultValue={site?.url ?? ""} placeholder="www.sito-del-cliente.it" required />
                </div>
                <div className="fields-row">
                  <div className="field">
                    <label htmlFor="wp_user">Utente WordPress</label>
                    <input id="wp_user" name="wp_user" type="text" defaultValue={site?.user ?? ""} placeholder="bot-commesse" autoComplete="off" required />
                  </div>
                  <div className="field">
                    <label htmlFor="wp_app_password">Password applicazione</label>
                    <input id="wp_app_password" name="wp_app_password" type="password" autoComplete="new-password" placeholder={site?.hasPassword ? "già salvata: scrivi solo per sostituirla" : "xxxx xxxx xxxx xxxx xxxx xxxx"} required={!site?.hasPassword} />
                    <span className="hint">Viene salvata cifrata. La usa solo il bot e non è più leggibile da nessuno.</span>
                  </div>
                </div>
                <div className="field">
                  <label htmlFor="post_types">Contenuti che il bot può modificare</label>
                  <input id="post_types" name="post_types" type="text" defaultValue={(site?.postTypes ?? ["post", "page"]).join(", ")} />
                  <span className="hint">
                    Nomi tecnici separati da virgola.
                    {check?.availableTypes?.length ? ` Sul sito ci sono: ${check.availableTypes.map((t) => `${t.name} (${t.slug})`).join(", ")}.` : " Dopo la prova di connessione compare l'elenco di quelli presenti sul sito."}
                  </span>
                </div>
                <label className="check"><input type="checkbox" name="woocommerce" defaultChecked={site?.woocommerce ?? false} /><span>Il sito usa WooCommerce e il bot può cambiare i prezzi dei prodotti</span></label>
                <label className="check"><input type="checkbox" name="verify_public" defaultChecked={site?.verifyPublic ?? true} /><span>Dopo ogni modifica controlla la pagina pubblica prima di dire che è online</span></label>
                <div className="inline"><button type="submit" className="btn primary">Salva e prova la connessione</button></div>
              </form>

              {site?.checking && <p role="status" className="notice info">Il bot sta provando la connessione…</p>}
              {!site?.checking && check && (
                <div className={`check-result ${check.ok ? "" : "bad"}`} role="status">
                  <div className="strong" style={{ color: check.ok ? "var(--ok-fg)" : "var(--errore-fg)" }}>
                    {check.ok ? "Connessione riuscita" : "Connessione non riuscita"}
                    {site?.lastCheckAt && <span className="tiny muted" style={{ fontWeight: 400 }}> · {ago(site.lastCheckAt)}</span>}
                  </div>
                  <ul>
                    {check.problems.map((p) => <li key={p}>{p}</li>)}
                    {check.user && <li>Accesso con l'utente «{check.user.name}»{check.user.roles.length ? `, ruolo ${check.user.roles.join(", ")}` : ""}</li>}
                    {check.user && <li>Campi personalizzati (ACF): {check.acfVisible ? "visibili" : "non visibili (se li usate, attivate «Show in REST API»)"}</li>}
                    {check.user && <li>WooCommerce: {check.woocommerce ? "presente" : "non presente"}</li>}
                  </ul>
                </div>
              )}
              {!site?.checking && !check && site?.lastCheckOutcome && <p role="alert" className="notice errore">{site.lastCheckOutcome}</p>}
            </div>
          </section>

          {/* ---------------- WhatsApp */}
          <section className="card" aria-labelledby="h-wa">
            <div className="card-head"><h2 id="h-wa">Chat WhatsApp</h2></div>
            {c.channels.map((ch) => (
              <div key={ch.id} className="line-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{ch.name || (ch.chatType === "group" ? "Gruppo" : "Chat privata")}</div>
                  <div className="mono muted">{ch.chatId}</div>
                </div>
                <form action={removeChannel}>
                  <input type="hidden" name="client" value={c.id} />
                  <input type="hidden" name="channel" value={ch.id} />
                  <button type="submit" className="btn quiet">Scollega</button>
                </form>
              </div>
            ))}
            <div className="card-body">
              <form action={addChannel} className="fields">
                <input type="hidden" name="client" value={c.id} />
                {c.unlinkedChats.length > 0 ? (
                  <div className="field">
                    <label htmlFor="chat_id">Gruppi da cui il bot ha ricevuto messaggi</label>
                    <select id="chat_id" name="chat_id" defaultValue="">
                      <option value="">Scegli…</option>
                      {c.unlinkedChats.map((u) => (
                        <option key={u.chatId} value={u.chatId}>{u.lastSender}: «{u.lastText.slice(0, 50)}» · {ago(u.lastSeen)}</option>
                      ))}
                    </select>
                    <span className="hint">Riconosci il gruppo dall'ultimo messaggio. Dopo il collegamento sparisce da questo elenco.</span>
                  </div>
                ) : (
                  <p className="small muted">Per collegare un gruppo: aggiungi il numero del bot al gruppo e scrivi un messaggio. Il gruppo comparirà qui da scegliere.</p>
                )}
                <div className="fields-row">
                  <div className="field">
                    <label htmlFor="chat_id_manual">Oppure identificativo scritto a mano</label>
                    <input id="chat_id_manual" name="chat_id_manual" type="text" autoComplete="off" />
                  </div>
                  <div className="field">
                    <label htmlFor="ch_name">Nome da mostrare</label>
                    <input id="ch_name" name="name" type="text" placeholder={`Sito ${c.name}`} autoComplete="off" />
                  </div>
                  <div className="field" style={{ flex: "0 1 180px" }}>
                    <label htmlFor="chat_type">Tipo</label>
                    <select id="chat_type" name="chat_type" defaultValue="group"><option value="group">Gruppo</option><option value="individual">Chat privata (numero)</option></select>
                  </div>
                </div>
                <div className="inline"><button type="submit" className="btn">Collega la chat</button></div>
              </form>
            </div>
          </section>

          {/* ---------------- responsabili */}
          <section className="card" aria-labelledby="h-people">
            <div className="card-head"><h2 id="h-people">Persone del cliente su WhatsApp</h2></div>
            {c.contacts.map((p) => (
              <div key={p.id} className="line-row">
                <div>
                  <div style={{ fontWeight: 500 }}>{p.name || "Senza nome"}</div>
                  <div className="mono muted">+{p.waId}</div>
                </div>
                <div className="inline">
                  {p.canApprove ? <span className="badge ok">Può dare l'ok</span> : <span className="badge chiusa">Solo richieste</span>}
                  <form action={removeContact}>
                    <input type="hidden" name="client" value={c.id} />
                    <input type="hidden" name="contact" value={p.id} />
                    <button type="submit" className="btn quiet">Rimuovi</button>
                  </form>
                </div>
              </div>
            ))}
            <div className="card-body">
              <form action={addContact} className="fields">
                <input type="hidden" name="client" value={c.id} />
                <div className="fields-row">
                  <div className="field"><label htmlFor="p_name">Nome</label><input id="p_name" name="name" type="text" autoComplete="off" /></div>
                  <div className="field"><label htmlFor="wa_id">Numero WhatsApp</label><input id="wa_id" name="wa_id" type="text" placeholder="39 333 1234567" autoComplete="off" required /></div>
                </div>
                <label className="check"><input type="checkbox" name="can_approve" defaultChecked /><span>Può dare l'ok alle modifiche scrivendo nel gruppo</span></label>
                <div className="inline"><button type="submit" className="btn">Aggiungi</button></div>
              </form>
              <p className="small muted">Chiunque nel gruppo può chiedere una modifica; solo chi è indicato qui come responsabile può approvarla da WhatsApp.</p>
            </div>
          </section>
        </div>

        {/* ---------------- regole */}
        <div className="col-side">
          <section className="card" aria-labelledby="h-rules">
            <div className="card-head"><h2 id="h-rules">Dati e regole</h2></div>
            <div className="card-body">
              <form action={saveClient} className="fields">
                <input type="hidden" name="client" value={c.id} />
                <div className="field"><label htmlFor="name">Nome</label><input id="name" name="name" type="text" defaultValue={c.name} required /></div>
                <div className="field"><label htmlFor="sector">Settore</label><input id="sector" name="sector" type="text" defaultValue={c.sector} /></div>
                <div className="field">
                  <label htmlFor="status">Stato</label>
                  <select id="status" name="status" defaultValue={c.status}><option value="attivo">Attivo</option><option value="sospeso">Sospeso (il bot non risponde)</option></select>
                </div>
                <div className="field">
                  <label htmlFor="approval_rule">Chi approva le modifiche</label>
                  <select id="approval_rule" name="approval_rule" defaultValue={c.approvalRule}>
                    <option value="cliente">I responsabili del cliente (anche da WhatsApp) o l'agenzia</option>
                    <option value="agenzia">Solo l'agenzia, dalla dashboard</option>
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="profile">Scheda per l'assistente</label>
                  <textarea id="profile" name="profile" defaultValue={c.profile} placeholder={"Cosa vende il cliente, parole ricorrenti, dove stanno prezzi e date (es. campo «prezzo»), cose da non toccare."} />
                  <span className="hint">Più è precisa, meno domande farà l'assistente.</span>
                </div>
                <div className="field">
                  <label htmlFor="trigger_prefix">Parola di attivazione (facoltativa)</label>
                  <input id="trigger_prefix" name="trigger_prefix" type="text" defaultValue={c.triggerPrefix} placeholder="#sito" />
                  <span className="hint">Se impostata, l'assistente legge solo i messaggi che iniziano così.</span>
                </div>
                <div className="fields-row">
                  <div className="field"><label htmlFor="proposal_ttl_hours">Scadenza proposte (ore)</label><input id="proposal_ttl_hours" name="proposal_ttl_hours" type="number" min={1} defaultValue={c.proposalTtlHours} /></div>
                  <div className="field"><label htmlFor="monthly_budget_usd">Tetto AI mensile ($)</label><input id="monthly_budget_usd" name="monthly_budget_usd" type="text" inputMode="decimal" defaultValue={c.monthlyBudgetUsd} /></div>
                </div>
                <label className="check"><input type="checkbox" name="prefilter" defaultChecked={c.prefilter} /><span>Filtro economico: un modello piccolo scarta la conversazione che non riguarda il sito</span></label>
                <label className="check"><input type="checkbox" name="show_costs_to_client" defaultChecked={c.showCostsToClient} /><span>Mostra i costi dell'AI agli utenti del cliente</span></label>
                <div className="inline"><button type="submit" className="btn primary">Salva</button></div>
              </form>
            </div>
          </section>
          <p className="small muted">Le modifiche alle impostazioni arrivano al bot entro un minuto.{site?.lastCheckAt ? ` Ultima prova del sito: ${dateTime(site.lastCheckAt)}.` : ""}</p>
        </div>
      </div>
    </>
  );
}
