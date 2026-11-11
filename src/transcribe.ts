/**
 * Trascrizione dei messaggi vocali.
 *
 * Claude non riceve audio, quindi i vocali vanno trascritti da un servizio
 * esterno. Questo client parla con qualunque servizio che esponga un endpoint
 * di trascrizione nel formato più diffuso: POST multipart con i campi `file`,
 * `model` e `language`, risposta JSON `{ "text": "…" }`. È facoltativo: senza
 * configurazione il bot chiede di scrivere il messaggio.
 */

export interface Transcriber {
  transcribe(audio: Buffer, mimeType: string): Promise<string>;
}

export interface HttpTranscriberOptions {
  /** URL completo dell'endpoint di trascrizione. */
  url: string;
  apiKey: string;
  model: string;
  /** Lingua attesa (codice ISO, es. "it"). */
  language?: string;
  fetch?: typeof fetch;
}

const EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/wav": "wav",
  "audio/webm": "webm",
};

export class HttpTranscriber implements Transcriber {
  private readonly fetchFn: typeof fetch;

  constructor(private readonly opts: HttpTranscriberOptions) {
    this.fetchFn = opts.fetch ?? fetch;
  }

  async transcribe(audio: Buffer, mimeType: string): Promise<string> {
    const type = mimeType.split(";")[0].trim().toLowerCase();
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(audio)], { type }), `vocale.${EXTENSIONS[type] ?? "ogg"}`);
    form.append("model", this.opts.model);
    if (this.opts.language) form.append("language", this.opts.language);

    const res = await this.fetchFn(this.opts.url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`Trascrizione non riuscita (${res.status}): ${detail || res.statusText}`);
    }
    const data = (await res.json()) as { text?: unknown };
    if (typeof data.text !== "string") throw new Error("Risposta della trascrizione senza testo");
    return data.text.trim();
  }
}
