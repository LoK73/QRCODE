import { errorMessage } from "./ai.js";
import type { Action, PgStore } from "./store-pg.js";
import type { TenantRegistry } from "./tenants.js";

/**
 * Esegue un'azione chiesta dalla dashboard (approva, annulla, ripristina,
 * riprova, prova del sito) e ne scrive l'esito, che la dashboard mostra a chi
 * l'ha chiesta. Per le commesse l'esito viene scritto anche nel gruppo WhatsApp.
 */
export async function runAction(action: Action, registry: TenantRegistry, store: PgStore): Promise<void> {
  let ok = false;
  let outcome: string;
  try {
    const entry = await registry.forClient(action.clientId);
    if (!entry) {
      outcome = "Cliente non trovato o sospeso.";
    } else if (action.type === "prova_sito") {
      if (!entry.wordpress) {
        outcome = `Non posso provare la connessione: ${entry.problem ?? "sito non configurato"}.`;
      } else {
        const check = await entry.wordpress.checkConnection();
        await store.saveSiteCheck(action.clientId, check);
        ok = check.ok;
        outcome = check.ok ? "Connessione riuscita." : check.problems.join(" ");
      }
    } else if (!entry.bot) {
      outcome = `Il bot non può lavorare per questo cliente: ${entry.problem ?? "configurazione incompleta"}.`;
    } else if (action.commessaId === undefined) {
      outcome = "Azione senza commessa.";
    } else {
      const id = action.commessaId;
      const result =
        action.type === "approva"
          ? await entry.bot.approveById(id, `${action.requestedBy} (dashboard)`)
          : action.type === "annulla"
            ? await entry.bot.cancelById(id)
            : action.type === "riprova"
              ? await entry.bot.retryById(id)
              : await entry.bot.revertById(id, action.type === "ripristina_forza");
      ok = result.ok;
      outcome = result.message;
    }
  } catch (err) {
    console.error(`[azioni] errore eseguendo l'azione ${action.id}:`, err);
    outcome = `Errore: ${errorMessage(err)}`;
  }
  await store.finishAction(action.id, ok, outcome);
}

/** Esegue tutte le azioni in coda, una alla volta. Restituisce quante ne ha eseguite. */
export async function drainActions(registry: TenantRegistry, store: PgStore): Promise<number> {
  let done = 0;
  for (let action = await store.claimAction(); action; action = await store.claimAction()) {
    await runAction(action, registry, store);
    done++;
  }
  return done;
}
