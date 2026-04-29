import express from 'express';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

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

// 5. Refresh URL YouTube scaduto: invocato dalla skill quando rileva url_expires_at < now
app.post('/refresh-track', async (req, res) => {
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

  let info;
  try {
    const { stdout } = await execFileP('yt-dlp', [
      '-j',
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--no-playlist',
      `https://www.youtube.com/watch?v=${youtube_id}`,
    ], { maxBuffer: 8 * 1024 * 1024 });
    info = JSON.parse(stdout);
  } catch (e) {
    console.log('ERRORE yt-dlp:', e.message);
    return res.status(502).json({ error: 'ytdlp_failed', detail: e.message });
  }

  const url = info.url;
  if (!url) {
    return res.status(502).json({ error: 'no_stream_url' });
  }

  const expiryMatch = /[?&]expire=(\d+)/.exec(url);
  const expiresAt = expiryMatch
    ? new Date(parseInt(expiryMatch[1]) * 1000).toISOString()
    : new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();

  const { data: updated, error: updateError } = await supabaseAdmin
    .from('current_track')
    .update({
      url,
      url_expires_at: expiresAt,
      track_title:  info.title || null,
      track_artist: info.uploader || info.artist || null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', user_id)
    .select();

  if (updateError) {
    console.log('ERRORE update current_track:', updateError);
    return res.status(500).json({ error: 'update_failed', detail: updateError.message });
  }
  if (!updated || updated.length === 0) {
    return res.status(404).json({ error: 'track_not_found' });
  }

  console.log(`Refresh OK per ${user_id} (${youtube_id})`);
  res.json({ ok: true, url, url_expires_at: expiresAt });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server avviato su http://localhost:${PORT}`));
