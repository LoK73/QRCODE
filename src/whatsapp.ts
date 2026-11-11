import crypto from "node:crypto";

/**
 * Integrazione con la WhatsApp Business Platform (Cloud API) di Meta.
 *
 * - I messaggi in arrivo (privati e di gruppo) arrivano tutti sul webhook
 *   "messages"; quelli di gruppo hanno in più il campo `group_id`.
 * - Per scrivere nel gruppo si usa lo stesso endpoint /messages con
 *   recipient_type "group" e `to` = group_id.
 *
 * Doc: https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging
 */

export type MediaKind = "image" | "document" | "audio";

export interface MediaRef {
  /** ID del file su WhatsApp: serve a scaricarlo. */
  id: string;
  kind: MediaKind;
  mimeType: string;
  filename?: string;
}

export interface IncomingMessage {
  /** ID del messaggio (wamid…), usato per non elaborare due volte lo stesso messaggio. */
  id: string;
  /** Dove rispondere: group_id per i gruppi, numero del mittente per le chat private. */
  chatId: string;
  chatType: "group" | "individual";
  /** Numero del mittente (wa_id). */
  from: string;
  /** Nome profilo WhatsApp del mittente, se disponibile. */
  fromName?: string;
  /** Testo del messaggio o didascalia dell'allegato; vuoto per allegati senza testo. */
  text: string;
  timestamp: number;
  /** Foto, documento o vocale allegato. */
  media?: MediaRef;
  /** ID del messaggio a cui questo risponde (funzione "Rispondi" di WhatsApp). */
  replyTo?: string;
}

export interface WhatsAppOptions {
  accessToken: string;
  phoneNumberId: string;
  graphVersion: string;
  fetch?: typeof fetch;
}

/** Oltre questa dimensione un allegato non viene scaricato. */
export const MAX_MEDIA_BYTES = 15 * 1024 * 1024;

export class WhatsAppClient {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: WhatsAppOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  private get base(): string {
    return `https://graph.facebook.com/${this.opts.graphVersion}`;
  }

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.opts.accessToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string; code?: number } };
    if (!res.ok) {
      throw new Error(
        `WhatsApp API ${method} ${path} → ${res.status}: ${data.error?.message ?? res.statusText} (codice ${data.error?.code ?? "?"})`,
      );
    }
    return data;
  }

  /** Invia un messaggio di testo nel gruppo o nella chat privata; restituisce l'ID del messaggio inviato. */
  async sendText(chatId: string, chatType: "group" | "individual", text: string): Promise<string | undefined> {
    const data = await this.call<{ messages?: Array<{ id?: string }> }>("POST", `/${this.opts.phoneNumberId}/messages`, {
      messaging_product: "whatsapp",
      recipient_type: chatType,
      to: chatId,
      type: "text",
      text: { preview_url: true, body: text.slice(0, 4096) },
    });
    return data.messages?.[0]?.id;
  }

  /** Scarica un allegato (foto, PDF, vocale) ricevuto in un messaggio. */
  async downloadMedia(mediaId: string): Promise<{ data: Buffer; mimeType: string }> {
    const meta = await this.call<{ url?: string; mime_type?: string; file_size?: number }>("GET", `/${mediaId}`);
    if (!meta.url) throw new Error(`Allegato ${mediaId} non disponibile`);
    if (meta.file_size && meta.file_size > MAX_MEDIA_BYTES) {
      throw new Error(`Allegato troppo grande (${Math.round(meta.file_size / 1024 / 1024)} MB)`);
    }
    const res = await this.fetchFn(meta.url, { headers: { Authorization: `Bearer ${this.opts.accessToken}` } });
    if (!res.ok) throw new Error(`Download dell'allegato non riuscito (${res.status})`);
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length > MAX_MEDIA_BYTES) throw new Error("Allegato troppo grande");
    const mimeType = (meta.mime_type ?? res.headers.get("content-type") ?? "application/octet-stream")
      .split(";")[0]
      .trim()
      .toLowerCase();
    return { data, mimeType };
  }

  /** Crea un gruppo. Il link d'invito arriva nel webhook group_lifecycle_update. */
  async createGroup(subject: string, description?: string): Promise<unknown> {
    return this.call("POST", `/${this.opts.phoneNumberId}/groups`, {
      messaging_product: "whatsapp",
      subject,
      ...(description ? { description } : {}),
    });
  }

  async getInviteLink(groupId: string): Promise<unknown> {
    return this.call("GET", `/${groupId}/invite_link`);
  }
}

/** Verifica la firma X-Hub-Signature-256 che Meta aggiunge a ogni chiamata del webhook. */
export function verifySignature(rawBody: Buffer, signatureHeader: string | undefined, appSecret: string): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const received = signatureHeader.slice("sha256=".length);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(received, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Estrae dal payload del webhook i messaggi di testo e quelli con foto,
 * documenti o vocali. Ignora stati di consegna, reazioni, sticker, ecc.
 */
export function parseWebhook(payload: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const body = payload as WebhookPayload;
  if (body?.object !== "whatsapp_business_account") return out;

  for (const entry of body.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages") continue;
      const value = change.value ?? {};
      const ownNumber = value.metadata?.display_phone_number;
      const names = new Map((value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of value.messages ?? []) {
        if (!m.from || !m.id) continue;
        if (ownNumber && m.from === ownNumber) continue; // eco dei messaggi del bot

        let text: string | undefined;
        let media: MediaRef | undefined;
        if (m.type === "text") text = m.text?.body;
        else if (m.type === "button") text = m.button?.text;
        else if (m.type === "image" && m.image?.id) {
          text = m.image.caption ?? "";
          media = { id: m.image.id, kind: "image", mimeType: cleanMime(m.image.mime_type, "image/jpeg") };
        } else if (m.type === "document" && m.document?.id) {
          text = m.document.caption ?? "";
          media = {
            id: m.document.id,
            kind: "document",
            mimeType: cleanMime(m.document.mime_type, "application/octet-stream"),
            filename: m.document.filename,
          };
        } else if (m.type === "audio" && m.audio?.id) {
          text = "";
          media = { id: m.audio.id, kind: "audio", mimeType: cleanMime(m.audio.mime_type, "audio/ogg") };
        }
        if (text === undefined) continue;
        text = text.trim();
        if (!text && !media) continue;

        const isGroup = Boolean(m.group_id);
        out.push({
          id: m.id,
          chatId: isGroup ? m.group_id! : m.from,
          chatType: isGroup ? "group" : "individual",
          from: m.from,
          fromName: names.get(m.from) ?? undefined,
          text,
          timestamp: Number(m.timestamp ?? Math.floor(Date.now() / 1000)),
          ...(media ? { media } : {}),
          ...(m.context?.id ? { replyTo: m.context.id } : {}),
        });
      }
    }
  }
  return out;
}

function cleanMime(value: string | undefined, fallback: string): string {
  return (value ?? fallback).split(";")[0].trim().toLowerCase() || fallback;
}

/**
 * Eventi sui gruppi (creazione, ingressi, impostazioni). Li registriamo nel log:
 * da qui si leggono il group_id e l'invite_link del gruppo appena creato.
 */
export function groupEvents(payload: unknown): Array<{ field: string; value: unknown }> {
  const body = payload as WebhookPayload;
  if (body?.object !== "whatsapp_business_account") return [];
  return (body.entry ?? []).flatMap((e) =>
    (e.changes ?? [])
      .filter((c) => c.field?.startsWith("group_"))
      .map((c) => ({ field: c.field!, value: c.value })),
  );
}

interface MediaPayload {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

interface WebhookPayload {
  object?: string;
  entry?: Array<{
    changes?: Array<{
      field?: string;
      value?: {
        metadata?: { display_phone_number?: string; phone_number_id?: string };
        contacts?: Array<{ wa_id: string; profile?: { name?: string } }>;
        messages?: Array<{
          id: string;
          from?: string;
          group_id?: string;
          timestamp?: string;
          type?: string;
          text?: { body?: string };
          button?: { text?: string };
          image?: MediaPayload;
          document?: MediaPayload;
          audio?: MediaPayload;
          context?: { id?: string };
        }>;
      };
    }>;
  }>;
}
