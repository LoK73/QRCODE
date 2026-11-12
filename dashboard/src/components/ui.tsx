import Link from "next/link";
import { STATUS, type Status } from "@/lib/format";

export function StatusBadge({ status }: { status: Status }) {
  const s = STATUS[status] ?? { label: status, tone: "chiusa" };
  return <span className={`badge ${s.tone}`}>{s.label}</span>;
}

/** Messaggio di esito dopo un'azione (arriva nei parametri dell'indirizzo). */
export function Notice({ params }: { params: { ok?: string; errore?: string } }) {
  if (params.errore) return <p role="alert" className="notice errore">{params.errore}</p>;
  if (params.ok) return <p role="status" className="notice ok">{params.ok}</p>;
  return null;
}

export function Arrow() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14" /><path d="M13 6l6 6-6 6" />
    </svg>
  );
}

/** "650€ → 590€" in forma grafica, a partire dal dettaglio scritto dal bot. */
export function Change({ detail }: { detail: string }) {
  const parts = detail.split("→").map((p) => p.trim());
  if (parts.length !== 2) return <span className="small muted">{detail}</span>;
  return (
    <span className="change">
      <span className="old">{parts[0]}</span>
      <span className="muted"><Arrow /></span>
      <span className="new">{parts[1]}</span>
    </span>
  );
}

export function Pill({ href, current, label, count }: { href: string; current: boolean; label: string; count?: number }) {
  return (
    <Link href={href} className="pill" aria-current={current ? "true" : undefined}>
      {label}
      {count !== undefined && <span className="count">{count}</span>}
    </Link>
  );
}

/** Evidenzia la parte che cambia tra due testi (prefisso e suffisso comuni restano normali). */
export function Diff({ before, after }: { before: string; after: string }) {
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  // Allargo ai confini di parola, così non si evidenziano mezze parole o mezze cifre.
  while (start > 0 && /[\p{L}\p{N}.,€]/u.test(before[start - 1])) start--;
  while (end > 0 && /[\p{L}\p{N}.,€]/u.test(before[before.length - end] ?? "")) end--;
  const head = before.slice(0, start);
  const tail = end ? before.slice(before.length - end) : "";
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  return (
    <div className="diff">
      <div>
        <span className="label">Prima</span>
        <p>{before ? <>{head}{removed && <del>{removed}</del>}{tail}</> : <span className="muted">(vuoto)</span>}</p>
      </div>
      <div className="after">
        <span className="label">Dopo</span>
        <p>{after ? <>{head}{added && <ins>{added}</ins>}{tail}</> : <span className="muted">(vuoto)</span>}</p>
      </div>
    </div>
  );
}
