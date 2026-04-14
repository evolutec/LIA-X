/**
 * Model Manager Bridge Server
 * Traduit l'API attendue par le frontend React vers l'API native Ollama IPEX.
 *
 * Mappings :
 *   GET  /api/version              → GET  /api/version       (Ollama)
 *   GET  /api/models/available     → GET  /api/tags          (liste tous les modèles)
 *   GET  /api/models               → GET  /api/ps            (modèles en VRAM)
 *   GET  /api/models/active        → GET  /api/ps            (premier actif)
 *   GET  /api/models/status        → GET  /api/tags + /api/ps
 *   POST /api/models/download      → POST /api/pull
 *   POST /api/models/load          → POST /api/generate keep_alive=-1 (warmup)
 *   POST /api/models/select        → state in-memory
 *   POST /api/models/unload        → POST /api/generate keep_alive=0  (evict)
 *   DELETE /api/models/files/:name → DELETE /api/delete
 */

'use strict';

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());

const OLLAMA = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
const PORT = Number(process.env.MODEL_MANAGER_PORT || 3002);

// Active model state (in-memory, resets on restart)
let activeModel = '';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ollama(endpoint, options = {}) {
  const url = `${OLLAMA}${endpoint}`;
  return fetch(url, options);
}

function err(res, status, message) {
  return res.status(status).json({ detail: message });
}

// ---------------------------------------------------------------------------
// Static frontend (built by Vite into /model-manager/dist)
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'dist')));

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// GET /api/version
app.get('/api/version', async (req, res) => {
  try {
    const r = await ollama('/api/version');
    if (!r.ok) return err(res, 502, r.statusText);
    const data = await r.json();
    res.json({
      version: data.version,
      device: 'Intel Arc GPU (IPEX WSL2 · Level-Zero)',
      model_dir: '~/.ollama/models',
    });
  } catch (e) {
    err(res, 502, e.message);
  }
});

// GET /api/models/available  →  tous les modèles connus d'Ollama
app.get('/api/models/available', async (req, res) => {
  try {
    const r = await ollama('/api/tags');
    if (!r.ok) return err(res, 502, r.statusText);
    const data = await r.json();
    const files = (data.models || []).map((m) => ({
      name: m.name,
      size: m.size,
      modified_at: Math.floor(new Date(m.modified_at).getTime() / 1000),
    }));
    res.json({ files });
  } catch (e) {
    err(res, 502, e.message);
  }
});

// GET /api/models  →  modèles actuellement chargés en VRAM
app.get('/api/models', async (req, res) => {
  try {
    const r = await ollama('/api/ps');
    if (!r.ok) return err(res, 502, r.statusText);
    const data = await r.json();
    const models = (data.models || []).map((m) => ({
      id: m.name,
      model: m.name,
      size_vram: m.size_vram,
      expires_at: m.expires_at,
    }));
    res.json({ models });
  } catch (e) {
    err(res, 502, e.message);
  }
});

// GET /api/models/active
app.get('/api/models/active', async (req, res) => {
  try {
    // Si aucun actif mémorisé, prend le premier modèle en VRAM
    if (!activeModel) {
      const r = await ollama('/api/ps');
      if (r.ok) {
        const data = await r.json();
        if (data.models?.length > 0) activeModel = data.models[0].name;
      }
    }
    res.json({ active_model: activeModel });
  } catch {
    res.json({ active_model: activeModel });
  }
});

// GET /api/models/status
app.get('/api/models/status', async (req, res) => {
  try {
    const [tagsRes, psRes] = await Promise.all([
      ollama('/api/tags'),
      ollama('/api/ps'),
    ]);
    const tags = tagsRes.ok ? await tagsRes.json() : { models: [] };
    const ps   = psRes.ok  ? await psRes.json()   : { models: [] };
    res.json({
      total_models: (tags.models || []).length,
      running_models: (ps.models || []).length,
      gpu: { device: 'Intel Arc GPU (IPEX WSL2 · Level-Zero)' },
      models: (ps.models || []).map((m) => ({
        model: m.name,
        device: 'Intel Arc GPU',
        approx_memory_bytes: m.size_vram || 0,
      })),
    });
  } catch (e) {
    err(res, 502, e.message);
  }
});

// POST /api/models/download  →  ollama pull
app.post('/api/models/download', async (req, res) => {
  const name = req.body.ollama_name || req.body.url;
  if (!name) return err(res, 400, 'ollama_name requis');
  try {
    // stream:true → on consomme la réponse NDJSON jusqu'au status "success"
    const r = await ollama('/api/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, stream: true }),
    });
    if (!r.ok) {
      const t = await r.text();
      return err(res, r.status, t);
    }
    // Consume NDJSON stream until done
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastStatus = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop(); // incomplete last line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.status) lastStatus = j.status;
          if (j.status === 'success') {
            return res.json({ filename: name, status: 'ok' });
          }
          if (j.error) return err(res, 500, j.error);
        } catch {
          // skip malformed line
        }
      }
    }
    if (lastStatus === 'success' || buf.includes('"success"')) {
      return res.json({ filename: name, status: 'ok' });
    }
    err(res, 500, `Pull terminé avec statut : ${lastStatus || 'inconnu'}`);
  } catch (e) {
    err(res, 502, e.message);
  }
});

// POST /api/models/load  →  warmup via generate keep_alive=-1
app.post('/api/models/load', async (req, res) => {
  const model = req.body.model;
  if (!model) return err(res, 400, 'model requis');
  try {
    const r = await ollama('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: -1, stream: false }),
    });
    if (!r.ok) {
      const t = await r.text();
      return err(res, r.status, t);
    }
    activeModel = model;
    res.json({ model, status: 'loaded' });
  } catch (e) {
    err(res, 502, e.message);
  }
});

// POST /api/models/select  →  mise à jour de l'état in-memory
app.post('/api/models/select', (req, res) => {
  const model = req.body.model;
  if (!model) return err(res, 400, 'model requis');
  activeModel = model;
  res.json({ active_model: model });
});

// POST /api/models/unload  →  generate keep_alive=0 pour éjecter de la VRAM
app.post('/api/models/unload', async (req, res) => {
  const model = req.body.model;
  if (!model) return err(res, 400, 'model requis');
  try {
    await ollama('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: 0, stream: false }),
    });
    if (activeModel === model) activeModel = '';
    res.json({ model, status: 'unloaded' });
  } catch (e) {
    err(res, 502, e.message);
  }
});

// DELETE /api/models/files/:filename  →  ollama delete
app.delete('/api/models/files/:filename', async (req, res) => {
  const filename = decodeURIComponent(req.params.filename);
  try {
    const r = await ollama('/api/delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: filename }),
    });
    if (!r.ok) {
      const t = await r.text();
      return err(res, r.status, t);
    }
    if (activeModel === filename) activeModel = '';
    res.json({ filename, status: 'deleted' });
  } catch (e) {
    err(res, 502, e.message);
  }
});

// POST /api/models/import-hf  →  ollama create avec Modelfile FROM <url_gguf>
// Supporte les URLs directes HuggingFace (.gguf) et les refs hf.co/owner/repo:tag
app.post('/api/models/import-hf', async (req, res) => {
  const { url, name } = req.body;
  if (!url) return err(res, 400, 'url requis');
  if (!name) return err(res, 400, 'name requis');

  // Nettoyage : retirer le paramètre ?download=true et espaces
  const cleanUrl = url.trim().replace(/\?download=[^&]+(&|$)/, '').replace(/&$/, '');
  const modelfile = `FROM ${cleanUrl}\n`;

  try {
    const r = await ollama('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), modelfile, stream: true }),
    });
    if (!r.ok) {
      const t = await r.text();
      return err(res, r.status, t);
    }

    // Consommer le stream NDJSON jusqu'à success
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let lastStatus = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.status) lastStatus = j.status;
          if (j.status === 'success') return res.json({ filename: name.trim(), status: 'ok' });
          if (j.error) return err(res, 500, j.error);
        } catch { /* skip malformed line */ }
      }
    }
    res.json({ filename: name.trim(), status: lastStatus || 'ok' });
  } catch (e) {
    err(res, 502, e.message);
  }
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Model Manager] UI: http://0.0.0.0:${PORT}  →  Ollama: ${OLLAMA}`);
});
