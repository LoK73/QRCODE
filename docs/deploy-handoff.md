# Passaggio di consegne: pubblicazione (12 novembre 2026)

Tutto quello che serve per riprendere la pubblicazione da un altro computer o da una nuova sessione.
Lo stato generale del progetto è in [stato-lavori.md](stato-lavori.md).

## Cosa è online

| Cosa | Dove |
|---|---|
| Dashboard | https://commesse-dashboard.vercel.app |
| Progetto Vercel | `commesse-dashboard`, account `lok73`, team `lok73s-projects` (`team_zKZYWwbxND1phVuu174WP5CP`), id `prj_UhfkzLRPDxXBKfkUMm8PvyA9VWnB`, piano gratuito |
| Impostazioni Vercel | Next.js, Root Directory `dashboard` |
| Database | Supabase **commesse-whatsapp** (`ktrrbpbyobgbjeanijws`, Francoforte) |
| Codice | `lok73/qrcode`, ramo `claude/happy-turing-uk5tio` |
| Bot | **non ancora pubblicato** |

## Variabili su Vercel (produzione e anteprima)

| Variabile | Valore | Si rilegge da Vercel? |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://ktrrbpbyobgbjeanijws.supabase.co` | sì |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | chiave pubblica `sb_publishable_…` | sì |
| `NEXT_PUBLIC_AGENCY_NAME` | `brAIn` | sì |
| `CREDENTIALS_KEY` | rigenerata il 12/11/2026 | sì (serve uguale al bot) |
| `DATABASE_URL` | utente `dashboard_app.ktrrbpbyobgbjeanijws`, pooler `aws-0-eu-central-1.pooler.supabase.com:6543`, password rigenerata il 12/11/2026 | no ("sensitive") |
| `SUPABASE_SERVICE_ROLE_KEY` | **non impostata**: senza, gli inviti dalla pagina Utenti non funzionano | — |

I segreti stanno solo su Vercel. I valori del vecchio file `vercel-variabili.env` non valgono più.
Se la password di `dashboard_app` va persa, se ne genera una nuova con `alter role dashboard_app password '…'`
su Supabase e si aggiorna `DATABASE_URL` su Vercel.

## Ripubblicare la dashboard dal proprio computer

L'integrazione GitHub di Vercel non vede il repository, quindi la pubblicazione è manuale.

```bash
git clone https://github.com/LoK73/QRCODE.git && cd QRCODE
git checkout claude/happy-turing-uk5tio
npx vercel@latest login                       # una volta sola
npx vercel@latest link --yes --project commesse-dashboard --scope lok73s-projects
npm test                                      # devono essere verdi
npx vercel@latest deploy --prod --yes         # dalla cartella principale, non da dashboard/
```

Controllo dopo la pubblicazione: `https://commesse-dashboard.vercel.app/login` deve rispondere 200 con il modulo
di accesso; la pagina principale deve rimandare a `/login`.

Per lavorare in locale: `cd dashboard && npx vercel@latest env pull .env.local` scarica le variabili
(tranne `DATABASE_URL`, che è "sensitive" e va scritta a mano), poi `npm install && npm run dev`.

## Cosa è stato verificato e cosa no

- Verificato: `/login` risponde 200 con il modulo; la connessione al database con la nuova password funziona
  da Vercel (pooler `aws-0`, passaggio al ruolo `authenticated`).
- Non verificato: accesso con l'admin (`uniquestudio.web@gmail.com`) e pagine interne.

## Prossimi passi, in ordine

1. Supabase → Authentication → URL Configuration: Site URL = `https://commesse-dashboard.vercel.app`.
2. Primo accesso con l'admin e giro delle pagine.
3. Connessione cifrata al database: oggi la dashboard parla col pooler senza TLS, perché Node non riconosce
   il certificato di Supabase. Va aggiunto il certificato CA di Supabase in `dashboard/src/lib/db.ts`
   prima di usare dati di clienti veri.
4. Verifica in due passaggi sugli account Vercel e Supabase.
5. Dare all'app GitHub di Vercel l'accesso a `lok73/qrcode` e collegare il progetto, per la pubblicazione automatica.
6. `SUPABASE_SERVICE_ROLE_KEY` su Vercel, per gli inviti dalla pagina Utenti.
7. Server per il bot (Railway, Fly.io, Render o VPS) dal `Dockerfile`, con `npm run start:piattaforma`:
   stessa `CREDENTIALS_KEY` (da Vercel), `DATABASE_URL` diretta (utente postgres), `WHATSAPP_*`, `ANTHROPIC_API_KEY`.
8. Pilota: numero WhatsApp verificato da Meta, WordPress di un cliente.
9. Con clienti paganti: piano Pro di Vercel, dominio proprio, copie di sicurezza del database.
