import Link from "next/link";
import { redirect } from "next/navigation";
import { Notice } from "@/components/ui";
import { createClientAction } from "@/lib/actions";
import { requireSession } from "@/lib/auth";

export const metadata = { title: "Nuovo cliente" };

export default async function NewClientPage({ searchParams }: { searchParams: Promise<{ errore?: string }> }) {
  const session = await requireSession();
  if (!session.isAgency) redirect("/clienti");
  const params = await searchParams;
  return (
    <>
      <Link href="/clienti" className="inline" style={{ minHeight: 44, alignSelf: "flex-start" }}>← Clienti</Link>
      <div className="head-text">
        <h1>Nuovo cliente</h1>
        <p className="sub">Dopo il nome si collegano il sito WordPress, il gruppo WhatsApp e i responsabili.</p>
      </div>
      <Notice params={params} />
      <section className="card" style={{ maxWidth: 640 }}>
        <div className="card-body">
          <form action={createClientAction} className="fields">
            <div className="field">
              <label htmlFor="name">Nome del cliente</label>
              <input id="name" name="name" type="text" required autoComplete="off" />
            </div>
            <div className="field">
              <label htmlFor="sector">Settore</label>
              <input id="sector" name="sector" type="text" placeholder="es. agenzia di viaggi, ristorante, studio medico" autoComplete="off" />
              <span className="hint">Aiuta l'assistente a capire di cosa parlano le richieste.</span>
            </div>
            <div className="inline"><button type="submit" className="btn primary">Crea e continua</button></div>
          </form>
        </div>
      </section>
    </>
  );
}
