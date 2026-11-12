export const TIMEZONE = "Europe/Rome";

export type Status =
  | "in_attesa" | "programmata" | "in_corso" | "completata" | "in_ripristino"
  | "errore" | "annullata" | "ripristinata" | "scaduta";

export const STATUS: Record<Status, { label: string; tone: "attesa" | "corso" | "ok" | "errore" | "chiusa" }> = {
  in_attesa: { label: "Aspetta l'ok", tone: "attesa" },
  programmata: { label: "In programma", tone: "corso" },
  in_corso: { label: "In pubblicazione", tone: "corso" },
  completata: { label: "Online", tone: "ok" },
  in_ripristino: { label: "In ripristino", tone: "corso" },
  errore: { label: "Non riuscita", tone: "errore" },
  annullata: { label: "Annullata", tone: "chiusa" },
  ripristinata: { label: "Rimessa com'era", tone: "chiusa" },
  scaduta: { label: "Scaduta", tone: "chiusa" },
};

export function ago(date: Date, now = new Date()): string {
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "adesso";
  if (minutes < 60) return `${minutes} min fa`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 ora fa" : `${hours} ore fa`;
  const days = Math.round(hours / 24);
  if (days === 1) return "ieri";
  if (days < 7) return `${days} giorni fa`;
  return dateTime(date);
}

export function dateTime(date: Date): string {
  return new Intl.DateTimeFormat("it-IT", { timeZone: TIMEZONE, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

export function day(date: Date): string {
  return new Intl.DateTimeFormat("it-IT", { timeZone: TIMEZONE, weekday: "long", day: "numeric", month: "long" }).format(date);
}

export function usd(value: number): string {
  return `${value.toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`;
}

export function duration(minutes: number | null): string {
  if (minutes === null || Number.isNaN(minutes)) return "–";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "2026-11" → primo giorno del mese e del mese successivo (UTC). */
export function monthRange(month: string): { from: string; to: string; label: string } {
  const [y, m] = month.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1));
  const to = new Date(Date.UTC(y, m, 1));
  const label = new Intl.DateTimeFormat("it-IT", { month: "long", year: "numeric", timeZone: "UTC" }).format(from);
  return { from: from.toISOString(), to: to.toISOString(), label };
}

export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function validMonth(value: string | undefined): string {
  return value && /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : currentMonth();
}
