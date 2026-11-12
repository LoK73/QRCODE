# Dashboard commesse

Interfaccia web della piattaforma: il team dell'agenzia segue e approva le modifiche ai siti
dei clienti, configura i clienti e controlla i costi; i clienti vedono e approvano le proprie
modifiche (anche da telefono).

| Pagina | Per chi | Cosa contiene |
|---|---|---|
| Panoramica | agenzia | modifiche da approvare, errori, siti non raggiungibili, costo AI del mese |
| Commesse | tutti | elenco con filtri; per i clienti diventa "Modifiche al sito" con schede da approvare |
| Dettaglio commessa | tutti | cosa cambia (prima/dopo), conversazione WhatsApp, cronologia, approva/annulla/ripristina/rifai |
| Clienti | agenzia e operatori | sito WordPress con prova di connessione, chat WhatsApp, responsabili, regole |
| Report e costi | agenzia | richieste, tempi e costo AI per cliente e mese, esportazione CSV |
| Utenti | admin | ruoli e inviti |

## Come funziona

- **Permessi nel database.** La dashboard si collega a Postgres con un utente senza permessi
  propri (`dashboard_app`) e per ogni richiesta "diventa" l'utente collegato: valgono le regole
  RLS di `supabase/migrations`, quindi ognuno vede e modifica solo ciò che gli spetta.
- **Il bot esegue, la dashboard chiede.** Approvare, annullare, ripristinare o provare un sito
  crea una richiesta nella tabella `azioni`; il bot (worker) la esegue entro pochi secondi,
  scrive l'esito e avvisa il gruppo WhatsApp. Le pagine si aggiornano da sole.
- **Password dei siti.** La password applicazione di WordPress viene cifrata dal server della
  dashboard con `CREDENTIALS_KEY` (la stessa del bot) e salvata in una tabella che nessun utente
  può leggere.
- **Modifiche piccole e grandi.** Dall'elenco si approvano solo le modifiche piccole (un prezzo,
  una frase); per le altre bisogna aprire il dettaglio e guardare il prima/dopo.

## Installazione

```bash
cd dashboard
npm install
cp .env.example .env.local   # e compila i valori
npm run build
npm start
```

Il modo più semplice per pubblicarla è Vercel (cartella `dashboard` come "Root Directory").
Le variabili sono descritte in [.env.example](.env.example); `NEXT_PUBLIC_AGENCY_NAME` mostra
il nome dell'agenzia sotto il logo.

## Provarla in locale senza Supabase

Con un Postgres locale e il bot di prova (siti finti, nessuna chiamata esterna):

```bash
# database: schema finto di Supabase + migrazioni
psql -d commesse_demo -f ../supabase/tests/finto-supabase.sql
for f in ../supabase/migrations/*.sql; do psql -d commesse_demo -f "$f"; done
# utente della dashboard (vedi ../supabase/configurazione.sql) e, solo in locale,
# il permesso di elencare gli utenti per il login di prova:
psql -d commesse_demo -c "grant select on public.profiles to dashboard_app" \
  -c "create policy dev_profiles on public.profiles for select to dashboard_app using (true)"

# bot di prova (dalla cartella principale): crea 3 clienti e alcune commesse
DATABASE_URL=postgres://.../commesse_demo CREDENTIALS_KEY=$(openssl rand -base64 32) npm run demo

# dashboard con login di prova (si sceglie l'utente da un elenco)
DATABASE_URL=postgres://dashboard_app:...@localhost/commesse_demo DEV_AUTH=1 CREDENTIALS_KEY=<la stessa> npm run dev
```

Il login di prova si attiva solo con `DEV_AUTH=1` **e** senza `NEXT_PUBLIC_SUPABASE_URL`: in
produzione è sempre spento.
