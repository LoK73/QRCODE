/**
 * Configurazione letta dalle variabili d'ambiente (vedi .env.example).
 */

export interface Config {
  port: number;
  databasePath: string;

  whatsapp: {
    /** Token di accesso permanente (System User) della WhatsApp Cloud API. */
    accessToken: string;
    /** ID del numero di telefono business (Phone Number ID). */
    phoneNumberId: string;
    /** Token scelto da te per la verifica del webhook (hub.verify_token). */
    verifyToken: string;
    /** App Secret dell'app Meta: serve a verificare la firma X-Hub-Signature-256. */
    appSecret: string;
    graphVersion: string;
  };

  wordpress: {
    /** URL del sito, es. https://www.agenziaviaggi.it */
    url: string;
    /** Utente WordPress con cui il bot lavora (meglio un utente "Editor" dedicato). */
    user: string;
    /** Application Password generata in Utenti → Profilo → Password applicazioni. */
    appPassword: string;
    /** Tipi di contenuto che il bot può toccare (slug), es. post,page,viaggio */
    postTypes: string[];
    /** Abilita la modifica dei prezzi dei prodotti WooCommerce. */
    woocommerce: boolean;
  };

  anthropic: {
    model: string;
    effort: "low" | "medium" | "high" | "xhigh" | "max";
  };

  /** Gruppi (group_id) da cui il bot accetta richieste. Vuoto = nessun gruppo. */
  allowedGroups: string[];
  /** Numeri (wa_id, es. 393331234567) che possono scrivere al bot in privato. */
  allowedSenders: string[];
  /** Numeri autorizzati ad approvare / annullare / ripristinare le commesse. */
  approvers: string[];
  /**
   * Se impostato, il bot interpreta solo i messaggi che iniziano con questo
   * prefisso (es. "#sito"). I comandi (ok 12, annulla 12, …) funzionano sempre.
   */
  triggerPrefix: string;
  /** Dopo quante ore una proposta rimasta senza OK scade. */
  proposalTtlHours: number;
  /** Fuso orario per le date nei messaggi e per le modifiche programmate. */
  timezone: string;
  /** Dopo ogni modifica apre la pagina pubblica per controllare che si veda. */
  verifyPublic: boolean;
  /** Servizio di trascrizione dei vocali (facoltativo). */
  transcription?: {
    url: string;
    apiKey: string;
    model: string;
    language: string;
  };
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Variabile d'ambiente mancante: ${name} (vedi .env.example)`);
  }
  return value;
}

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Normalizza un numero di telefono nel formato wa_id (solo cifre, senza +). */
export function normalizePhone(phone: string): string {
  return phone.replace(/[^\d]/g, "");
}

const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export function loadConfig(): Config {
  const effort = (process.env.ANTHROPIC_EFFORT ?? "medium").trim();
  if (!EFFORTS.includes(effort as Config["anthropic"]["effort"])) {
    throw new Error(`ANTHROPIC_EFFORT non valido: ${effort} (valori: ${EFFORTS.join(", ")})`);
  }

  const ttl = Number(process.env.PROPOSAL_TTL_HOURS ?? 24);
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("PROPOSAL_TTL_HOURS deve essere un numero maggiore di zero");

  const transcriptionUrl = process.env.TRANSCRIPTION_URL?.trim();
  const transcriptionKey = process.env.TRANSCRIPTION_API_KEY?.trim();
  if (Boolean(transcriptionUrl) !== Boolean(transcriptionKey)) {
    throw new Error("Per i vocali servono sia TRANSCRIPTION_URL sia TRANSCRIPTION_API_KEY (oppure nessuno dei due)");
  }

  return {
    port: Number(process.env.PORT ?? 3000),
    databasePath: process.env.DATABASE_PATH ?? "data/commesse.db",
    whatsapp: {
      accessToken: required("WHATSAPP_ACCESS_TOKEN"),
      phoneNumberId: required("WHATSAPP_PHONE_NUMBER_ID"),
      verifyToken: required("WHATSAPP_VERIFY_TOKEN"),
      appSecret: required("WHATSAPP_APP_SECRET"),
      graphVersion: process.env.WHATSAPP_GRAPH_VERSION ?? "v27.0",
    },
    wordpress: {
      url: required("WP_URL").replace(/\/+$/, ""),
      user: required("WP_USER"),
      appPassword: required("WP_APP_PASSWORD"),
      postTypes: list("WP_POST_TYPES").length ? list("WP_POST_TYPES") : ["post", "page"],
      woocommerce: process.env.WP_WOOCOMMERCE === "true",
    },
    anthropic: {
      model: process.env.ANTHROPIC_MODEL ?? "claude-opus-5-5",
      effort: effort as Config["anthropic"]["effort"],
    },
    allowedGroups: list("ALLOWED_GROUPS"),
    allowedSenders: list("ALLOWED_SENDERS").map(normalizePhone),
    approvers: list("APPROVERS").map(normalizePhone),
    triggerPrefix: (process.env.TRIGGER_PREFIX ?? "").trim(),
    proposalTtlHours: ttl,
    timezone: (process.env.TIMEZONE ?? "Europe/Rome").trim(),
    verifyPublic: process.env.VERIFY_PUBLIC !== "false",
    transcription:
      transcriptionUrl && transcriptionKey
        ? {
            url: transcriptionUrl,
            apiKey: transcriptionKey,
            model: (process.env.TRANSCRIPTION_MODEL ?? "whisper-1").trim(),
            language: (process.env.TRANSCRIPTION_LANGUAGE ?? "it").trim(),
          }
        : undefined,
  };
}
