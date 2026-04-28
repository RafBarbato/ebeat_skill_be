# TODO — Passaggio in produzione

Checklist di tutto ciò che va fatto prima di pubblicare la skill ebeat su Alexa.
Aggiornare man mano che si completano i punti.

---

## Fase 1 — Autenticazione (prerequisito per tutto il resto)

### Backend OAuth2

- [ ] **Variabili d'ambiente** — spostare da hardcoded a `.env`:
  - `SUPABASE_URL`
  - `SUPABASE_ANON_KEY`
  - `CLIENT_ID`
  - `CLIENT_SECRET`
  - `BACKEND_URL`
  - `PORT`

- [ ] **Persistenza authorization codes** — sostituire la `Map` in-memory con una tabella Supabase (es. `alexa_auth_codes` con colonne `code`, `user_id`, `created_at`, `expires_at`). La Map va persa ad ogni riavvio del server.

- [ ] **Deploy su server stabile** — ngrok è solo per sviluppo locale. In produzione servono URL HTTPS fissi. Opzioni:
  - AWS Lambda + API Gateway (già configurato, vedere link in DOCS.md)
  - EC2 / VPS con dominio e certificato SSL

- [ ] **Aggiornare Alexa Developer Console** con gli URL di produzione:
  - Web Authorization URI
  - Access Token URI

- [ ] **Aggiornare Supabase** → Auth → URL Configuration con gli URL di produzione (rimuovere ngrok)

- [ ] **Sicurezza `/token`** — valutare rate limiting per prevenire brute force sui codici

### Supabase

- [ ] **Email OTP** — verificare che il template "Magic Link" mostri chiaramente il codice `{{ .Token }}` e non solo un link (già fatto in sviluppo, verificare in prod)

- [ ] **shouldCreateUser: false** — attualmente `/send-otp` non crea nuovi utenti se non esistono. Decidere se permettere la registrazione dalla skill o solo il collegamento di account già esistenti nell'app ebeat.

- [ ] **Scadenza OTP** — verificare la durata del codice OTP in Supabase (default 1 ora). Valutare se ridurla per sicurezza (es. 10 minuti) in Authentication → Settings.

### Alexa Developer Console

- [ ] **Testare Account Linking** con un utente diverso dallo sviluppatore
- [ ] **Verificare i 3 redirect URL** (pitangui, layla, alexa.amazon.co.jp) siano tutti funzionanti

---

## Fase 2 — Riproduzione musicale

### Skill Alexa (AWS Lambda)

- [ ] **Popolare il repository** `RafBarbato/ebeat_skill` con il codice della skill
- [ ] **Implementare LaunchRequest** — risposta di benvenuto, verifica account linking
- [ ] **Implementare PlayIntent** — riceve il nome del brano/artista, recupera stream
- [ ] **Implementare AudioPlayer Interface**:
  - `AudioPlayer.Play`
  - `PlaybackStarted`, `PlaybackFinished`, `PlaybackFailed` (handler eventi)
- [ ] **Intent built-in**:
  - `AMAZON.PauseIntent`
  - `AMAZON.ResumeIntent`
  - `AMAZON.StopIntent`
  - `AMAZON.NextIntent`
- [ ] **Gestione utente non autenticato** — risposta vocale che invita al collegamento account

### Backend — endpoint stream

- [ ] **Endpoint `/stream`** — riceve nome brano + access token, risponde con URL audio diretto
  - Recupera dati brano da Supabase usando `userId` (dall'access token)
  - Risolve URL stream da YouTube (valutare `yt-dlp` via subprocess o API YouTube)
  - Attenzione: gli URL YouTube scadono, vanno risolti a runtime

- [ ] **Valutare termini di servizio YouTube** — l'uso di stream diretti da YouTube potrebbe violare i ToS. Verificare alternative (YouTube Music API, licensing, ecc.)

### Supabase

- [ ] **Definire schema tabelle** per i dati musicali (brani, playlist, preferenze utente)
- [ ] **Verificare che `userId` Supabase** (usato come access_token da Alexa) sia sufficiente per recuperare i dati dell'utente, oppure generare un token separato con più info

---

## Pubblicazione skill

- [ ] **Compilare metadati skill** in Alexa Developer Console:
  - Nome, descrizione, icona (108x108 e 512x512)
  - Esempi di frasi di attivazione
  - Categoria, parole chiave
  - Privacy policy URL (obbligatoria)
  - Termini di servizio URL

- [ ] **Privacy Policy** — creare pagina pubblica (obbligatoria per la certificazione Alexa)

- [ ] **Testing** — testare la skill su almeno un dispositivo Alexa fisico o tramite simulatore

- [ ] **Submission per certificazione** — Alexa richiede una revisione prima della pubblicazione. Tempi: solitamente 3-5 giorni lavorativi.

- [ ] **Skill in italiano** — verificare che tutti i testi vocali, le utterances e le risposte siano in italiano corretto

---

## Infrastruttura

- [ ] **Monitoring** — aggiungere logging strutturato su AWS CloudWatch (già disponibile con Lambda)
- [ ] **Gestione errori** — risposta vocale friendly per ogni errore (stream non disponibile, account non collegato, ecc.)
- [ ] **Rate limiting** — proteggere gli endpoint pubblici (`/authorize`, `/send-otp`, `/token`)
- [ ] **Backup** — assicurarsi che i dati Supabase abbiano backup abilitati
