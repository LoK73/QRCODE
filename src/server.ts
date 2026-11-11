import express, { type Request, type Response } from "express";
import { groupEvents, parseWebhook, verifySignature, type IncomingMessage } from "./whatsapp.js";

export interface ServerOptions {
  verifyToken: string;
  appSecret: string;
  /** Mette il messaggio in coda (in modo sincrono e durevole); l'elaborazione avviene dopo. */
  onMessage: (msg: IncomingMessage) => void;
}

/**
 * Server HTTP con il webhook per Meta:
 *   GET  /webhook  → verifica iniziale (hub.challenge)
 *   POST /webhook  → notifiche dei messaggi
 *   GET  /health   → controllo di stato
 */
export function createServer(opts: ServerOptions) {
  const app = express();

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/webhook", (req: Request, res: Response) => {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === opts.verifyToken && typeof challenge === "string") {
      res.status(200).type("text/plain").send(challenge);
      return;
    }
    res.sendStatus(403);
  });

  // Serve il corpo grezzo per verificare la firma HMAC.
  app.post("/webhook", express.raw({ type: "*/*", limit: "2mb" }), (req: Request, res: Response) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifySignature(raw, req.header("x-hub-signature-256"), opts.appSecret)) {
      res.sendStatus(401);
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.sendStatus(400);
      return;
    }

    for (const ev of groupEvents(payload)) {
      console.log(`[webhook] evento ${ev.field}:`, JSON.stringify(ev.value));
    }

    // Prima salviamo i messaggi, poi rispondiamo: se il salvataggio fallisce
    // Meta riceve un errore e ripete la notifica, così nulla va perso.
    try {
      for (const msg of parseWebhook(payload)) opts.onMessage(msg);
    } catch (err) {
      console.error("[webhook] impossibile salvare i messaggi ricevuti:", err);
      res.sendStatus(500);
      return;
    }
    res.sendStatus(200);
  });

  return app;
}
