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
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { exec } = require('child_process');

const app = express();
app.use(express.json());

const OLLAMA = process.env.OLLAMA_HOST || 'http://host.docker.internal:11434';
const PORT = Number(process.env.MODEL_MANAGER_PORT || 3002);
const MODEL_INSPECTION_TTL_MS = 30_000;
const MODEL_INSPECTION_TIMEOUT_MS = 4_000;
const UNSUPPORTED_ARCHITECTURES = new Set(['qwen35', 'gemma4']);

// Active model state (in-memory, resets on restart)
let activeModel = '';
const modelInspectionCache = new Map();

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

async function getRunningModels() {
  const response = await ollama('/api/ps');
  if (!response.ok) {
    throw new Error(response.statusText);
  }
  const data = await response.json();
  return data.models || [];
}

async function getResolvedActiveModel() {
  const runningModels = await getRunningModels();
  const runningNames = new Set(runningModels.map((model) => model.name));

  if (activeModel && runningNames.has(activeModel)) {
    return activeModel;
  }

  activeModel = runningModels[0]?.name || '';
  return activeModel;
}

function clearModelInspectionCache() {
  modelInspectionCache.clear();
}

function extractOllamaErrorText(detail) {
  const raw = String(detail || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.error === 'string') {
      return parsed.error;
    }
    if (typeof parsed?.detail === 'string') {
      return parsed.detail;
    }
  } catch {
    // Non-JSON payload, keep raw text.
  }

  return raw;
}

function inferModelIssue(detail, architecture) {
  const message = extractOllamaErrorText(detail).toLowerCase();
  const normalizedArchitecture = String(architecture || '').trim().toLowerCase();

  if (UNSUPPORTED_ARCHITECTURES.has(normalizedArchitecture) || /unknown model architecture/.test(message)) {
    return 'unsupported-architecture';
  }

  if (
    /bad manifest/.test(message)
    || /manifest filepath/.test(message)
    || /no such file or directory/.test(message)
    || /open .*\.ollama\/models\/blobs/.test(message)
    || /file does not exist/.test(message)
  ) {
    return 'corrupted-model';
  }

  return null;
}

async function inspectModel(model) {
  const cached = modelInspectionCache.get(model);
  if (cached && (Date.now() - cached.timestamp) < MODEL_INSPECTION_TTL_MS) {
    return cached.value;
  }

  let value;
  try {
    const response = await ollama('/api/show', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(MODEL_INSPECTION_TIMEOUT_MS),
    });

    if (!response.ok) {
      const errorText = extractOllamaErrorText(await response.text());
      value = {
        architecture: '',
        issue: inferModelIssue(errorText, ''),
        errorText,
      };
    } else {
      const data = await response.json();
      const architecture = data?.model_info?.['general.architecture'] || '';
      value = {
        architecture,
        issue: inferModelIssue('', architecture),
        errorText: '',
      };
    }
  } catch (error) {
    value = {
      architecture: '',
      issue: 'inspection-timeout',
      errorText: error?.name === 'TimeoutError' ? 'Inspection du modèle expirée' : String(error?.message || error),
    };
  }

  modelInspectionCache.set(model, { timestamp: Date.now(), value });
  return value;
}

async function filterVisibleModels(models) {
  const inspected = await Promise.all(
    models.map(async (model) => ({
      model,
      inspection: await inspectModel(model.name),
    }))
  );

  return inspected
    .filter(({ inspection }) => inspection.issue !== 'unsupported-architecture' && inspection.issue !== 'corrupted-model' && inspection.issue !== 'inspection-timeout')
    .map(({ model }) => model);
}

function describeLoadFailure(model, errorText, inspection) {
  const detail = extractOllamaErrorText(errorText);
  const architecture = inspection?.architecture || '';
  const issue = inspection?.issue || inferModelIssue(detail, architecture);

  if (issue === 'unsupported-architecture') {
    return `Le modèle ${model} utilise l’architecture ${architecture || 'inconnue'}, non supportée par cette version d’Ollama IPEX-LLM.`;
  }

  if (issue === 'corrupted-model') {
    return `Le modèle ${model} est corrompu ou incomplet dans ~/.ollama/models. Supprime-le puis retélécharge-le.`;
  }

  return detail;
}

function normalizeModelName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^[-.:/]+|[-.:/]+$)/g, '');
}

function filenameFromUrl(value) {
  const pathname = new URL(value).pathname;
  return decodeURIComponent(path.basename(pathname));
}

async function downloadFileWithDigest(url, destinationPath) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'LIA-Model-Manager',
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Téléchargement HF impossible (${response.status} ${response.statusText})`);
  }

  const hash = crypto.createHash('sha256');
  const source = Readable.fromWeb(response.body);
  const digestStream = new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

  await pipeline(source, digestStream, fs.createWriteStream(destinationPath));
  return `sha256:${hash.digest('hex')}`;
}

async function uploadBlobToOllama(digest, filePath) {
  const response = await ollama(`/api/blobs/${digest}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
    },
    body: fs.createReadStream(filePath),
    duplex: 'half',
  });

  if (!response.ok && response.status !== 201) {
    const text = await response.text();
    throw new Error(text || `Upload blob échoué (${response.status} ${response.statusText})`);
  }
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
    const [tagsRes, runningModels] = await Promise.all([
      ollama('/api/tags'),
      getRunningModels(),
    ]);
    if (!tagsRes.ok) return err(res, 502, tagsRes.statusText);

    const data = await tagsRes.json();
    const runningNames = new Set(runningModels.map((model) => model.name));
    const visibleModels = await filterVisibleModels(data.models || []);
    const files = visibleModels
      .filter((model) => !runningNames.has(model.name))
      .map((m) => ({
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
    const resolved = await getResolvedActiveModel();
    res.json({ active_model: resolved });
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
    const visibleModels = await filterVisibleModels(tags.models || []);
    res.json({
      total_models: visibleModels.length,
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
            clearModelInspectionCache();
            return res.json({ filename: name, status: 'ok' });
          }
          if (j.error) return err(res, 500, j.error);
        } catch {
          // skip malformed line
        }
      }
    }
    if (lastStatus === 'success' || buf.includes('"success"')) {
      clearModelInspectionCache();
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
      const inspection = await inspectModel(model);
      return err(res, r.status, describeLoadFailure(model, t, inspection));
    }
    activeModel = model;
    res.json({ model, status: 'loaded' });
  } catch (e) {
    err(res, 502, e.message);
  }
});

// POST /api/models/select  →  mise à jour de l'état in-memory
app.post('/api/models/select', async (req, res) => {
  const model = req.body.model;
  if (!model) return err(res, 400, 'model requis');
  try {
    const runningModels = await getRunningModels();
    if (!runningModels.some((item) => item.name === model)) {
      if (activeModel === model) activeModel = '';
      return err(res, 409, 'Ce modèle n’est pas chargé en mémoire et ne peut pas être activé.');
    }
  } catch (e) {
    return err(res, 502, e.message);
  }
  activeModel = model;
  res.json({ active_model: model });
});

// POST /api/models/unload  →  generate keep_alive=0 pour éjecter de la VRAM
app.post('/api/models/unload', async (req, res) => {
  const model = req.body.model;
  if (!model) return err(res, 400, 'model requis');
  try {
    const response = await ollama('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', keep_alive: 0, stream: false }),
    });
    if (!response.ok) {
      const t = await response.text();
      return err(res, response.status, t);
    }
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
    clearModelInspectionCache();
    if (activeModel === filename) activeModel = '';
    res.json({ filename, status: 'deleted' });
  } catch (e) {
    err(res, 502, e.message);
  }
});

// POST /api/models/import-hf  →  ollama create avec Modelfile FROM <url_gguf>
// Télécharge le GGUF, le pousse vers /api/blobs, puis crée le modèle via files.
app.post('/api/models/import-hf', async (req, res) => {
  const { url, name } = req.body;
  if (!url) return err(res, 400, 'url requis');
  if (!name) return err(res, 400, 'name requis');

  const cleanUrl = url.trim();
  const modelName = normalizeModelName(name);
  const fileName = filenameFromUrl(cleanUrl);

  if (!modelName) {
    return err(res, 400, 'nom de modèle invalide');
  }

  if (!/\.gguf(?:\?.*)?$/i.test(cleanUrl)) {
    return err(res, 400, 'URL HuggingFace GGUF invalide');
  }

  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'lia-hf-'));
  const tempFile = path.join(tempDir, fileName || 'model.gguf');

  try {
    const digest = await downloadFileWithDigest(cleanUrl, tempFile);
    await uploadBlobToOllama(digest, tempFile);

    const r = await ollama('/api/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: modelName,
        files: {
          [fileName || 'model.gguf']: digest,
        },
        stream: true,
      }),
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
          if (j.status === 'success') {
            clearModelInspectionCache();
            return res.json({ filename: modelName, status: 'ok' });
          }
          if (j.error) return err(res, 500, j.error);
        } catch { /* skip malformed line */ }
      }
    }
    res.json({ filename: modelName, status: lastStatus || 'ok' });
  } catch (e) {
    err(res, 502, e.message);
  } finally {
    fs.promises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

// POST /api/cache/drop  →  vide le page cache Linux (drop_caches)
// Nécessite que le container soit lancé avec --privileged ET tourne en root (USER root)
app.post('/api/cache/drop', (req, res) => {
  exec('sync && echo 3 | tee /proc/sys/vm/drop_caches > /dev/null', { shell: '/bin/sh' }, (error) => {
    if (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
    res.json({ ok: true });
  });
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
