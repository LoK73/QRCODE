# Stato dei lavori (aggiornato al 12 novembre 2026)

Nota per riprendere il lavoro in una nuova sessione.

## Fatto
- Bot WhatsApp (singolo cliente `src/index.ts`, piattaforma multi-cliente `src/worker.ts`),
  dashboard Next.js in `dashboard/`, 148 test verdi (`npm test`).
- Supabase: progetto **commesse-whatsapp** (`ktrrbpbyobgbjeanijws`, organizzazione brAIn's Project,
  Francoforte) con tutte le migrazioni di `supabase/migrations` applicate e controlli di sicurezza puliti.
- Utente del database per la dashboard `dashboard_app` creato.
- **Dashboard pubblicata su Vercel** (piano gratuito): https://commesse-dashboard.vercel.app,
  progetto `commesse-dashboard` (account `lok73`, team `lok73s-projects`), Root Directory `dashboard`.
  `/login` risponde con il modulo di accesso. L'integrazione GitHub di Vercel non vede il
  repository, quindi non c'è pubblicazione automatica: si ripubblica dalla cartella principale con
  `npx vercel@latest deploy --prod --yes`.
- La password di `dashboard_app` e la `CREDENTIALS_KEY` sono state **rigenerate** il 12/11/2026 e
  stanno solo nelle variabili di Vercel: i valori del vecchio file `vercel-variabili.env` non
  valgono più. `CREDENTIALS_KEY` si può rileggere da Vercel (serve uguale al bot); `DATABASE_URL`
  è "sensitive" e non si rilegge (il bot usa comunque un'altra connessione).
- `DATABASE_URL` della dashboard: utente `dashboard_app.ktrrbpbyobgbjeanijws`, transaction pooler
  `aws-0-eu-central-1.pooler.supabase.com:6543` (connessione provata da Vercel).
- Admin della dashboard: `uniquestudio.web@gmail.com` (ruolo admin_agenzia).

- **Password dalla dashboard** (13/11/2026): "Password dimenticata?" nella pagina di accesso
  (`/recupero`), pagina `/nuova-password` per sceglierla dopo un invito o un recupero e dal profilo,
  arrivo dei link delle email in `/auth/conferma` o tramite il "#" dell'indirizzo. Provato in locale
  con link non validi; **non ancora provato con un'email vera** (invito o recupero).
- **Tempo massimo sulle chiamate a WordPress** (30 secondi): un sito che non risponde non tiene più
  fermo il bot per gli altri clienti.

- **Pubblicazione bloccata da Vercel (13/11/2026)**: sul piano gratuito Vercel accetta solo i commit
  il cui autore è il titolare dell'account. I commit fatti da Claude nel cloud hanno un altro autore,
  quindi la pubblicazione del 13/11 è rimasta "BLOCKED" e online c'è ancora la versione del 12/11
  (senza `/recupero` e `/nuova-password`). Si sblocca pubblicando dal computer del titolare, dopo un
  commit fatto con la sua identità git, oppure collegando il repository a Vercel.

## Prossimi passi
1. Su Supabase → Authentication → URL Configuration: Site URL = https://commesse-dashboard.vercel.app.
   Nella stessa pagina, tra i Redirect URLs, aggiungere `https://commesse-dashboard.vercel.app/**`.
   Poi provare un recupero password con un'email vera.
2. Primo accesso alla dashboard con l'admin e verifica delle pagine (non ancora provato).
3. Connessione cifrata al database: oggi la dashboard si collega al pooler senza TLS, perché il
   certificato di Supabase non è tra quelli riconosciuti da Node. Va aggiunto il certificato CA di
   Supabase in `dashboard/src/lib/db.ts` prima di usare dati di clienti veri.
4. Collegare il repository a Vercel (dare all'app GitHub di Vercel l'accesso a `lok73/qrcode`)
   per la pubblicazione automatica; piano Pro con clienti veri.
5. Server per il bot (Railway, Fly.io, Render o VPS) con `npm run start:piattaforma`,
   stessa CREDENTIALS_KEY (da Vercel), `DATABASE_URL` diretta (utente postgres), WHATSAPP_*, ANTHROPIC_API_KEY.
6. Pilota: numero WhatsApp verificato da Meta, WordPress di un cliente.

## Da sapere
- I segreti (password di `dashboard_app`, CREDENTIALS_KEY) non sono nel repository: stanno nelle
  variabili del progetto Vercel.
- Non mettere mai segreti nei commit.
