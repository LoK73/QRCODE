# Bot WhatsApp per gli aggiornamenti del sito dell'agenzia

Lo staff scrive in un gruppo WhatsApp cosa va cambiato sul sito ("Parigi di maggio ora costa 590€").
Il bot capisce la richiesta, trova la pagina giusta su WordPress, propone una **commessa** con il
riepilogo delle modifiche e la applica al sito **solo dopo l'OK di un responsabile**.

```
Marco:  Il tour di Parigi di maggio ora costa 590 invece di 650
Bot:    Cambio il prezzo del tour di Parigi di maggio:
        - prezzo 650€ → 590€
        Mi date l'ok e procedo? (rif. 12)
Giulia: sì vai
Bot:    Fatto, è online (rif. 12):
        https://www.tua-agenzia.it/tour-parigi-maggio
```

## Tono e trasparenza

Il bot scrive come un collega: italiano colloquiale, frasi brevi, niente emoji o formattazioni
da "robot", e capisce conferme naturali come "sì vai", "procedi", "lascia perdere".
Non si spaccia però per una persona: non inventa dettagli personali e, se qualcuno gli chiede
sul serio se è un bot, risponde di sì. Anche il messaggio di `aiuto` lo dice.

È una scelta voluta: chi scrive nel gruppo ha diritto di sapere con chi parla, e l'AI Act
europeo (art. 50, obblighi di trasparenza applicabili da agosto 2026) chiede che le persone
siano informate quando interagiscono con un sistema di intelligenza artificiale. Il modo più
semplice è dirlo una volta allo staff ("le modifiche al sito le gestisce un assistente
automatico, passano sempre dall'ok di un responsabile") e dare al numero del bot un nome chiaro,
es. "Assistente sito".

## Come funziona

```
WhatsApp (gruppo) ──webhook──▶ server.ts ──▶ queue.ts ──▶ bot.ts ──▶ ai.ts (Claude, sola lettura)
                                                │                     │
                                                │◀── commessa ────────┘
                                                ▼
                         store.ts (SQLite: coda dei messaggi, commesse, cronologia)
                                                │  "ok 12" da un responsabile
                                                ▼
                                   wordpress.ts (REST API) ──▶ sito
```

- **Comprensione delle richieste**: Claude legge il messaggio (con gli ultimi messaggi della chat
  come contesto), cerca e legge i contenuti del sito e propone operazioni precise. Se manca
  un'informazione fa una domanda nel gruppo, se gli scrivono direttamente risponde in breve,
  se il messaggio è conversazione tra colleghi resta in silenzio.
- **Sicurezza**: l'AI non può modificare nulla da sola. Le operazioni sono limitate a: modificare
  titolo / testo / riassunto / stato / campi ACF di pagine e articoli, creare bozze, cambiare
  prezzi WooCommerce. Niente cancellazioni definitive. Ogni operazione viene verificata sul sito
  prima di essere proposta e ogni modifica salva i valori precedenti per il **ripristino**.
- **Modifiche puntuali**: per cambiare un prezzo o una frase il bot sostituisce solo quel testo
  (che deve comparire una sola volta nella pagina), senza riscrivere il resto.
- **Stesso dato in più punti**: prima di proporre, il bot cerca dove altro compare il valore
  vecchio (home, elenchi, altre lingue) e include quei punti nella proposta; quelli dubbi li
  segnala come "da controllare" senza toccarli.

## Cosa sa fare in più

| Funzione | Come si usa | Note |
|---|---|---|
| **Foto e PDF** | Si manda la locandina o il listino, con la richiesta nella didascalia o nel messaggio subito dopo | Vale per gli allegati mandati dalla stessa persona negli ultimi 10 minuti. Il bot li legge per ricavare i dati; non carica ancora le immagini sul sito |
| **Vocali** | Si manda il vocale come un normale messaggio | Serve la chiave Groq (vedi sotto). Senza, il bot chiede di scrivere |
| **Modifiche programmate** | "Dal 1° dicembre Parigi costa 590" | Dopo l'ok resta "in programma" e parte alla data indicata |
| **Offerte a tempo** | "Fino a domenica Parigi a 590" | Alla scadenza il bot rimette il sito com'era e avvisa |
| **Correzioni** | "No scusate, 580 non 590" | La nuova proposta sostituisce quella sbagliata |
| **Ok in risposta** | Si usa "Rispondi" sul messaggio della proposta e si scrive "ok" | Funziona anche con più proposte aperte |

## Affidabilità

- **Nessun messaggio perso**: ogni messaggio viene salvato su disco prima di essere elaborato.
  Se il server si riavvia, alla ripartenza riprende da dove era; se l'elaborazione fallisce
  riprova fino a 3 volte. I messaggi dello stesso gruppo vengono elaborati uno alla volta.
- **Niente pubblicazioni a metà**: il modo di annullare ogni modifica viene salvato prima di
  toccare il sito. Dopo un riavvio le modifiche parziali vengono annullate e la commessa
  riparte da capo.
- **"È online" solo se si vede**: dopo ogni modifica il bot apre la pagina pubblica come un
  visitatore. Se compare ancora la versione vecchia (di solito per la cache) lo dice, invece
  di confermare. Si disattiva con `VERIFY_PUBLIC=false`.
- **Ripristino prudente**: `ripristina 12` annulla solo ciò che il bot aveva cambiato. Se nel
  frattempo qualcuno ha modificato a mano proprio quel punto, il bot si ferma e lo segnala;
  `ripristina 12 forza` rimette comunque tutto com'era.
- **Proposte con scadenza**: una proposta senza ok dopo 24 ore (`PROPOSAL_TTL_HOURS`) scade,
  perché nel frattempo il sito può essere cambiato.

## Comandi nel gruppo

| Comando | Cosa fa | Chi |
|---|---|---|
| `ok 12` (o `vai 12`, `procedi 12`, `sì 12`) | applica la commessa 12 | responsabili |
| `sì vai`, `procedi`, `ok`, `va bene`… | approva la proposta appena fatta dal bot | responsabili |
| `annulla 12` (o `no 12`), `lascia perdere` | scarta la commessa, anche se già in programma | chi l'ha chiesta o un responsabile |
| "ok" in risposta al messaggio della proposta | approva proprio quella proposta | responsabili |
| `ripristina 12` | riporta il sito com'era prima della 12 | responsabili |
| `ripristina 12 forza` | come sopra, anche se la pagina è stata modificata dopo | responsabili |
| `stato 12` | a che punto è | tutti |
| `commesse` | cosa c'è in sospeso e le ultime fatte | tutti |
| `aiuto` | istruzioni | tutti |

Le conferme senza numero valgono solo se l'ultimo messaggio del bot è la proposta di una
commessa ancora in attesa: un "sì" detto in un altro contesto resta normale conversazione.

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
5. *(Facoltativo)* **Chiave Groq** per i vocali: Claude non riceve audio, quindi i vocali vengono
   trascritti da Groq (modello `whisper-large-v3-turbo`, il più economico tra quelli confrontati).
   Basta impostare `TRANSCRIPTION_API_KEY` con una chiave creata su
   [console.groq.com](https://console.groq.com/). Attenzione: i vocali dello staff vengono
   inviati a quel fornitore. Per usare un altro servizio con lo stesso formato si cambiano
   `TRANSCRIPTION_URL` e `TRANSCRIPTION_MODEL`.

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
| `PROPOSAL_TTL_HOURS` | dopo quante ore una proposta senza ok scade (default 24) |
| `TIMEZONE` | fuso per le date nei messaggi e per le modifiche programmate (default `Europe/Rome`) |
| `VERIFY_PUBLIC` | `false` per non controllare la pagina pubblica dopo ogni modifica |
| `TRANSCRIPTION_API_KEY` | chiave Groq: attiva la trascrizione dei vocali (facoltativo) |
| `TRANSCRIPTION_URL`, `TRANSCRIPTION_MODEL` | solo per usare un servizio diverso da Groq |

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
| `src/queue.ts` | coda durevole dei messaggi: una chat alla volta, nuovi tentativi, ripresa dopo riavvio |
| `src/whatsapp.ts` | lettura dei messaggi in arrivo (testo, foto, PDF, vocali), invio, download allegati |
| `src/bot.ts` | logica: comandi, commesse, approvazioni, programmazione, ripristino, ripresa |
| `src/transcribe.ts` | trascrizione dei vocali tramite servizio esterno |
| `src/ai.ts` | interpretazione delle richieste con Claude |
| `src/operations.ts` | le operazioni consentite sul sito |
| `src/wordpress.ts` | REST API WordPress/WooCommerce, ripristino sicuro, verifica della pagina pubblica |
| `src/store.ts` | database SQLite: coda, commesse, cronologia |

## Note

- **Costi WhatsApp nei gruppi**: Meta fa pagare ogni messaggio del bot per ogni destinatario che
  lo riceve; i messaggi liberi sono gratuiti solo entro la quota mensile del numero. Per questo
  il bot scrive il meno possibile. Vedi la pagina
  [Groups → Pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/pricing.md).
- **Avvisi fuori orario**: le modifiche programmate e le scadenze delle offerte generano un
  messaggio quando nel gruppo magari non scrive nessuno da ore. Se Meta lo rifiuta perché la
  finestra di conversazione è chiusa, la modifica sul sito viene fatta comunque e l'esito resta
  nel log e in `stato 12`; per garantire l'avviso servirà un messaggio modello approvato da Meta.
- **Da verificare sul campo**: la risposta diretta a un messaggio (`context`) e gli allegati nei
  gruppi seguono il formato dei messaggi 1:1 della Cloud API; vanno provati con un gruppo reale.
- Ogni messaggio interpretato è una chiamata a Claude: con `TRIGGER_PREFIX` si limita alle sole richieste.
- Il database (`data/commesse.db`) contiene lo storico delle commesse: includetelo nei backup.
- I modelli di Claude possono rifiutare richieste per motivi di sicurezza: il bot attiva il
  fallback automatico lato server (`fallbacks: "default"`) e, se anche quello rifiuta, lo segnala nel gruppo.
