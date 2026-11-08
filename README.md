# Bot WhatsApp per gli aggiornamenti del sito dell'agenzia

Lo staff scrive in un gruppo WhatsApp cosa va cambiato sul sito ("Parigi di maggio ora costa 590€").
Il bot capisce la richiesta, trova la pagina giusta su WordPress, propone una **commessa** con il
riepilogo delle modifiche e la applica al sito **solo dopo l'OK di un responsabile**.

```
Marco:  Il tour di Parigi di maggio ora costa 590€ invece di 650
Bot:    📋 Commessa #12
        Aggiornare il prezzo del "Tour di Parigi – Maggio" a 590€
        • Prezzo: 650€ → 590€
        Per applicarla: ok 12
        Per scartarla: annulla 12
Giulia: ok 12
Bot:    ⏳ Commessa #12 approvata, aggiorno il sito…
Bot:    ✅ Commessa #12 completata
        • Aggiornato "Tour di Parigi – Maggio" (content)
          https://www.tua-agenzia.it/tour-parigi-maggio
        Per tornare indietro: ripristina 12
```

## Come funziona

```
WhatsApp (gruppo) ──webhook──▶ server.ts ──▶ bot.ts ──▶ ai.ts (Claude + strumenti di sola lettura)
                                                │                     │
                                                │◀── commessa ────────┘
                                                ▼
                                   store.ts (SQLite: commesse, cronologia)
                                                │  "ok 12" da un responsabile
                                                ▼
                                   wordpress.ts (REST API) ──▶ sito
```

- **Comprensione delle richieste**: Claude legge il messaggio (con gli ultimi messaggi della chat
  come contesto), cerca e legge i contenuti del sito e propone operazioni precise. Se manca
  un'informazione fa una domanda nel gruppo; se il messaggio è solo conversazione resta in silenzio.
- **Sicurezza**: l'AI non può modificare nulla da sola. Le operazioni sono limitate a: modificare
  titolo / testo / riassunto / stato / campi ACF di pagine e articoli, creare bozze, cambiare
  prezzi WooCommerce. Niente cancellazioni definitive. Ogni operazione viene verificata sul sito
  prima di essere proposta e ogni modifica salva i valori precedenti per il **ripristino**.
- **Modifiche puntuali**: per cambiare un prezzo o una frase il bot sostituisce solo quel testo
  (che deve comparire una sola volta nella pagina), senza riscrivere il resto.

## Comandi nel gruppo

| Comando | Cosa fa | Chi |
|---|---|---|
| `ok 12` (o `approva 12`, `conferma 12`, `sì 12`) | applica la commessa 12 | responsabili |
| `ok` | approva l'unica commessa in attesa | responsabili |
| `annulla 12` (o `no 12`) | scarta la commessa | chi l'ha chiesta o un responsabile |
| `ripristina 12` | riporta il sito com'era prima della 12 | responsabili |
| `stato 12` | dettagli della commessa | tutti |
| `commesse` | commesse aperte e ultime chiuse | tutti |
| `aiuto` | istruzioni | tutti |

## Requisiti

1. **Node.js 22.13+** (oppure Docker).
2. **WhatsApp Business Platform (Cloud API)** con un numero dedicato al bot.
   - Per usare i **gruppi** Meta richiede che il numero sia un
     **Official Business Account** (spunta di verifica) e che il gruppo sia creato dal numero
     business tramite API (vedi sotto). Finché non avete l'OBA, il bot funziona già nelle
     **chat private**: ogni membro dello staff in `ALLOWED_SENDERS` può scrivere al numero.
3. **WordPress** con REST API attiva (default) e un utente dedicato con
   [Application Password](https://wordpress.org/documentation/article/application-passwords/).
   - Prezzi e date in campi personalizzati? Con **ACF** attivate "Show in REST API" sul gruppo di campi.
   - Pagine costruite con Elementor/Divi salvano il layout altrove: per quelle il bot può
     modificare titolo, stato e campi ACF, ma non il testo impaginato.
4. **Chiave API Anthropic** per Claude.

## Installazione

```bash
npm install
cp .env.example .env     # e compila i valori
npm run build
npm start
```

Il server deve essere raggiungibile in HTTPS da Meta (es. un VPS con Caddy/Nginx, Render,
Railway, Fly.io…). Per provare in locale si può usare `cloudflared tunnel` o `ngrok`.

### Configurare il webhook su Meta

1. Su [developers.facebook.com](https://developers.facebook.com/) → la tua app → WhatsApp → Configurazione.
2. URL di callback: `https://il-tuo-server/webhook` — Token di verifica: il valore di `WHATSAPP_VERIFY_TOKEN`.
3. Sottoscrivi i campi `messages`, `group_lifecycle_update`, `group_participants_update`.

### Creare il gruppo

I gruppi gestiti via API vanno creati dal numero business:

```bash
npm run crea-gruppo -- "Aggiornamenti sito" "Scrivete qui le modifiche al sito"
```

Il `group_id` e il link d'invito arrivano al webhook e compaiono nel log del bot
(`[webhook] evento group_lifecycle_update`). Mandate il link allo staff, poi mettete il
`group_id` in `ALLOWED_GROUPS` e i numeri dei responsabili in `APPROVERS` e riavviate.
Il link si può rileggere con `npm run crea-gruppo -- --link <GROUP_ID>`.

Se il bot riceve messaggi da un gruppo non autorizzato, lo scrive nel log con il relativo `group_id`.

## Variabili d'ambiente

Vedi [.env.example](.env.example). Le principali:

| Variabile | Descrizione |
|---|---|
| `ALLOWED_GROUPS` | group_id dei gruppi da cui accettare richieste |
| `ALLOWED_SENDERS` | numeri che possono scrivere al bot in privato |
| `APPROVERS` | numeri che possono approvare/ripristinare (se vuoto: tutti) |
| `TRIGGER_PREFIX` | es. `#sito`: il bot legge solo i messaggi che iniziano così (utile in gruppi molto chiacchierati, riduce anche i costi) |
| `WP_POST_TYPES` | tipi di contenuto modificabili, es. `post,page,viaggio` |
| `WP_WOOCOMMERCE` | `true` per gestire i prezzi dei prodotti WooCommerce |
| `ANTHROPIC_EFFORT` | `low`…`max`: precisione/costo dell'analisi (default `medium`) |

## Sviluppo

```bash
npm run dev        # avvio con ricarica automatica (legge .env)
npm test           # test automatici (nessuna chiamata esterna)
npm run typecheck
```

Struttura:

| File | Ruolo |
|---|---|
| `src/server.ts` | webhook HTTP, verifica firma `X-Hub-Signature-256` |
| `src/whatsapp.ts` | lettura dei messaggi in arrivo, invio nel gruppo/chat |
| `src/bot.ts` | logica: comandi, commesse, approvazioni, ripristino |
| `src/ai.ts` | interpretazione delle richieste con Claude |
| `src/operations.ts` | le operazioni consentite sul sito |
| `src/wordpress.ts` | REST API WordPress/WooCommerce, ripristino |
| `src/store.ts` | database SQLite delle commesse |

## Note

- Ogni messaggio interpretato è una chiamata a Claude: con `TRIGGER_PREFIX` si limita alle sole richieste.
- Il database (`data/commesse.db`) contiene lo storico delle commesse: includetelo nei backup.
- I modelli di Claude possono rifiutare richieste per motivi di sicurezza: il bot attiva il
  fallback automatico lato server (`fallbacks: "default"`) e, se anche quello rifiuta, lo segnala nel gruppo.
