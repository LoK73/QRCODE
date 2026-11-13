import type { EmailOtpType } from "@supabase/supabase-js";
import { NextResponse, type NextRequest } from "next/server";
import { supabaseServer } from "@/lib/auth";

export const dynamic = "force-dynamic";

const TYPES = ["invite", "recovery", "signup", "magiclink", "email", "email_change"];

/**
 * Arrivo dai link delle email di Supabase quando i modelli usano il formato consigliato
 * ("{{ .SiteURL }}/auth/conferma?token_hash={{ .TokenHash }}&type=invite") oppure un codice.
 * Apre la sessione e manda a scegliere la password.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") ?? "";
  const code = url.searchParams.get("code");
  const to = (path: string, errore?: string) => {
    const target = new URL(path, url.origin);
    if (errore) target.searchParams.set("errore", errore);
    return NextResponse.redirect(target);
  };
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) return to("/login");

  const supabase = await supabaseServer();
  let failed = true;
  if (tokenHash && TYPES.includes(type)) {
    failed = Boolean((await supabase.auth.verifyOtp({ token_hash: tokenHash, type: type as EmailOtpType })).error);
  } else if (code) {
    failed = Boolean((await supabase.auth.exchangeCodeForSession(code)).error);
  }
  if (failed) return to("/recupero", "Il link non è più valido: forse è scaduto o è già stato usato. Chiedine uno nuovo.");
  return to("/nuova-password");
}
