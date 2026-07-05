/**
 * server.js — Point d'entrée Replit / Render.com
 * Port : 5000 (ou variable d'environnement PORT)
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import pkg from 'pg';
const { Pool } = pkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT       = parseInt(process.env.PORT ?? '5000', 10);
const INNER_PORT = PORT + 1;

/* ── DB pool (pour turn-order & clé IA) ── */
const dbPool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  : null;

async function dbQuery(sql, params = []) {
  if (!dbPool) return null;
  const client = await dbPool.connect();
  try {
    return (await client.query(sql, params)).rows;
  } finally {
    client.release();
  }
}

async function getAiKey() {
  try {
    const rows = await dbQuery('SELECT ai_key FROM group_settings WHERE id = 1');
    const key = rows?.[0]?.ai_key || process.env.FREEMODEL_API_KEY || '';
    return key;
  } catch {
    return process.env.FREEMODEL_API_KEY || '';
  }
}

/* ──────────────────────────────────────────────
   Rate-limiter en mémoire
   ────────────────────────────────────────────── */
const RATE_WINDOW_MS  = 60 * 60 * 1000;
const RATE_MAX        = 5;
const ipLog = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const times = (ipLog.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (times.length >= RATE_MAX) return false;
  times.push(now);
  ipLog.set(ip, times);
  return true;
}

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
  if (code !== 0) console.error('[inner] exited avec code', code);
});

await new Promise((r) => setTimeout(r, 4000));

/* ──────────────────────────────────────────────
   2. Serveur Express externe
   ────────────────────────────────────────────── */
const app = express();

const clientIp = (req) =>
  (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
    .split(',')[0].trim();

const sanitizeError = (msg) =>
  typeof msg === 'string' ? msg.slice(0, 300) : 'Erreur inconnue';

/* ─────────────────────────────────────────────────
   TOUR DE PAROLE : intercepter POST /api/messages
   L'admin ne peut parler qu'après que TOUS les membres
   ont donné leur avis dans le tour en cours.
   ───────────────────────────────────────────────── */
app.use('/api/messages', express.json({ limit: '2mb' }), async (req, res, next) => {
  if (req.method !== 'POST') return next();
  try {
    const rows = await dbQuery(
      `SELECT gs.turn_index, (SELECT COUNT(*) FROM members) AS member_count
       FROM group_settings gs WHERE gs.id = 1`
    );
    if (rows && rows.length > 0) {
      const turnIndex   = parseInt(rows[0].turn_index, 10);
      const memberCount = parseInt(rows[0].member_count, 10);
      if (memberCount > 0 && turnIndex !== 0) {
        const remaining = memberCount - turnIndex;
        return res.status(403).json({
          error: `⏳ Attendez que tous les membres s'expriment. Encore ${remaining} membre(s) doit(vent) parler avant votre tour.`,
        });
      }
    }
  } catch (e) {
    console.error('[turn-check]', e.message);
  }
  next();
});

/* ── Route : page génération vidéo (accessible depuis Paramètres) ── */
app.get('/video', (_req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'video.html'));
});

/* ── Route : page génération image ── */
app.get('/image', (_req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'image.html'));
});

/* ── Route : page génération d'histoires ── */
app.get('/story', (_req, res) => {
  res.sendFile(path.join(__dirname, 'client', 'story.html'));
});

/* ════════════════════════════════════════════════
   API VIDÉO
   ════════════════════════════════════════════════ */
app.post('/api/generate-video', express.json({ limit: '64kb' }), async (req, res) => {
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) {
    return res.status(429).json({
      error: `Limite atteinte : maximum ${RATE_MAX} vidéos par heure.`,
    });
  }

  const raw = req.body?.prompt;
  if (typeof raw !== 'string' || !raw.trim()) {
    return res.status(400).json({ error: 'Le prompt est requis.' });
  }
  const prompt = raw.trim().slice(0, 500);

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'Service de génération vidéo non configuré.' });
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
        body: JSON.stringify({ input: { prompt, prompt_optimizer: true } }),
      }
    );

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      console.error('[generate-video] upstream error', upstream.status, body.slice(0, 200));
      return res.status(502).json({ error: 'Erreur lors de la génération.' });
    }

    const data = await upstream.json();
    res.json({
      id: data.id, status: data.status,
      output: data.output ?? null,
      error: data.error ? sanitizeError(data.error) : null,
    });
  } catch (err) {
    console.error('[generate-video]', err.message);
    res.status(502).json({ error: 'Erreur réseau.' });
  }
});

app.get('/api/video-status/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9][a-z0-9\-]{0,63}$/i.test(id)) {
    return res.status(400).json({ error: 'ID invalide.' });
  }
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return res.status(503).json({ error: 'Service non configuré.' });

  try {
    const upstream = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!upstream.ok) return res.status(502).json({ error: 'Impossible de récupérer le statut.' });
    const data = await upstream.json();
    res.json({
      id: data.id, status: data.status,
      output: data.output ?? null,
      error: data.error ? sanitizeError(data.error) : null,
    });
  } catch (err) {
    console.error('[video-status]', err.message);
    res.status(502).json({ error: 'Erreur réseau.' });
  }
});

/* ════════════════════════════════════════════════
   API GÉNÉRATION IMAGE (Replicate - flux-schnell)
   ════════════════════════════════════════════════ */
app.post('/api/generate-image', express.json({ limit: '64kb' }), async (req, res) => {
  const { prompt } = req.body ?? {};
  if (typeof prompt !== 'string' || !prompt.trim()) {
    return res.status(400).json({ error: 'Le prompt de scène est requis.' });
  }

  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'REPLICATE_API_TOKEN non configuré.' });
  }

  const scenePrompt = prompt.trim().slice(0, 600)
    + ', cartoon style, comic book illustration, vibrant colors, clean lines, detailed background, african setting';

  try {
    const upstream = await fetch(
      'https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions',
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Prefer: 'wait=60',
        },
        body: JSON.stringify({
          input: {
            prompt: scenePrompt,
            aspect_ratio: '1:1',
            output_format: 'jpg',
            output_quality: 90,
            num_outputs: 1,
          },
        }),
      }
    );

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '');
      console.error('[generate-image] upstream error', upstream.status, body.slice(0, 300));
      return res.status(502).json({ error: 'Erreur lors de la génération d\'image.' });
    }

    const data = await upstream.json();

    if (data.status === 'succeeded' && data.output) {
      const url = Array.isArray(data.output) ? data.output[0] : data.output;
      return res.json({ status: 'succeeded', imageUrl: url, id: data.id });
    }

    res.json({ status: data.status, id: data.id, imageUrl: null });
  } catch (err) {
    console.error('[generate-image]', err.message);
    res.status(502).json({ error: 'Erreur réseau: ' + err.message });
  }
});

app.get('/api/image-status/:id', async (req, res) => {
  const { id } = req.params;
  if (!/^[a-z0-9][a-z0-9\-]{0,80}$/i.test(id)) {
    return res.status(400).json({ error: 'ID invalide.' });
  }
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token) return res.status(503).json({ error: 'Service non configuré.' });

  try {
    const upstream = await fetch(`https://api.replicate.com/v1/predictions/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!upstream.ok) return res.status(502).json({ error: 'Impossible de récupérer le statut.' });
    const data = await upstream.json();
    const url = data.output ? (Array.isArray(data.output) ? data.output[0] : data.output) : null;
    res.json({ status: data.status, imageUrl: url, error: data.error ? sanitizeError(data.error) : null });
  } catch (err) {
    res.status(502).json({ error: 'Erreur réseau.' });
  }
});

/* ════════════════════════════════════════════════
   API GÉNÉRATION D'HISTOIRE (FreeModel / OpenAI)
   ════════════════════════════════════════════════ */
app.post('/api/generate-story-episode', express.json({ limit: '128kb' }), async (req, res) => {
  const {
    title, synopsis, episodeNumber, totalEpisodes,
    paragraphCount, charsPerParagraph, characters, city,
    previousEpisodes
  } = req.body ?? {};

  if (!title || !episodeNumber) {
    return res.status(400).json({ error: 'Titre et numéro d\'épisode requis.' });
  }

  const aiKey = await getAiKey();
  if (!aiKey) {
    return res.status(503).json({ error: 'Clé API IA non configurée. Configurez-la dans les Paramètres du chat.' });
  }

  const isLastEpisode = parseInt(episodeNumber) >= parseInt(totalEpisodes);
  const charList = Array.isArray(characters) ? characters.join(', ') : (characters || '');
  const prevContext = Array.isArray(previousEpisodes) && previousEpisodes.length > 0
    ? `\n\nÉPISODES PRÉCÉDENTS (résumé) :\n${previousEpisodes.map((e, i) => `Épisode ${i+1}: ${e.slice(0, 300)}`).join('\n')}`
    : '';

  const systemPrompt = `Tu es un auteur professionnel de romans africains. Tu écris des histoires captivantes, culturellement riches, en français.
Règles strictes :
- Chaque paragraphe fait environ ${charsPerParagraph || 200} caractères
- Exactement ${paragraphCount || 3} paragraphes par épisode
- Histoire se déroule à ${city || 'Cotonou, Bénin'}
- Personnages : ${charList || 'non spécifiés'}
- Ton : dramatique, vivant, immersif
- PAS de titres de sections, juste le texte narratif
${isLastEpisode ? '- IMPORTANT : Ceci est le DERNIER épisode. L\'histoire DOIT se conclure de façon satisfaisante.' : ''}`;

  const userPrompt = `Écris l'épisode ${episodeNumber} sur ${totalEpisodes} de l'histoire intitulée "${title}".
Résumé général : ${synopsis || 'Histoire africaine captivante'}
${prevContext}
${isLastEpisode ? 'Cet épisode est le dernier : conclus l\'histoire de façon mémorable.' : `Cet épisode doit faire avancer l'intrigue et terminer sur un moment de suspense ou d'émotion.`}
Écris directement le texte de l'épisode, sans titre, sans numérotation.`;

  try {
    const response = await fetch('https://api.freemodel.dev/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${aiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: 1200,
        temperature: 0.85,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      console.error('[story-episode] AI error', response.status, body.slice(0, 200));
      return res.status(502).json({ error: 'Erreur de l\'IA. Vérifiez la clé API dans les Paramètres.' });
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim() ?? '';
    res.json({ content, episodeNumber });
  } catch (err) {
    console.error('[story-episode]', err.message);
    res.status(502).json({ error: 'Erreur réseau: ' + err.message });
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

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Dahomey Chat actif sur le port ${PORT}`);
  console.log(`   App interne : port ${INNER_PORT}`);
});

server.on('upgrade', proxy.upgrade);

process.on('SIGTERM', () => {
  console.log('SIGTERM reçu — arrêt propre');
  inner.kill('SIGTERM');
  server.close();
  if (dbPool) dbPool.end();
});
