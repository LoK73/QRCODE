import Link from "next/link";
import { Change, StatusBadge } from "@/components/ui";
import { requestAction } from "@/lib/actions";
import type { CommessaRow } from "@/lib/data";
import { ago } from "@/lib/format";

const ACTION_LABEL: Record<string, string> = {
  approva: "Approvazione in corso…",
  annulla: "Annullamento in corso…",
  ripristina: "Ripristino in corso…",
  ripristina_forza: "Ripristino in corso…",
  riprova: "La sto rifacendo…",
};

/**
 * Una commessa in attesa, con ciò che cambia e i pulsanti per decidere.
 * "Approva" compare solo per le modifiche piccole: per le altre si apre il dettaglio.
 */
export function CommessaItem({ c, canDecide, from, showClient = true }: { c: CommessaRow; canDecide: boolean; from: string; showClient?: boolean }) {
  return (
    <div className="item">
      <div className="item-text">
        <div className="inline small muted">
          {showClient && <span className="strong" style={{ color: "var(--ink)" }}>{c.clientName}</span>}
          <span>rif. {c.id}</span>
          <span>· {c.requesterName}, {ago(c.createdAt)}</span>
        </div>
        <Link href={`/commesse/${c.id}`} className="item-title" style={{ color: "var(--ink)" }}>{c.summary}</Link>
        {c.details.slice(0, 3).map((d, i) => <Change key={i} detail={d} />)}
        {c.details.length > 3 && <span className="small muted">e altre {c.details.length - 3} modifiche</span>}
      </div>
      {c.pendingAction ? (
        <span role="status" className="badge corso">{ACTION_LABEL[c.pendingAction] ?? "In corso…"}</span>
      ) : c.status !== "in_attesa" ? (
        <StatusBadge status={c.status} />
      ) : (
        <div className="inline">
          <Link href={`/commesse/${c.id}`} className="btn">{c.small ? "Dettagli" : "Apri e controlla"}</Link>
          {canDecide && c.small && (
            <form action={requestAction}>
              <input type="hidden" name="commessa" value={c.id} />
              <input type="hidden" name="tipo" value="approva" />
              <input type="hidden" name="from" value={from} />
              <button type="submit" className="btn primary">Approva</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}
