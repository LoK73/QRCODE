/**
 * Invio di email transazionali (notifiche "c'è una modifica da approvare").
 *
 * Usa l'API HTTP di Resend (resend.com): basta una chiave e un mittente su un
 * dominio verificato. È facoltativo: senza EMAIL_API_KEY le email non partono.
 */

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  html: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface ResendOptions {
  apiKey: string;
  /** Mittente, es. "Commesse sito <notifiche@tua-agenzia.it>". */
  from: string;
  fetch?: typeof fetch;
}

export class ResendSender implements EmailSender {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: ResendOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  async send(message: EmailMessage): Promise<void> {
    if (!message.to.length) return;
    const res = await this.fetchFn("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.opts.from, to: message.to, subject: message.subject, text: message.text, html: message.html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Invio email non riuscito (${res.status}): ${detail || res.statusText}`);
    }
  }
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Email "c'è una modifica da approvare", in testo semplice e HTML. */
export function proposalEmail(input: {
  clientName: string;
  id: number;
  summary: string;
  details: string[];
  requesterName: string;
  link: string;
}): Omit<EmailMessage, "to"> {
  const subject = `Da approvare: ${input.summary} (${input.clientName})`;
  const text = [
    `${input.requesterName} ha chiesto una modifica al sito di ${input.clientName}:`,
    "",
    input.summary,
    ...input.details.map((d) => `- ${d}`),
    "",
    `Controlla e approva: ${input.link}`,
    "",
    "La modifica è stata preparata da un assistente automatico e va online solo dopo l'ok.",
    "Puoi disattivare queste email dal tuo profilo nella dashboard.",
  ].join("\n");
  const html = `<!doctype html><html lang="it"><body style="font-family:Arial,sans-serif;color:#151a23;line-height:1.5">
<p>${escapeHtml(input.requesterName)} ha chiesto una modifica al sito di <strong>${escapeHtml(input.clientName)}</strong>:</p>
<p style="font-size:16px;font-weight:600;margin:16px 0 8px">${escapeHtml(input.summary)}</p>
${input.details.length ? `<ul>${input.details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>` : ""}
<p style="margin:24px 0"><a href="${escapeHtml(input.link)}" style="background:#2447d6;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Controlla e approva</a></p>
<p style="color:#5b6472;font-size:13px">La modifica è stata preparata da un assistente automatico e va online solo dopo l'ok (rif. ${input.id}).<br>Puoi disattivare queste email dal tuo profilo nella dashboard.</p>
</body></html>`;
  return { subject, text, html };
}
