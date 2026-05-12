import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Innertube, ClientType, UniversalCache } from 'youtubei.js';
import { BG } from 'bgutils-js';
import { JSDOM } from 'jsdom';

const execFileP = promisify(execFile);

// Bootstrap del PO Token (Proof-of-Origin Token).
// Da fine 2024 YouTube richiede un PO Token a tutti i client per esporre
// gli URL streaming (formati 140/139 m4a). Senza, fmt.url e fmt.signature_cipher
// arrivano vuoti. bgutils-js esegue il challenge BotGuard di YouTube (in un
// JSDOM perché serve un DOM-like environment) e produce il token.
//
// Ottimizzazione: il PO Token è valido per ~12 ore — non serve rigenerarlo
// ad ogni richiesta. Lo facciamo una volta al boot insieme all'Innertube.
async function generatePoToken() {
  // 1. Crea client temporaneo per ottenere visitor_data (identifica il "device").
  const tempClient = await Innertube.create({ retrieve_player: false });
  const visitorData = tempClient.session.context.client.visitorData;
  if (!visitorData) throw new Error('visitor_data non disponibile dal client temporaneo');

  // 2. Setup DOM globale (richiesto dal codice JS che YouTube ci fa eseguire).
  const dom = new JSDOM('<!DOCTYPE html><html><head></head><body></body></html>', {
    url: 'https://www.youtube.com/',
    referrer: 'https://www.youtube.com/',
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    origin: dom.window.origin,
  });

  // 3. Esegue il challenge BotGuard.
  const requestKey = 'O43z0dpjhgX20SCx4KAo'; // chiave pubblica YouTube nota
  const bgConfig = {
    fetch: (input, init) => fetch(input, init),
    globalObj: globalThis,
    identifier: visitorData,
    requestKey,
  };

  const challenge = await BG.Challenge.create(bgConfig);
  if (!challenge) throw new Error('BG.Challenge.create returned null');

  const interpreterJavascript = challenge.interpreterJavascript?.privateDoNotAccessOrElseSafeScriptWrappedValue;
  if (interpreterJavascript) {
    new Function(interpreterJavascript)();
  } else {
    throw new Error('Interpreter JavaScript non presente nel challenge');
  }

  const poTokenResult = await BG.PoToken.generate({
    program: challenge.program,
    globalName: challenge.globalName,
    bgConfig,
  });
  if (!poTokenResult?.poToken) throw new Error('PO Token vuoto dopo generate');

  console.log(`PO Token generato (visitor=${visitorData.slice(0, 16)}..., token=${poTokenResult.poToken.slice(0, 16)}...)`);
  return { poToken: poTokenResult.poToken, visitorData };
}

// Singleton Innertube — il bootstrap include la generazione del PO Token,
// operazione costosa (~3-5s). Lo riutilizziamo per tutte le richieste.
let _ytStreamClient = null;
let _ytStreamPromise = null;
async function ytStreamClient() {
  if (_ytStreamClient) return _ytStreamClient;
  if (_ytStreamPromise) return _ytStreamPromise;
  _ytStreamPromise = (async () => {
    const { poToken, visitorData } = await generatePoToken();
    return Innertube.create({
      location: 'US',
      retrieve_player: true,
      client_type: ClientType.WEB,
      po_token: poToken,
      visitor_data: visitorData,
      generate_session_locally: true,
      cache: new UniversalCache(false),
    });
  })()
    .then((c) => { _ytStreamClient = c; return c; })
    .catch((e) => { _ytStreamPromise = null; throw e; });
  return _ytStreamPromise;
}

// Stessi client strategy usati dall'app beatly. Ordine: prima quelli che
// l'app considera più affidabili. Usato dall'endpoint diagnostico
// /debug-stream per esplorare i comportamenti dei vari client.
const YT_CLIENT_STRATEGIES = [
  'WEB_SAFARI',
  'ANDROID_VR',
  'TV_SIMPLY',
  'IOS',
  'MWEB',
];

// Client da provare in cascata. L'ordine privilegia quelli che a oggi non
// richiedono PO Token: ANDROID_VR e TV_EMBEDDED espongono ancora i formati
// 140/139 (m4a/AAC) con url o signature_cipher non vuoti. IOS, ANDROID, MWEB
// in v17 richiedono PO Token e ritornano formati con url/cipher vuoti.
const YT_CLIENT_STRATEGIES_FUNCTIONAL = [
  'ANDROID_VR',
  'TV_EMBEDDED',
  'TV',
  'WEB_EMBEDDED',
  'IOS',
  'ANDROID',
  'WEB',
];

// Bucket pubblico Supabase Storage dove cachiamo gli m4a per Alexa.
// L'URL salvato su current_track.url punta a questo bucket — niente IP locking
// googlevideo, niente streaming dal BE.
const STORAGE_BUCKET = 'audio-cache';
const STORAGE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Ritorna il primo formato Alexa-compatibile (audio-only m4a o, in fallback,
// combinato mp4 con audio AAC). Alexa AudioPlayer ignora la traccia video se
// presente, quindi un formato combinato funziona — paghiamo solo banda extra.
function pickAlexaAudioFormat(info) {
  // Preferenza 1: adaptive audio-only m4a/AAC
  const adaptive = info?.streaming_data?.adaptive_formats || [];
  const audioOnly = adaptive.filter(
    (f) => f.has_audio && !f.has_video && (f.mime_type || '').includes('audio/mp4')
  );
  if (audioOnly.length) {
    audioOnly.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
    return audioOnly.find((f) => (f.bitrate || 0) <= 192000) || audioOnly[0];
  }
  // Preferenza 2: combined mp4 con audio (es. itag 18 = 360p mp4 + AAC)
  const combined = (info?.streaming_data?.formats || []).filter(
    (f) => f.has_audio && (f.mime_type || '').includes('mp4')
  );
  if (combined.length) {
    combined.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
    return combined[0];
  }
  return null;
}

async function resolveStreamForClient(youtube_id, clientName) {
  const yt = await ytStreamClient();
  // youtubei.js v17 vuole `options` come oggetto: passare la stringa nuda
  // fa sì che `options?.client` sia undefined → la richiesta va sul client
  // default WEB ignorando sia il client richiesto sia il PoT.
  const info = await yt.getBasicInfo(youtube_id, {
    client: clientName,
    po_token: yt.session.po_token,
  });
  const status = info?.playability_status?.status;
  if (status && status !== 'OK') {
    return { ok: false, reason: `playability=${status}` };
  }
  const fmt = pickAlexaAudioFormat(info);
  if (!fmt) return { ok: false, reason: 'no_m4a_audio_only_format' };

  // Diagnostica: capire cosa il client espone davvero.
  console.log(`[${clientName}] format snapshot:`, {
    itag: fmt.itag,
    mime_type: fmt.mime_type,
    bitrate: fmt.bitrate,
    url_present: !!fmt.url,
    signature_cipher_present: !!fmt.signature_cipher,
    cipher_present: !!fmt.cipher,
    keys: Object.keys(fmt).slice(0, 30),
  });

  // Per ANDROID_VR/TV_EMBEDDED fmt.url è in chiaro. Per WEB serve decipher
  // via player JS. Per IOS in v17 entrambi sono vuoti (richiede PO Token):
  // in quel caso l'URL non c'è, il client viene scartato dal loop chiamante.
  let url = fmt.url || '';
  if (!url && fmt.signature_cipher) {
    try {
      url = await fmt.decipher(yt.session.player);
    } catch (e) {
      return { ok: false, reason: `decipher_failed: ${e.message}` };
    }
  }
  if (!url) {
    return { ok: false, reason: 'empty_url_likely_po_token_required' };
  }

  const expires = info?.streaming_data?.expires;
  // basic_info.author è una stringa (display name) nella v14 standard.
  const authorRaw = info.basic_info?.author;
  const author = typeof authorRaw === 'string' ? authorRaw : (authorRaw?.name ?? null);
  return {
    ok: true,
    url,
    mime_type: fmt.mime_type,
    bitrate: fmt.bitrate,
    duration: info.basic_info?.duration,
    title: info.basic_info?.title,
    author,
    expires: expires ? expires.toISOString() : null,
    has_ip_lock: /[?&]ip=/.test(url),
    has_sig_param: /[?&]sig(nature)?=/.test(url),
    // Esposto solo per uso interno (download). Non esporlo via API JSON.
    __info: info,
    __format: fmt,
    __client: clientName,
  };
}

// Scarica i bytes audio. Tenta prima info.download() di youtubei.js (gestione
// headers/range coerenti col client) e in caso di fallimento ripiega su un
// fetch diretto con User-Agent IOS YouTube. Il fallback è utile perché v17
// ha bug noti su info.download per certi client.
async function downloadStreamBuffer(resolved) {
  // Tentativo 1: info.download di youtubei.js
  try {
    const stream = await resolved.__info.download({
      type: 'audio',
      quality: 'best',
      format: 'mp4',
      client: resolved.__client,
    });
    const chunks = [];
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return Buffer.concat(chunks.map((c) => Buffer.from(c)));
  } catch (e) {
    console.log(`info.download fallito (${e.message}), provo fetch diretto`);
  }

  // Tentativo 2: fetch diretto con User-Agent IOS YouTube + Range
  if (!resolved.url) throw new Error('no_url_for_fallback_fetch');
  const ytRes = await fetch(resolved.url, { headers: youtubeRequestHeaders() });
  if (!ytRes.ok) {
    throw new Error(`googlevideo HTTP ${ytRes.status} (fallback fetch)`);
  }
  const ab = await ytRes.arrayBuffer();
  return Buffer.from(ab);
}

// Crea il bucket pubblico se non esiste. Idempotente.
async function ensureStorageBucket() {
  try {
    const { data: buckets, error } = await supabaseAdmin.storage.listBuckets();
    if (error) {
      console.log('Errore listBuckets:', error.message);
      return;
    }
    if (buckets?.some((b) => b.name === STORAGE_BUCKET)) {
      console.log(`Bucket ${STORAGE_BUCKET} già esistente`);
      return;
    }
    const { error: createError } = await supabaseAdmin.storage.createBucket(STORAGE_BUCKET, {
      public: true,
      fileSizeLimit: 50 * 1024 * 1024,
      allowedMimeTypes: ['audio/mp4', 'audio/aac', 'audio/mpeg'],
    });
    if (createError) console.log(`Errore creazione bucket: ${createError.message}`);
    else console.log(`Bucket ${STORAGE_BUCKET} creato (pubblico)`);
  } catch (e) {
    console.log('Errore ensureStorageBucket:', e.message);
  }
}

// Headers che googlevideo si aspetta dal client che ha originato l'URL.
// L'URL prodotto da youtubei.js per il client IOS contiene `c=IOS` nei
// query params: il CDN googlevideo verifica che lo User-Agent coincida con
// l'app YouTube IOS, altrimenti risponde 403 anche se l'IP è giusto.
// Il `Range: bytes=0-` è richiesto per iniziare il download progressivo:
// senza, alcuni edge nodes rispondono 403 invece di 200.
function youtubeRequestHeaders() {
  return {
    'User-Agent': 'com.google.ios.youtube/19.09.3 (iPhone15,2; U; CPU iOS 17_4_1 like Mac OS X)',
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    Range: 'bytes=0-',
  };
}

function publicAudioUrl(youtube_id) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${encodeURIComponent(youtube_id)}.m4a`;
}

// Verifica se il file è già nel bucket e ancora dentro il TTL.
async function cacheHitForYoutubeId(youtube_id) {
  try {
    const { data, error } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .list('', { search: `${youtube_id}.m4a`, limit: 1 });
    if (error || !data?.length) return null;
    const file = data.find((f) => f.name === `${youtube_id}.m4a`);
    if (!file) return null;
    const updatedAt = new Date(file.updated_at || file.created_at).getTime();
    const ageMs = Date.now() - updatedAt;
    if (ageMs > STORAGE_TTL_MS) return null;
    return { ageMs, size: file.metadata?.size };
  } catch (e) {
    console.log('cacheHitForYoutubeId errore:', e.message);
    return null;
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const BACKEND_URL = process.env.BACKEND_URL;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;

// Client pubblico (anon) per OTP / signin
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
// Client privilegiato (service_role) per le tabelle alexa_auth_codes / alexa_refresh_tokens
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;

const ALEXA_REDIRECT_URIS = [
  'https://pitangui.amazon.com/api/skill/link/MFP4HI9LYTIIU',
  'https://layla.amazon.com/api/skill/link/MFP4HI9LYTIIU',
  'https://alexa.amazon.co.jp/api/skill/link/MFP4HI9LYTIIU',
];

// CSS e stile comune
const pageStyle = `
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, sans-serif; background: #0f0f0f; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
    .card { background: #1a1a1a; border-radius: 16px; padding: 40px; width: 100%; max-width: 400px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    p { color: #888; font-size: 14px; margin-bottom: 28px; line-height: 1.5; }
    label { font-size: 13px; color: #aaa; display: block; margin-bottom: 6px; }
    input[type="email"], input[type="text"] { width: 100%; padding: 12px 16px; background: #2a2a2a; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 16px; margin-bottom: 20px; outline: none; }
    input:focus { border-color: #555; }
    button { width: 100%; padding: 14px; background: #fff; color: #000; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; }
    button:hover { background: #ddd; }
    .error { color: #ff6b6b; font-size: 14px; margin-bottom: 16px; }
  </style>`;

// 1. Alexa apre questa pagina — mostra il form email
app.get('/authorize', (req, res) => {
  console.log('--- /authorize ---', req.query);
  const { state, redirect_uri } = req.query;

  if (!state || !redirect_uri) return res.status(400).send('Parametri mancanti');
  if (!ALEXA_REDIRECT_URIS.includes(redirect_uri)) return res.status(400).send('redirect_uri non valido');

  res.send(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ebeat — Collegamento account</title>
  ${pageStyle}
</head>
<body>
  <div class="card">
    <h1>ebeat</h1>
    <p>Inserisci la tua email. Riceverai un codice da digitare nel passaggio successivo.</p>
    <form action="/send-otp" method="POST">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri}">
      <label for="email">Email</label>
      <input type="email" id="email" name="email" placeholder="nome@email.com" required autofocus>
      <button type="submit">Invia codice</button>
    </form>
  </div>
</body>
</html>`);
});

// 2. Invia OTP a 6 cifre via Supabase
app.post('/send-otp', async (req, res) => {
  console.log('--- /send-otp ---', { email: req.body.email });
  const { email, state, redirect_uri } = req.body;

  if (!email || !state || !redirect_uri) return res.status(400).send('Parametri mancanti');
  if (!ALEXA_REDIRECT_URIS.includes(redirect_uri)) return res.status(400).send('redirect_uri non valido');

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false }
  });

  if (error) return res.status(400).send(`<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><title>Errore</title>${pageStyle}</head>
<body><div class="card"><h1>ebeat</h1><p class="error">${error.message}</p>
<a href="/authorize?state=${encodeURIComponent(state)}&redirect_uri=${encodeURIComponent(redirect_uri)}"><button type="button">Riprova</button></a>
</div></body></html>`);

  res.send(`<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ebeat — Inserisci il codice</title>
  ${pageStyle}
</head>
<body>
  <div class="card">
    <h1>Controlla la tua email</h1>
    <p>Abbiamo inviato un codice a 6 cifre a <strong style="color:#fff">${email}</strong>. Inseriscilo qui sotto.</p>
    <form action="/verify-otp" method="POST">
      <input type="hidden" name="email" value="${email}">
      <input type="hidden" name="state" value="${state}">
      <input type="hidden" name="redirect_uri" value="${redirect_uri}">
      <label for="otp">Codice</label>
      <input type="text" id="otp" name="otp" placeholder="123456" maxlength="6" inputmode="numeric" required autofocus>
      <button type="submit">Conferma</button>
    </form>
  </div>
</body>
</html>`);
});

// 3. Verifica il codice OTP — tutto avviene nella WebView
app.post('/verify-otp', async (req, res) => {
  console.log('--- /verify-otp ---', { email: req.body.email });
  const { email, otp, state, redirect_uri } = req.body;

  if (!email || !otp || !state || !redirect_uri) return res.status(400).send('Parametri mancanti');
  if (!ALEXA_REDIRECT_URIS.includes(redirect_uri)) return res.status(400).send('redirect_uri non valido');

  const { data, error } = await supabase.auth.verifyOtp({
    email,
    token: otp,
    type: 'email'
  });

  if (error) return res.send(`<!DOCTYPE html>
<html lang="it"><head><meta charset="UTF-8"><title>Codice errato</title>${pageStyle}</head>
<body><div class="card"><h1>Codice non valido</h1>
<p class="error" style="margin-bottom:20px">${error.message}</p>
<form action="/verify-otp" method="POST">
  <input type="hidden" name="email" value="${email}">
  <input type="hidden" name="state" value="${state}">
  <input type="hidden" name="redirect_uri" value="${redirect_uri}">
  <label for="otp">Riprova con il codice</label>
  <input type="text" id="otp" name="otp" placeholder="123456" maxlength="6" inputmode="numeric" required autofocus>
  <button type="submit">Conferma</button>
</form></div></body></html>`);

  const userId = data.user.id;
  const alexaCode = crypto.randomBytes(32).toString('hex');

  const { error: insertError } = await supabaseAdmin
    .from('alexa_auth_codes')
    .insert({ code: alexaCode, user_id: userId });

  if (insertError) {
    console.log('ERRORE salvataggio auth code:', insertError);
    return res.status(500).send('Errore interno, riprova.');
  }

  console.log('OTP verificato, userId:', userId, '— redirect verso Alexa');
  return res.redirect(302,
    `${redirect_uri}?code=${encodeURIComponent(alexaCode)}&state=${encodeURIComponent(state)}`
  );
});

// 4. Alexa chiama questo endpoint server-to-server per ottenere l'access token
app.post('/token', async (req, res) => {
  console.log('--- /token ---');
  console.log('headers:', JSON.stringify(req.headers));
  console.log('body:', req.body);

  const authHeader = req.headers['authorization'] || '';
  const encoded = authHeader.replace('Basic ', '');
  const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
  const [incomingId, incomingSecret] = decoded.split(':');

  if (incomingId !== CLIENT_ID || incomingSecret !== CLIENT_SECRET) {
    console.log('ERRORE: credenziali non valide — id:', incomingId);
    return res.status(401).json({ error: 'invalid_client' });
  }

  const { grant_type, code, refresh_token } = req.body;

  // Refresh: Alexa chiama qui ogni ora per rinnovare l'access_token
  if (grant_type === 'refresh_token') {
    if (!refresh_token) {
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const { data: row, error: lookupError } = await supabaseAdmin
      .from('alexa_refresh_tokens')
      .select('user_id')
      .eq('token', refresh_token)
      .maybeSingle();

    if (lookupError || !row) {
      console.log('ERRORE: refresh_token non trovato:', refresh_token);
      return res.status(400).json({ error: 'invalid_grant' });
    }

    const userId = row.user_id;
    const newRefresh = crypto.randomBytes(32).toString('hex');

    // Rotazione: cancella il vecchio, inserisci il nuovo
    await supabaseAdmin.from('alexa_refresh_tokens').delete().eq('token', refresh_token);
    await supabaseAdmin.from('alexa_refresh_tokens').insert({
      token: newRefresh,
      user_id: userId,
      last_used_at: new Date().toISOString(),
    });

    console.log('Token rinnovato per userId:', userId);
    return res.json({
      access_token: userId,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: newRefresh
    });
  }

  // Primo scambio: code -> access_token + refresh_token
  if (grant_type !== 'authorization_code') {
    console.log('ERRORE: grant_type non valido:', grant_type);
    return res.status(400).json({ error: 'unsupported_grant_type' });
  }
  if (!code) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  const { data: entry, error: codeError } = await supabaseAdmin
    .from('alexa_auth_codes')
    .select('user_id, created_at')
    .eq('code', code)
    .maybeSingle();

  if (codeError || !entry) {
    console.log('ERRORE: codice non trovato:', code);
    return res.status(400).json({ error: 'invalid_grant' });
  }

  // Codice consumato comunque (anche se scaduto)
  await supabaseAdmin.from('alexa_auth_codes').delete().eq('code', code);

  const ageMs = Date.now() - new Date(entry.created_at).getTime();
  if (ageMs > AUTH_CODE_TTL_MS) {
    return res.status(400).json({ error: 'invalid_grant' });
  }

  const newRefresh = crypto.randomBytes(32).toString('hex');
  await supabaseAdmin.from('alexa_refresh_tokens').insert({
    token: newRefresh,
    user_id: entry.user_id,
  });

  console.log('Token emesso per userId:', entry.user_id);

  res.json({
    access_token: entry.user_id,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: newRefresh
  });
});

// DEBUG: prova tutti i client youtubei.js e ritorna metadata + flag IP lock.
// Usato per verificare se almeno un client produce URL non IP-locked,
// prerequisito per consumare lo stream direttamente da Alexa senza proxy.
// Esempio: GET /debug-stream/VkTNnCCKnE4
app.get('/debug-stream/:youtube_id', async (req, res) => {
  const { youtube_id } = req.params;
  if (!/^[a-zA-Z0-9_-]{6,20}$/.test(youtube_id || '')) {
    return res.status(400).json({ error: 'invalid_youtube_id' });
  }

  const results = {};
  for (const client of YT_CLIENT_STRATEGIES) {
    try {
      const r = await resolveStreamForClient(youtube_id, client);
      if (r.ok) {
        // Tronchiamo l'URL per leggibilità ma mostriamo i parametri firmati.
        const sparams = (r.url.match(/[?&]sparams=([^&]+)/) || [])[1];
        results[client] = {
          ok: true,
          mime_type: r.mime_type,
          bitrate: r.bitrate,
          duration: r.duration,
          has_ip_lock: r.has_ip_lock,
          has_sig_param: r.has_sig_param,
          expires: r.expires,
          sparams: sparams ? decodeURIComponent(sparams) : null,
          url_preview: r.url.slice(0, 200) + (r.url.length > 200 ? '...' : ''),
          url_full_length: r.url.length,
        };
      } else {
        results[client] = { ok: false, reason: r.reason };
      }
    } catch (e) {
      results[client] = { ok: false, reason: 'exception', message: e.message };
    }
  }
  res.json({ youtube_id, results });
});

// 5b. Refresh "storage": pipeline alternativa che scarica l'audio nel BE
//     e lo serve da bucket pubblico Supabase Storage. Tenuta come backup
//     nel caso YouTube smetta di esporre URL diretti consumabili da terzi
//     (es. se l'IP locking diventa rigido o yt-dlp android_vr si rompe).
//     Per attivarla, far puntare la skill a /refresh-track-storage via
//     env var BACKEND_REFRESH_URL.
//
// Pipeline:
//   1. cache hit su Supabase Storage (skip download/upload se file recente)
//   2. risolve URL googlevideo via youtubei.js (cliente IOS/WEB) con PoT
//   3. scarica il file (BE = stesso IP che ha richiesto l'URL → no 403)
//   4. upload a Supabase Storage bucket pubblico audio-cache/<id>.m4a
//   5. salva su current_track.url l'URL pubblico Supabase
app.post('/refresh-track-storage', async (req, res) => {
  console.log('--- /refresh-track ---', req.body);

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (token !== process.env.SUPABASE_SERVICE_KEY) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { user_id, youtube_id } = req.body;
  if (!user_id || !youtube_id) {
    return res.status(400).json({ error: 'missing_params' });
  }

  let resolved = null;

  // 1. Cache hit
  const cached = await cacheHitForYoutubeId(youtube_id);
  if (cached) {
    console.log(`Cache hit per ${youtube_id} (age=${Math.round(cached.ageMs/1000)}s, size=${cached.size})`);
  } else {
    // 2. Risolve URL googlevideo
    let lastErr = null;
    for (const client of YT_CLIENT_STRATEGIES_FUNCTIONAL) {
      try {
        const r = await resolveStreamForClient(youtube_id, client);
        if (r.ok) {
          console.log(`youtubei.js OK [client=${client}, mime=${r.mime_type}, bitrate=${r.bitrate}]`);
          resolved = r;
          break;
        }
        console.log(`youtubei.js [${client}] non ok: ${r.reason}`);
      } catch (e) {
        lastErr = e;
        console.log(`youtubei.js [${client}] errore: ${e.message}`);
      }
    }
    if (!resolved) {
      return res.status(502).json({
        error: 'no_compatible_stream',
        detail: lastErr?.message || 'nessun client youtubei.js ha prodotto uno stream Alexa-compatibile',
      });
    }

    // 3. Download via youtubei.js (gestisce headers IOS-coerenti e ranges)
    let buffer;
    try {
      buffer = await downloadStreamBuffer(resolved);
      console.log(`Download OK: ${buffer.length} bytes`);
    } catch (e) {
      console.log('ERRORE download:', e.message);
      return res.status(502).json({ error: 'download_failed', detail: e.message });
    }

    // 4. Upload a Supabase Storage (upsert: sovrascrive se esiste)
    const { error: uploadError } = await supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .upload(`${youtube_id}.m4a`, buffer, {
        contentType: 'audio/mp4',
        upsert: true,
        cacheControl: String(Math.floor(STORAGE_TTL_MS / 1000)),
      });
    if (uploadError) {
      console.log('ERRORE upload Storage:', uploadError);
      return res.status(500).json({ error: 'storage_upload_failed', detail: uploadError.message });
    }
    console.log(`Upload OK: ${youtube_id}.m4a`);
  }

  // 5. Aggiorna current_track con URL pubblico Supabase
  const url = publicAudioUrl(youtube_id);
  const expiresAt = new Date(Date.now() + STORAGE_TTL_MS).toISOString();

  const updates = {
    url,
    url_expires_at: expiresAt,
    updated_at: new Date().toISOString(),
  };
  if (resolved) {
    if (resolved.title) updates.track_title = resolved.title;
    if (resolved.author) updates.track_artist = resolved.author;
    if (resolved.duration) updates.track_duration = resolved.duration;
  }

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('current_track')
    .update(updates)
    .eq('user_id', user_id)
    .select();

  if (updateError) {
    console.log('ERRORE update current_track:', updateError);
    return res.status(500).json({ error: 'update_failed', detail: updateError.message });
  }
  if (!updated || updated.length === 0) {
    return res.status(404).json({ error: 'track_not_found' });
  }

  console.log(`Refresh OK per ${user_id} (${youtube_id}) → ${url}${cached ? ' [cached]' : ''}`);
  res.json({ ok: true, url, url_expires_at: expiresAt, cached: !!cached });
});

// DEPRECATO 2026-05-12 — vincolo: niente chiamate YouTube dal BE
// (IP datacenter condiviso → 429 + bot detection). Il flusso primario
// è "app pre-risolve e popola Supabase". Storia: yt-dlp → youtubei.js.
app.post('/refresh-track', async (req, res) => {
  return res.status(410).json({
    error: 'gone',
    detail: 'endpoint deprecato: il refresh URL stream va fatto dall\'app mobile (IP residenziale).',
  });
});

// DEPRECATO 2026-05-12 — vincolo: niente chiamate YouTube dal BE per
// evitare rate limiting/bot detection da IP datacenter condiviso. Il
// flusso primario è "app pre-risolve e popola Supabase". Lasciato il
// codice originale dopo il return 410 come riferimento storico.
app.post('/resolve-youtube-id', async (req, res) => {
  return res.status(410).json({
    error: 'gone',
    detail: 'endpoint deprecato: il resolve YouTube va fatto dall\'app mobile (IP residenziale).',
  });
});
// DEPRECATO 2026-05-12 — vincolo: niente chiamate YouTube/Deezer dal
// BE (IP datacenter condiviso → 429 + bot detection). Il refill di
// playback_queue viene fatto dall'app mobile su PlaybackActiveTrackChanged
// (IP residenziale, youtubei.js getUpNext).
app.post('/refill-queue', async (req, res) => {
  return res.status(410).json({
    error: 'gone',
    detail: 'endpoint deprecato: il refill della coda va fatto dall\'app mobile (IP residenziale).',
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Server avviato su http://localhost:${PORT}`);
  await ensureStorageBucket();
});
