import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, it } from "node:test";
import { parseCommand } from "../src/commands.js";
import { parseWebhook, verifySignature } from "../src/whatsapp.js";

describe("parseCommand", () => {
  it("riconosce i comandi con il riferimento", () => {
    assert.deepEqual(parseCommand("ok 12"), { type: "approve", id: 12, loose: false });
    assert.deepEqual(parseCommand("OK #12"), { type: "approve", id: 12, loose: false });
    assert.deepEqual(parseCommand("ok rif. 12"), { type: "approve", id: 12, loose: false });
    assert.deepEqual(parseCommand("Confermo 3."), { type: "approve", id: 3, loose: false });
    assert.deepEqual(parseCommand("sì 4"), { type: "approve", id: 4, loose: false });
    assert.deepEqual(parseCommand("annulla 7"), { type: "cancel", id: 7, loose: false });
    assert.deepEqual(parseCommand("no 7"), { type: "cancel", id: 7, loose: false });
    assert.deepEqual(parseCommand("ripristina 5"), { type: "revert", id: 5, force: false });
    assert.deepEqual(parseCommand("ripristina 5 forza"), { type: "revert", id: 5, force: true });
    assert.deepEqual(parseCommand("stato 5"), { type: "status", id: 5 });
    assert.deepEqual(parseCommand("commesse"), { type: "list" });
    assert.deepEqual(parseCommand("aiuto"), { type: "help" });
  });

  it("riconosce le conferme naturali come 'loose'", () => {
    for (const t of ["ok", "Sì vai", "si, procedi pure!", "vai pure 👍", "perfetto, vai", "va bene", "sì"]) {
      assert.deepEqual(parseCommand(t), { type: "approve", loose: true }, t);
    }
    for (const t of ["lascia perdere", "no, aspetta", "annulla"]) {
      assert.deepEqual(parseCommand(t), { type: "cancel", loose: true }, t);
    }
  });

  it("non scambia la conversazione per comandi", () => {
    assert.equal(parseCommand("no"), undefined);
    assert.equal(parseCommand("ok ma prima controlla il prezzo"), undefined);
    assert.equal(parseCommand("Parigi ora costa 590€"), undefined);
    assert.equal(parseCommand("sì ma domani"), undefined);
  });
});

describe("webhook WhatsApp", () => {
  it("verifica la firma HMAC", () => {
    const body = Buffer.from('{"a":1}');
    const sig = "sha256=" + crypto.createHmac("sha256", "segreto").update(body).digest("hex");
    assert.equal(verifySignature(body, sig, "segreto"), true);
    assert.equal(verifySignature(body, sig, "altro"), false);
    assert.equal(verifySignature(body, undefined, "segreto"), false);
    assert.equal(verifySignature(body, "sha256=zz", "segreto"), false);
  });

  it("estrae i messaggi di gruppo e privati", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          id: "1",
          changes: [
            {
              field: "messages",
              value: {
                messaging_product: "whatsapp",
                metadata: { display_phone_number: "15550783881", phone_number_id: "106540352242922" },
                contacts: [{ profile: { name: "Tiago" }, wa_id: "16505551234" }],
                messages: [
                  {
                    from: "16505551234",
                    group_id: "HBgLMTY1",
                    id: "wamid.A",
                    timestamp: "1744344496",
                    text: { body: " Parigi a 590€ " },
                    type: "text",
                  },
                  { from: "16505551234", id: "wamid.B", timestamp: "1744344497", text: { body: "ciao" }, type: "text" },
                  { from: "16505551234", id: "wamid.C", timestamp: "1744344498", type: "image" },
                ],
              },
            },
          ],
        },
      ],
    };
    const msgs = parseWebhook(payload);
    assert.equal(msgs.length, 2);
    assert.deepEqual(msgs[0], {
      id: "wamid.A",
      chatId: "HBgLMTY1",
      chatType: "group",
      from: "16505551234",
      fromName: "Tiago",
      text: "Parigi a 590€",
      timestamp: 1744344496,
    });
    assert.equal(msgs[1].chatType, "individual");
    assert.equal(msgs[1].chatId, "16505551234");
  });
});
