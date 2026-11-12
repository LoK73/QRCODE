import { proposalEmail, type EmailSender } from "./email.js";
import type { Commessa } from "./store.js";
import type { PgStore, Tenant } from "./store-pg.js";

/**
 * Manda un'email ai responsabili quando un cliente riceve una nuova proposta.
 * Chi riceve l'email dipende da chi approva: i responsabili del cliente oppure
 * l'agenzia (vedi PgStore.proposalRecipients). Chi non vuole le email le
 * disattiva dal proprio profilo in dashboard.
 */
export function proposalNotifier(
  store: Pick<PgStore, "proposalRecipients">,
  sender: EmailSender,
  dashboardUrl: string,
): (tenant: Tenant, c: Commessa) => Promise<void> {
  return async (tenant, c) => {
    const to = await store.proposalRecipients(tenant.id);
    if (!to.length) return;
    const email = proposalEmail({
      clientName: tenant.name,
      id: c.id,
      summary: c.summary,
      details: c.details,
      requesterName: c.requesterName ?? "Qualcuno",
      link: `${dashboardUrl}/commesse/${c.id}`,
    });
    // Un'email per destinatario: nessuno vede gli indirizzi degli altri.
    for (const address of to) await sender.send({ ...email, to: [address] });
  };
}

/** Esegue una funzione subito e poi ogni giorno; gli errori finiscono nel log. */
export function daily(name: string, fn: () => Promise<unknown>): NodeJS.Timeout {
  const run = () => fn().catch((err) => console.error(`[${name}] errore:`, err));
  void run();
  const timer = setInterval(run, 86_400_000);
  timer.unref();
  return timer;
}
