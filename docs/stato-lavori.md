# Stato dei lavori (aggiornato al 12 novembre 2026)

Nota per riprendere il lavoro in una nuova sessione.

## Fatto
- Bot WhatsApp (singolo cliente `src/index.ts`, piattaforma multi-cliente `src/worker.ts`),
  dashboard Next.js in `dashboard/`, 146 test verdi (`npm test`).
- Supabase: progetto **commesse-whatsapp** (`ktrrbpbyobgbjeanijws`, organizzazione brAIn's Project,
  Francoforte) con tutte le migrazioni di `supabase/migrations` applicate e controlli di sicurezza puliti.
- Utente del database per la dashboard `dashboard_app` creato (password consegnata al titolare,
  non salvata nel repository).
- Admin della dashboard: `uniquestudio.web@gmail.com` (ruolo admin_agenzia).

## Prossimi passi
1. **Pubblicare la dashboard su Vercel** (piano gratuito per le prove; Pro con clienti veri):
   progetto dal repository `lok73/qrcode`, Root Directory `dashboard`, variabili dal file
   `vercel-variabili.env` che il titolare ha salvato (NEXT_PUBLIC_SUPABASE_URL,
   NEXT_PUBLIC_SUPABASE_ANON_KEY, DATABASE_URL, CREDENTIALS_KEY, NEXT_PUBLIC_AGENCY_NAME).
2. Su Supabase → Authentication → URL Configuration: Site URL = indirizzo Vercel.
3. Primo accesso alla dashboard con l'admin e verifica delle pagine.
4. Server per il bot (Railway, Fly.io, Render o VPS) con `npm run start:piattaforma`,
   stessa CREDENTIALS_KEY, `DATABASE_URL` diretta (utente postgres), WHATSAPP_*, ANTHROPIC_API_KEY.
5. Pilota: numero WhatsApp verificato da Meta, WordPress di un cliente.

## Da sapere
- I segreti (password del database, CREDENTIALS_KEY) non sono nel repository: li ha il titolare.
- Non mettere mai segreti nei commit.
