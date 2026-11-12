import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";

const BASE = {
  WHATSAPP_ACCESS_TOKEN: "x",
  WHATSAPP_PHONE_NUMBER_ID: "1",
  WHATSAPP_VERIFY_TOKEN: "v",
  WHATSAPP_APP_SECRET: "s",
  WP_URL: "https://sito.example/",
  WP_USER: "bot",
  WP_APP_PASSWORD: "p",
};
const KEYS = [...Object.keys(BASE), "TRANSCRIPTION_API_KEY", "TRANSCRIPTION_URL", "TRANSCRIPTION_MODEL", "TRANSCRIPTION_LANGUAGE"];

describe("Configurazione dei vocali", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) delete process.env[k];
    Object.assign(process.env, BASE);
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("senza chiave i vocali restano disattivati", () => {
    assert.equal(loadConfig().transcription, undefined);
  });

  it("con la sola chiave usa Groq come servizio predefinito", () => {
    process.env.TRANSCRIPTION_API_KEY = "gsk_test";
    process.env.TRANSCRIPTION_URL = ""; // riga lasciata vuota nel file .env
    assert.deepEqual(loadConfig().transcription, {
      url: "https://api.groq.com/openai/v1/audio/transcriptions",
      apiKey: "gsk_test",
      model: "whisper-large-v3-turbo",
      language: "it",
    });
  });

  it("si può indicare un servizio diverso", () => {
    process.env.TRANSCRIPTION_API_KEY = "k";
    process.env.TRANSCRIPTION_URL = "https://stt.example/v1/audio/transcriptions";
    process.env.TRANSCRIPTION_MODEL = "altro-modello";
    const t = loadConfig().transcription;
    assert.equal(t?.url, "https://stt.example/v1/audio/transcriptions");
    assert.equal(t?.model, "altro-modello");
  });

  it("segnala un indirizzo impostato senza chiave", () => {
    process.env.TRANSCRIPTION_URL = "https://stt.example";
    assert.throws(() => loadConfig(), /manca TRANSCRIPTION_API_KEY/);
  });
});
