import { getSession } from "@/lib/auth";
import { report } from "@/lib/data";
import { monthRange, validMonth } from "@/lib/format";

export const dynamic = "force-dynamic";

/** Report mensile per cliente in CSV (separatore punto e virgola, per Excel in italiano). */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession();
  if (!session?.isAgency) return new Response("Non autorizzato", { status: 403 });
  const month = validMonth(new URL(request.url).searchParams.get("mese") ?? undefined);
  const range = monthRange(month);
  const rows = await report(session, range.from, range.to);

  const cell = (value: string | number) => {
    let text = typeof value === "number" ? String(value).replace(".", ",") : value;
    // Evita che Excel interpreti come formula un nome che inizia con = + - @
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return /[";\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [
    ["Cliente", "Mese", "Richieste", "Online", "Non riuscite", "In sospeso", "Tempo medio (min)", "Costo AI ($)", "Tetto mensile ($)"],
    ...rows.map((r) => [r.client, month, r.requests, r.online, r.failed, r.pending, r.avgMinutes === null ? "" : Math.round(r.avgMinutes), Number(r.costUsd.toFixed(4)), r.budgetUsd]),
  ].map((line) => line.map(cell).join(";"));

  return new Response(`﻿${lines.join("\r\n")}\r\n`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="report-commesse-${month}.csv"`,
    },
  });
}
