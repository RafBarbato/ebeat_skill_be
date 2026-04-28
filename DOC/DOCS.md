# ebeat Alexa Skill — Documentazione

> Ultimo aggiornamento: 2026-04-28 — flusso OTP

---

## Indice

1. [Cos'è questo progetto](#1-cosè-questo-progetto)
2. [Link importanti](#2-link-importanti)
3. [Architettura](#3-architettura)
4. [Struttura del repository](#4-struttura-del-repository)
5. [Fase 1 — Autenticazione (Account Linking)](#5-fase-1--autenticazione-account-linking)
   - [Come funziona OAuth2 con Alexa](#come-funziona-oauth2-con-alexa)
   - [Flusso completo step-by-step](#flusso-completo-step-by-step)
   - [Endpoint backend](#endpoint-backend)
   - [Stato implementazione](#stato-implementazione-fase-1)
6. [Fase 2 — Riproduzione musicale](#6-fase-2--riproduzione-musicale)
   - [Come funziona AudioPlayer Alexa](#come-funziona-audioplayer-alexa)
   - [Flusso riproduzione](#flusso-riproduzione)
   - [Stato implementazione](#stato-implementazione-fase-2)
7. [Backend OAuth2](#7-backend-oauth2)
   - [Avvio e dipendenze](#avvio-e-dipendenze)
   - [Variabili d'ambiente](#variabili-dambiente)
8. [Supabase](#8-supabase)
9. [Configurazione Alexa Developer Console](#9-configurazione-alexa-developer-console)
10. [Changelog](#10-changelog)

---

## 1. Cos'è questo progetto

Skill Alexa che permette agli utenti di **ebeat** (app musicale React Native) di ascoltare musica tramite Alexa. La musica proviene da YouTube API. Il collegamento tra l'identità Alexa e l'account utente avviene tramite **Alexa Account Linking** (OAuth2) con Supabase come sistema di autenticazione.

**Due obiettivi principali:**

| Fase | Obiettivo | Stato |
|------|-----------|-------|
| 1 | Autenticazione — collegare account Supabase alla skill Alexa | In sviluppo |
| 2 | Riproduzione — riprodurre brani via Alexa AudioPlayer | Da iniziare |

---

## 2. Link importanti

| Risorsa | Link |
|---------|------|
| Alexa Developer Console — ebeat skill | [Apri](https://developer.amazon.com/alexa/console/ask/build/custom/amzn1.ask.skill.714d9097-3d5d-4d43-8e52-21fece536384/development/it_IT/interfaces) |
| Supabase — configurazione URL auth (ebeat) | [Apri](https://supabase.com/dashboard/project/xzcdfhaylwoqbfucgcau/auth/url-configuration) |
| AWS Lambda — funzione `ebeat` (eu-west-3) | [Apri](https://eu-west-3.console.aws.amazon.com/lambda/home?region=eu-west-3#/functions/ebeat?tab=code) |
| GitHub — repository ebeat_skill | [RafBarbato/ebeat_skill](https://github.com/RafBarbato/ebeat_skill) |

---

## 3. Architettura

```
┌─────────────────────┐
│   App ebeat         │
│   (React Native)    │
│                     │
│  YouTube API        │
│  Supabase (auth/DB) │
└─────────────────────┘

┌─────────────────────┐       OAuth2 Account Linking
│   Alexa Skill       │ ◄────────────────────────────┐
│   ID: MFP4HI9LYTIIU │                              │
│                     │       AudioPlayer stream URL  │
│   AudioPlayer ──────┼──────────────────────────────┤
└─────────────────────┘                              │
                                                     │
                                         ┌───────────┴──────────┐
                                         │  Backend OAuth2       │
                                         │  (Express, porta 3000)│
                                         │                       │
                                         │  /send-magic-link     │
                                         │  /magic-callback      │
                                         │  /token               │
                                         └───────────┬──────────┘
                                                     │
                                         ┌───────────┴──────────┐
                                         │  Supabase             │
                                         │  (auth magic link)    │
                                         │  (DB brani/playlist)  │
                                         └──────────────────────┘
```

---

## 4. Struttura del repository

```
Alexa/
├── CLAUDE.md                        # Istruzioni di contesto per Claude AI
├── DOCS.md                          # Questo file — documentazione progetto
├── be.js                            # Prototipo iniziale (non usare)
└── alexa-supabase-backend/          # Backend OAuth2 principale
    ├── be.js                        # Server Express con i 3 endpoint
    ├── package.json                 # Node.js ES Modules
    └── node_modules/
```

---

## 5. Fase 1 — Autenticazione (Account Linking)

### Come funziona OAuth2 con Alexa

Alexa richiede un server OAuth2 custom per collegare l'identità dell'utente Alexa al proprio account sull'app. Il flusso usato è **Authorization Code**, dove:

- Alexa fa da **client OAuth2**
- Il nostro backend fa da **authorization server**
- Supabase gestisce l'autenticazione reale tramite **OTP a 6 cifre** via email

L'autenticazione avviene interamente nella **WebView di Alexa** — l'utente non esce mai dall'app. Il magic link è stato scartato perché il click nell'email apre il browser esterno, fuori dalla WebView, impedendo ad Alexa di intercettare il redirect finale.

Quando il collegamento è completato, Alexa conserva un `access_token` (= `userId` Supabase) che la skill usa per identificare l'utente.

### Flusso completo step-by-step

```
Utente (WebView)   Backend (porta 3000)        Supabase
  │                       │                      │
  │  "Collega account"    │                      │
  │  Alexa apre /authorize│                      │
  │──────────────────────►│                      │
  │  [form email]         │                      │
  │                       │                      │
  │  Inserisce email      │                      │
  │──────────────────────►│ POST /send-otp       │
  │                       │─────────────────────►│
  │                       │                      │ Invia email
  │  [form codice OTP]    │                      │ con codice
  │◄──────────────────────│                      │ 6 cifre
  │                       │                      │
  │  Legge codice email   │                      │
  │  e lo digita          │                      │
  │──────────────────────►│ POST /verify-otp     │
  │                       │─────────────────────►│
  │                       │◄─────────────────────│
  │                       │  utente verificato   │
  │                       │  genera alexaCode    │
  │◄──────────────────────│  302 → layla.amazon  │
  │  (WebView intercetta) │                      │
  │                       │                      │
  Alexa (server-to-server)│                      │
  ───────────────────────►│ POST /token          │
  ◄───────────────────────│ { access_token }     │
  Account collegato! ✓    │                      │
```

### Endpoint backend

#### `GET /authorize`

Punto di ingresso del flusso OAuth2. Alexa reindirizza l'utente qui con la WebView.

**Query params:** `state`, `redirect_uri`, `client_id`, `response_type`

**Comportamento:** valida `redirect_uri` contro la whitelist delle 3 URL Alexa, serve la pagina HTML con form email e campi nascosti per `state` e `redirect_uri`.

---

#### `POST /send-otp`

Invocato dal submit del form email. Invia OTP a 6 cifre tramite Supabase.

**Request body (form-urlencoded):**
```
email=utente@esempio.com
state=<state_da_alexa>
redirect_uri=<alexa_redirect_url>
```

**Comportamento:** chiama `supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: false } })` senza `emailRedirectTo`. Supabase invia il codice OTP via email. Risponde con la pagina HTML del form codice.

> Nessun link cliccabile nell'email — solo il codice numerico. Il template "Magic Link" di Supabase va modificato per mostrare `{{ .Token }}`.

---

#### `POST /verify-otp`

Verifica il codice OTP inserito dall'utente nella WebView.

**Request body (form-urlencoded):**
```
email=utente@esempio.com
otp=123456
state=<state_da_alexa>
redirect_uri=<alexa_redirect_url>
```

**Comportamento:**
1. Chiama `supabase.auth.verifyOtp({ email, token: otp, type: 'email' })`
2. Se errore: rimanda la pagina del form con messaggio di errore
3. Se OK: genera `alexaCode` (32 byte hex), salva in Map con `userId` e timestamp
4. Redirect 302: `<redirect_uri>?code=<alexaCode>&state=<state>` — dentro la WebView, Alexa lo intercetta

> **Limitazione nota:** i codici sono in-memory (`Map`) — vanno persi al riavvio. Da persistere su Supabase in produzione.

---

#### `POST /token`

Token exchange server-to-server. Alexa chiama questo endpoint dopo aver intercettato il redirect.

**Headers:** `Authorization: Basic base64(clientId:clientSecret)`

**Request body (form-urlencoded):**
```
grant_type=authorization_code
code=<alexaCode>
```

**Comportamento:**
1. Valida credenziali dall'header `Authorization: Basic`
2. Verifica che il `code` esista nella Map
3. Controlla scadenza (10 minuti)
4. Elimina il codice (one-time use)
5. Risponde con `access_token = userId Supabase`

**Response:**
```json
{
  "access_token": "<userId_supabase>",
  "token_type": "Bearer",
  "expires_in": 3600
}
```

> L'`access_token` restituito ad Alexa è lo `userId` Supabase — la skill lo usa per identificare l'utente.

### Stato implementazione Fase 1

- [x] Endpoint `GET /authorize` — pagina HTML con form email
- [x] Endpoint `POST /send-otp` — invia OTP 6 cifre, mostra form codice
- [x] Endpoint `POST /verify-otp` — verifica OTP, redirect verso Alexa nella WebView
- [x] Endpoint `POST /token` — valida credenziali + codice, scadenza 10 min, risponde con userId
- [x] Whitelist `redirect_uri` (le 3 URL Alexa)
- [x] **[MANUALE]** Web Authorization URI → `https://bibliopolar-cadence-unenrolled.ngrok-free.dev/authorize`
- [x] **[MANUALE]** Alexa Redirect URL aggiunte in Supabase → Auth → URL Configuration
- [x] **[MANUALE]** Template email Supabase ("Magic Link") aggiornato per mostrare `{{ .Token }}`
- [ ] Credenziali Supabase e client secret spostate in `.env`
- [ ] Authorization codes persistiti su Supabase (non in-memory)
- [ ] URL di produzione configurati (ngrok è temporaneo)

---

## 6. Fase 2 — Riproduzione musicale

### Come funziona AudioPlayer Alexa

Alexa non scarica musica: riceve uno **stream URL** diretto e riproduce l'audio in streaming. La skill deve rispondere agli intent vocali con una direttiva `AudioPlayer.Play` contenente l'URL dello stream.

Per YouTube, l'URL diretto dello stream audio va estratto a runtime (le URL di YouTube scadono). Librerie utili: `ytdl-core`, `yt-dlp` (subprocess).

### Flusso riproduzione

```
Utente                  Alexa Skill             Backend
  │                         │                      │
  │  "Alexa, riproduci      │                      │
  │   [nome brano]"         │                      │
  │────────────────────────►│                      │
  │                         │  GET /stream?q=...   │
  │                         │  + access_token      │
  │                         │─────────────────────►│
  │                         │                      │ recupera brano
  │                         │                      │ da Supabase
  │                         │                      │ risolve URL YouTube
  │                         │◄─────────────────────│
  │                         │  { streamUrl }       │
  │  ♪ riproduzione ♪       │                      │
  │◄────────────────────────│ AudioPlayer.Play      │
```

### Intent da implementare

| Intent | Comando vocale esempio | Azione |
|--------|------------------------|--------|
| `PlayIntent` | "riproduci [brano/artista]" | Cerca su Supabase + avvia stream |
| `AMAZON.PauseIntent` | "pausa" | Mette in pausa |
| `AMAZON.ResumeIntent` | "riprendi" | Riprende |
| `AMAZON.NextIntent` | "prossimo" | Brano successivo |
| `AMAZON.StopIntent` | "stop" / "ferma" | Ferma riproduzione |

### Stato implementazione Fase 2

- [ ] Endpoint backend `/stream` per risolvere URL audio da YouTube
- [ ] Intent `PlayIntent` nella skill
- [ ] Intent built-in Alexa (Pause, Resume, Next, Stop)
- [ ] Recupero brani/playlist utente da Supabase tramite access token
- [ ] Gestione coda di riproduzione (playlist)

---

## 7. Backend OAuth2

### Avvio e dipendenze

```bash
cd alexa-supabase-backend
npm install
node be.js        # server su http://localhost:3000
```

**Dipendenze (`package.json`):**

| Pacchetto | Versione | Uso |
|-----------|----------|-----|
| `express` | ^5.2.1 | Server HTTP |
| `cors` | ^2.8.5 | Header CORS |
| `@supabase/supabase-js` | ^2.88.0 | Client Supabase |

### Variabili d'ambiente

Da creare: `alexa-supabase-backend/.env`

```env
SUPABASE_URL=https://xzcdfhaylwoqbfucgcau.supabase.co
SUPABASE_ANON_KEY=<chiave_anonima>
PORT=3000
```

> Attualmente le credenziali sono hardcoded in `be.js` — da migrare prima del deploy.

---

## 8. Supabase

- **Progetto URL**: `https://xzcdfhaylwoqbfucgcau.supabase.co`
- **Autenticazione**: OTP a 6 cifre via email (template "Magic Link" modificato per mostrare `{{ .Token }}`)
- **Tabelle rilevanti**: da definire nella Fase 2 (brani, playlist, preferenze utente)

---

## 9. Configurazione Alexa Developer Console

- **Skill ID**: `MFP4HI9LYTIIU`
- **Interfacce**: AudioPlayer (da abilitare per la Fase 2)

### Account Linking — configurazione attuale

| Campo | Valore |
|-------|--------|
| Crea account o collega esistente | Sì |
| Skill utilizzabile senza account linking | Sì (raccomandato) |
| Grant type | Authorization Code |
| PKCE | Disabilitato |
| **Web Authorization URI** | `https://bibliopolar-cadence-unenrolled.ngrok-free.dev/authorize` |
| **Access Token URI** | `https://bibliopolar-cadence-unenrolled.ngrok-free.dev/token` |
| Client ID | `12c60961-40b0-41b7-ba64-ecf73182ef07` |
| Client Secret | `4b0babdf189298c6359045f411b248ba1091dd58aa94acb8fa495164994eac6d` |
| Authentication Scheme | HTTP Basic |
| Scope | `email` |

**Alexa Redirect URLs** (da aggiungere nelle URL consentite di Supabase):
- `https://pitangui.amazon.com/api/skill/link/MFP4HI9LYTIIU`
- `https://layla.amazon.com/api/skill/link/MFP4HI9LYTIIU`
- `https://alexa.amazon.co.jp/api/skill/link/MFP4HI9LYTIIU`

---

## 10. Changelog

| Data | Descrizione |
|------|-------------|
| 2024-12 | Setup iniziale backend Express + Supabase magic link |
| 2024-12 | Implementazione flusso OAuth2 base (`/send-magic-link`, `/magic-callback`, `/token`) |
| 2026-04-28 | Creazione documentazione di progetto |
| 2026-04-28 | Aggiunta configurazione Account Linking Alexa (Authorization URI, Token URI, ngrok, client ID) |
| 2026-04-28 | Implementato flusso OAuth2 con magic link — scartato perché il click email esce dalla WebView Alexa |
| 2026-04-28 | Migrato a flusso OTP 6 cifre: `/authorize`, `/send-otp`, `/verify-otp`, `/token` — tutto nella WebView |
