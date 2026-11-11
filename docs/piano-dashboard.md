# Piano: dashboard multi-cliente per il bot WhatsApp → sito web

Obiettivo: trasformare il bot attuale (un cliente, configurato da file `.env`) in un servizio che
l'agenzia di digital marketing usa per **più clienti di settori diversi**, gestito da una
**dashboard web** usata sia dal team dell'agenzia sia dai clienti.

Decisioni già prese:

| Tema | Scelta |
|---|---|
| Utenti | team dell'agenzia (tutti i clienti) + clienti (solo i propri dati) |
| Clienti | più clienti, anche non del settore viaggi |
| Tecnologia | Next.js (dashboard) + Supabase (database, login, permessi, realtime) |
| Prima versione | commesse e approvazioni, configurazione clienti, storico con anteprima modifiche, report e costi |

---

## 1. Architettura

```
                 ┌─────────────────────────── Supabase ───────────────────────────┐
WhatsApp ──▶ Bot worker (Node) ──▶ Postgres: clienti, commesse, messaggi, costi │
  gruppi        │   ▲                Auth: login team e clienti                 │
                │   │                RLS: ogni cliente vede solo i suoi dati    │
                │   └── coda lavori  Realtime: la dashboard si aggiorna da sola  │
                │      (Queues)      Vault: credenziali WordPress cifrate        │
                ▼                 └────────────────────────────────────────────────┘
        WordPress dei clienti                       ▲
                                                    │
                              Dashboard Next.js (team agenzia + portale clienti)
```

Tre componenti, in un unico repository (monorepo con npm workspaces o pnpm + Turborepo):

| Cartella | Cosa contiene | Dove gira |
|---|---|---|
| `packages/core` | logica condivisa: operazioni, client WordPress, interprete Claude, regole delle commesse | libreria |
| `apps/bot` | webhook WhatsApp e worker che elabora messaggi, applica e ripristina le commesse | server Node sempre attivo (Railway, Fly.io, Render o VPS) |
| `apps/dashboard` | interfaccia web per team e clienti | Vercel |

Scelte e motivi:

- **Il worker resta un servizio separato.** Un'analisi di Claude con ricerche sul sito può durare
  decine di secondi o qualche minuto: in un servizio sempre attivo si evitano i limiti di tempo
  delle funzioni serverless e delle Edge Functions.
- **Una sola logica per le commesse.** Approvare da WhatsApp o dalla dashboard passa dallo stesso
  codice (`packages/core`). La dashboard non scrive mai direttamente su WordPress: mette un lavoro
  in coda (`approva commessa 12`) e il worker lo esegue, poi avvisa nel gruppo ("Fatto, è online").
- **Coda su Postgres (Supabase Queues / pgmq).** Niente Redis da gestire. Ogni messaggio e ogni
  approvazione diventa un lavoro, ripetibile in caso di errore.
- **Credenziali WordPress cifrate** in Supabase Vault, lette solo dal worker con la service key.
  Il browser non le vede mai.
- **Il codice esistente si riusa quasi tutto.** `wordpress.ts`, `operations.ts`, `ai.ts`,
  `commands.ts` e la logica di `bot.ts` passano in `packages/core`. Cambia lo strato dati
  (da SQLite a Supabase) e la configurazione (da `.env` alla tabella dei clienti).

### WhatsApp con più clienti

Due strade, non esclusive:

1. **Un numero dell'agenzia per tutti (consigliato per partire).** Un solo numero business,
   verificato come *Official Business Account* (necessario per i gruppi). Per ogni cliente si crea
   un gruppo dedicato; il bot capisce di quale cliente si tratta dal `group_id`.
   Una sola verifica Meta e un solo webhook.
2. **Numero del cliente** (in un secondo momento, per chi lo vuole a suo nome). Richiede che
   l'agenzia diventi *Tech Provider* Meta e usi l'*Embedded Signup*: il cliente collega il suo
   account WhatsApp Business dalla dashboard. Il bot riconosce il cliente dal `phone_number_id`.

Da verificare prima di partire: costi Meta della messaggistica nei gruppi e limiti sul numero di
gruppi per numero (pagina *Groups → Pricing* della documentazione Meta).

---

## 2. Modello dati (Supabase / Postgres)

| Tabella | Contenuto principale |
|---|---|
| `clients` | nome, settore, stato (attivo/sospeso), budget AI mensile |
| `client_sites` | URL WordPress, utente, riferimento al segreto in Vault, tipi di contenuto consentiti, WooCommerce sì/no, mappa dei campi ACF ("prezzo" → `prezzo_base`) |
| `client_channels` | canali WhatsApp: `group_id` o `phone_number_id`, nome del gruppo, attivo |
| `client_settings` | prefisso di attivazione, istruzioni e glossario per l'AI, tono, operazioni consentite, regola di approvazione |
| `profiles` | utenti della dashboard (collegati a Supabase Auth) |
| `memberships` | utente ↔ cliente ↔ ruolo (vedi sezione 3); per il team agenzia `client_id` vuoto = tutti |
| `contacts` | numeri WhatsApp per cliente, con nome e ruolo (richiedente / responsabile) |
| `commesse` | come oggi + `client_id`, canale, origine dell'approvazione (WhatsApp o dashboard) |
| `commessa_operations` | ogni operazione con valori **prima** e **dopo**, URL, esito, dati per il ripristino |
| `messages` | messaggi del gruppo (per contesto AI e per mostrare la conversazione) |
| `ai_usage` | per ogni chiamata a Claude: cliente, commessa, modello, token (input, output, cache), costo calcolato |
| `events` | registro di tutto ciò che succede (creata, approvata da X, applicata, ripristinata, errore) |

Regole di sicurezza (Row Level Security) su ogni tabella:
- il team agenzia vede tutto secondo il ruolo;
- un utente cliente vede solo le righe con il proprio `client_id`;
- i costi (`ai_usage`) sono visibili ai clienti solo se l'agenzia lo abilita.

---

## 3. Ruoli

| Ruolo | Chi | Può |
|---|---|---|
| Admin agenzia | titolari, responsabili tecnici | tutto: clienti, credenziali, utenti, costi |
| Operatore agenzia | account manager | gestire commesse e impostazioni dei clienti assegnati, vedere i report |
| Responsabile cliente | referente del cliente | vedere e approvare / annullare / ripristinare le proprie commesse, vedere lo storico |
| Lettore cliente | altri del cliente | vedere commesse e storico |

Regola di approvazione configurabile per cliente:
- **solo cliente** (come oggi: un responsabile del cliente dà l'ok);
- **doppia**: prima un operatore dell'agenzia controlla, poi il cliente conferma;
- **solo agenzia**: il cliente chiede, l'agenzia approva.

---

## 4. Schermate

### Team agenzia
1. **Panoramica** – commesse in attesa di tutti i clienti, errori da guardare, costo AI del mese,
   tempo medio dalla richiesta alla pubblicazione.
2. **Commesse** – elenco in tempo reale con filtri per cliente, stato, periodo. Azioni rapide:
   approva, annulla.
3. **Dettaglio commessa**
   - conversazione WhatsApp da cui è nata;
   - operazioni proposte con **anteprima prima/dopo** (differenze evidenziate nel testo, tabella
     per prezzi e campi);
   - link alla pagina, cronologia (chi ha chiesto, chi ha approvato, quando);
   - azioni: approva, annulla, ripristina, "rifai l'analisi".
4. **Clienti** – elenco e procedura guidata per un nuovo cliente:
   1. dati del cliente e settore;
   2. sito WordPress → pulsante **"Prova connessione"** (verifica credenziali, tipi di contenuto, ACF, WooCommerce);
   3. WhatsApp → crea il gruppo dal numero dell'agenzia e mostra il link d'invito (o collega un gruppo esistente);
   4. responsabili e numeri autorizzati;
   5. regole: operazioni consentite, approvazione, glossario e istruzioni per l'AI.
5. **Impostazioni cliente** – le stesse voci, modificabili.
6. **Report** – per cliente e per mese: commesse per stato, tempi, errori, costo AI;
   esportazione CSV per la fatturazione.
7. **Utenti** – inviti, ruoli, clienti assegnati.

### Portale cliente
1. **Le mie commesse** – in attesa (con approva/annulla) e storico.
2. **Dettaglio** – come per l'agenzia, senza costi e impostazioni tecniche.
3. Notifiche email facoltative ("hai una modifica da approvare").

---

## 5. Cosa cambia nel bot

- **Configurazione per cliente**: a ogni messaggio il worker trova il cliente dal `group_id`
  (o dal `phone_number_id`) e carica sito, regole e responsabili dal database.
- **Prompt generico + profilo del cliente**: il prompt di sistema non parla più solo di viaggi;
  settore, glossario, campi ACF e istruzioni del cliente vengono aggiunti in coda
  (la parte fissa resta uguale per tutti, così la cache dei prompt di Claude funziona).
- **Anteprima salvata**: prima di proporre una commessa il worker calcola il contenuto "dopo"
  e lo salva, così la dashboard mostra le differenze senza chiamare WordPress.
- **Costi tracciati**: per ogni chiamata a Claude si salvano i token letti da `usage`
  e il costo calcolato da una tabella prezzi per modello tenuta in configurazione.
- **Budget**: se un cliente supera il budget AI mensile il bot smette di analizzare i messaggi
  e avvisa l'agenzia (non il gruppo).
- **Connettori per altri siti** (fase successiva): `WordPressClient` diventa una delle
  implementazioni di un'interfaccia `SiteConnector`, così si potranno aggiungere Shopify, Webflow, ecc.

---

## 6. Fasi e tempi indicativi

Stima per **una persona a tempo pieno**; con due sviluppatori le fasi 2–4 si accorciano.

| Fase | Contenuto | Durata |
|---|---|---|
| 0. Preparazione | verifica OBA del numero dell'agenzia su Meta, progetto Supabase (ambiente di prova + produzione), monorepo, spostamento del codice in `packages/core` | 1 settimana |
| 1. Backend multi-cliente | schema, RLS, Vault, coda lavori, worker su Supabase, instradamento per gruppo, tracciamento costi; migrazione dell'agenzia di viaggi come primo cliente | 2–3 settimane |
| 2. Dashboard agenzia | login, panoramica, commesse in tempo reale, dettaglio con anteprima prima/dopo, azioni, procedura nuovo cliente con prova connessione | 2–3 settimane |
| 3. Portale cliente | inviti, ruoli, vista ridotta, approvazioni dalla dashboard, notifiche email | 1–2 settimane |
| 4. Report e costi | indicatori, report mensile per cliente, esportazione CSV, avvisi di budget | 1–2 settimane |
| 5. Messa in produzione | monitoraggio errori (Sentry), backup, documentazione, checklist di attivazione nuovo cliente, prova con 2–3 clienti pilota | 1 settimana |

Totale: **8–12 settimane**. Una prima versione utile per il team (fasi 0–2) è pronta in circa
5–7 settimane, anche senza portale cliente.

---

## 7. Sicurezza, privacy e conformità

- **Credenziali**: Application Password di WordPress con un utente dedicato per ogni cliente
  (ruolo Editor), cifrate in Vault, revocabili dal cliente in qualsiasi momento.
- **Dati personali**: i messaggi WhatsApp contengono nomi e numeri. Servono un accordo sul
  trattamento dei dati (DPA) con ogni cliente, l'elenco dei fornitori coinvolti (Meta, Supabase,
  Anthropic, hosting) e un periodo di conservazione (es. messaggi cancellati dopo 90 giorni,
  commesse tenute per lo storico).
- **Trasparenza AI**: come nel bot attuale, il bot non si spaccia per una persona e lo dice se
  glielo chiedono (AI Act, art. 50). Da indicare anche nelle condizioni del servizio ai clienti.
- **Registro**: ogni approvazione e ogni modifica al sito resta nella tabella `events`
  (chi, quando, da dove).
- **Sicurezza del webhook**: verifica della firma Meta, come oggi.

---

## 8. Decisioni ancora aperte

1. **Numero WhatsApp**: si parte con un solo numero dell'agenzia? Il numero è già verificato come OBA?
2. **Approvazione predefinita**: solo cliente, doppia o solo agenzia?
3. **Costi ai clienti**: l'uso dell'AI si rifattura a consumo o è compreso in un canone?
   (cambia se i clienti devono vedere i costi).
4. **Hosting del worker**: Railway / Fly.io / Render oppure un VPS vostro?
5. **Altri CMS**: ci sono già clienti non WordPress da coprire presto (Shopify, Webflow…)?
6. **Marchio**: la dashboard deve avere il marchio dell'agenzia o un nome di prodotto proprio?

---

## 9. Primi passi concreti

1. Chiudere le decisioni 1–3 della sezione 8.
2. Creare il progetto Supabase di prova e scrivere la prima migrazione (tabelle + RLS).
3. Ristrutturare il repository in monorepo e spostare la logica attuale in `packages/core`,
   con i test esistenti che continuano a passare.
4. Collegare il worker a Supabase e migrare l'agenzia di viaggi come cliente n. 1.
5. Avviare la dashboard partendo da elenco commesse e dettaglio con anteprima.
