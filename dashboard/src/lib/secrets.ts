import crypto from "node:crypto";

/**
 * Cifra la password applicazione di WordPress prima di salvarla.
 * Stesso formato usato dal bot (src/secrets.ts): "v1:<iv>:<tag>:<dati>" in base64.
 */
export function encryptSecret(plain: string): string {
  const key = Buffer.from(process.env.CREDENTIALS_KEY ?? "", "base64");
  if (key.length !== 32) throw new Error("CREDENTIALS_KEY mancante o non valida (servono 32 byte in base64)");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}
