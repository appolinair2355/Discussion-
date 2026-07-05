/**
 * server.js — Point d'entrée Render.com
 * Port : 10000 (ou variable d'environnement PORT)
 *
 * Démarre l'application compilée en interne sur PORT+1,
 * ajoute les routes de génération vidéo IA (avec rate-limiting),
 * puis proxifie tout le reste vers l'app interne.
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT       = parseInt(process.env.PORT ?? '10000', 10);
const INNER_PORT = PORT + 1;

/* ──────────────────────────────────────────────
   Rate-limiter en mémoire (sans dépendance externe)
   Max 5 générations par heure par adresse IP.
   ────────────────────────────────────────────── */
const RATE_WINDOW_MS  = 60 * 60 * 1000; // 1 heure
const RATE_MAX        = 5;              // requêtes max par fenêtre
const ipLog = new Map(); // ip → [timestamps]

function checkRateLimit(ip) {
  const now = Date.now();
  const times = (ipLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_MAX) {
    return false;
  }
  times.push(now);
  ipLog.set(ip, times);
  return true;
}

// Nettoyage du cache toutes les heures
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of ipLog.entries()) {
    const fresh = times.filter(t => now - t < RATE_WINDOW_MS);
    if (fresh.length === 0) ipLog.delete(ip);
    else ipLog.set(ip, fresh);
  }
}, RATE_WINDOW_MS);

/* ──────────────────────────────────────────────
   1. Démarrage de l'application interne
   ────────────────────────────────────────────── */
const innerEnv = { ...process.env, PORT: String(INNER_PORT) };

const inner = spawn('node', ['--enable-source-maps', 'dist/index.mjs'], {
  env: innerEnv,
  stdio: 'inherit',
});

inner.on('error', (err) => console.error('[inner]', err.message));
inner.on('exit',  (code) => {
  if (code !== 0) console.error('[inner] exited with code', code);
});

// Laisser le temps à l'app interne de démarrer
await new Promise((r) => setTimeout(r, 4000));

/* ──────────────────────────────────────────────
   2. Serveur Express externe
   ────────────────────────────────────────────── */
const app = express();
// ⚠️  NE PAS mettre express.json() globalement : il consomme le body stream
// et le proxy ne peut plus le retransmettre aux routes de l'app interne.
// On l'applique uniquement sur les routes vidéo qui en ont besoin.

/* ── Helpers ── */
const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0].trim();

const sanitizeError = (msg) =>
  typeof msg === 'string' ? msg.slice(0, 300) : 'Erreur inconnue';

/* ── Route : page de génération vidéo ── */
app.get('/video', (_req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'video.html'));
});

/* ── API : lancer la génération ── */
app.post('/api/generate-video', express.json({ limit: '64kb' }), async (req, res) => {
  // Rate-limiting
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: `Limite atteinte : maximum ${RATE_MAX} vidéos par heure. Réessayez plus tard.`,
    });
  }

  // Validation du prompt
  const raw = req.body?.prompt;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ error: 'Le prompt est requis.' });
  }
  const prompt = raw.trim().slice(0, 500); // capped à 500 chars

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return res.status(503).json({
      error: 'Service de génération vidéo non configuré sur ce serveur.',
    });
  }

  try {
    const upstream = await fetch(
      'https://api.replicate.com/v1/models/minimax/video-01/predictions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'wait=5',
        },
        body: JSON.stringify({
          input: { prompt, prompt_optimizer: true },
        }),
      }
    );

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      console.error('[generate-video] upstream error', upstream.status, body.slice(0, 200));
      return res.status(502).json({ error: 'Erreur lors de la génération. Veuillez réessayer.' });
    }

    const data = await upstream.json();
    // Ne retourner que les champs nécessaires
    res.json({
      id:     data.id,
      status: data.status,
      output: data.output ?? null,
      error:  data.error  ? sanitizeError(data.error) : null,
    });
  } catch (err) {
    console.error('[generate-video]', err.message);
    res.status(502).json({ error: 'Erreur réseau lors de la génération.' });
  }
});

/* ── API : polling du statut ── */
app.get('/api/video-status/:id', async (req, res) => {
  const { id } = req.params;

  // Validation de l'ID (format Replicate : alphanumérique + tirets)
  if (!/^[a-z0-9][a-z0-9\-]{0,63}$/i.test(id)) {
    return res.status(400).json({ error: 'ID de prédiction invalide.' });
  }

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return res.status(503).json({ error: 'Service non configuré.' });

  try {
    const upstream = await fetch(
      `https://api.replicate.com/v1/predictions/${id}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!upstream.ok) {
      return res.status(502).json({ error: 'Impossible de récupérer le statut.' });
    }

    const data = await upstream.json();
    res.json({
      id:     data.id,
      status: data.status,
      output: data.output ?? null,
      error:  data.error  ? sanitizeError(data.error) : null,
    });
  } catch (err) {
    console.error('[video-status]', err.message);
    res.status(502).json({ error: 'Erreur réseau lors du polling.' });
  }
});

/* ── Proxy vers l'app interne (HTTP + WS) ── */
const proxy = createProxyMiddleware({
  target: `http://localhost:${INNER_PORT}`,
  changeOrigin: true,
  ws: true,
  on: {
    error: (err, _req, res) => {
      console.error('[proxy]', err.message);
      if (res && typeof res.writeHead === 'function') {
        res.writeHead(502);
        res.end('Service temporairement indisponible.');
      }
    },
  },
});

app.use('/', proxy);

/* ── Démarrage ── */
const server = app.listen(PORT, () => {
  console.log(`✅ Dahomey Chat actif sur le port ${PORT}`);
  console.log(`   App interne : port ${INNER_PORT}`);
});

server.on('upgrade', proxy.upgrade);

process.on('SIGTERM', () => {
  console.log('SIGTERM reçu — arrêt propre');
  inner.kill('SIGTERM');
  server.close();
});
