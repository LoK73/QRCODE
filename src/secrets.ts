import crypto from "node:crypto";

/**
 * Cifratura delle credenziali dei clienti (password applicazione di WordPress)
 * prima di salvarle nel database: AES-256-GCM con una chiave che sta solo
 * nell'ambiente del bot e del server della dashboard (CREDENTIALS_KEY).
 *
 * Formato: "v1:<iv>:<tag>:<testo cifrato>", ogni parte in base64.
 */

function key(keyBase64: string): Buffer {
  const k = Buffer.from(keyBase64, "base64");
  if (k.length !== 32) {
    throw new Error("CREDENTIALS_KEY deve essere di 32 byte in base64 (generala con: openssl rand -base64 32)");
  }
  return k;
}

export function encryptSecret(plain: string, keyBase64: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key(keyBase64), iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

export function decryptSecret(encrypted: string, keyBase64: string): string {
  const [version, iv, tag, data] = encrypted.split(":");
  if (version !== "v1" || !iv || !tag || data === undefined) throw new Error("Credenziale cifrata in un formato non riconosciuto");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(keyBase64), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}
