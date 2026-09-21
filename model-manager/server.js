'use strict';

const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const Agent = require('agentkeepalive');

const httpAgent = new Agent({
  maxSockets: 32,
  maxFreeSockets: 8,
  timeout: 120000,
  freeSocketTimeout: 30000,
});

const httpsAgent = new Agent.HttpsAgent({
  maxSockets: 32,
  maxFreeSockets: 8,
  timeout: 120000,
  freeSocketTimeout: 30000,
});

// P-UX (SSE) : agent dédié au proxy d'inférence.
// ATTENTION : `fetch` (undici) N'ACCEPTE PAS un agent http/agentkeepalive dans
// `dispatcher` → « fetch failed / agent.dispatch is not a function » instantané.
// Le proxy d'inférence utilise donc http.request natif (voir proxyToRuntime)
// avec cet agent keep-alive, qui autorise les générations longues (timeout 0).
const PROXY_STREAM_AGENT = new Agent({
  keepAlive: true,
  maxSockets: 16,
  maxFreeSockets: 8,
  timeout: 0,
  freeSocketTimeout: 60000,
});

// Circuit Breaker état global
// P-UX (feedback de progression) : tracking en mémoire des jobs de chargement.
// /api/models/load et /api/models/select y enregistrent un job ; l'UI interroge
// GET /api/models/load-progress?model=... toutes les 1,5 s pendant l'action.
// IMPORTANT : la progression est calculée en lisant host-runtime-state.json
// DIRECTEMENT sur disque (le controller est mono-thread et son /status est
// bloqué pendant un /start → impossible de le sonder). Quand l'entrée du
// modèle apparaît avec un pid, le spawn a eu lieu ; quand le port llama
// répond en HTTP, les poids sont chargés.
const LOAD_JOBS = new Map(); // model -> { stage, started_at, error, detail }

const LOAD_STAGE_LABELS = {
  parsing: 'Analyse du GGUF (métadonnées, vocabulaire, contexte natif)...',
  spawning: 'Démarrage du serveur llama (allocation VRAM, layers GPU)...',
  warmup: 'Chargement des poids en mémoire (peut prendre 30-60 s sur un gros modèle)...',
  ready: 'Modèle prêt.',
  failed: 'Échec du chargement.',
};

const DOWNLOAD_JOBS = new Map(); // model -> { total_bytes, received_bytes, percent, error, done, updated_at }

function startDownloadJob(modelName, totalBytes) {
  if (!modelName) return;
  DOWNLOAD_JOBS.set(String(modelName), {
    model: String(modelName),
    total_bytes: totalBytes || null,
    received_bytes: 0,
    percent: 0,
    error: null,
    done: false,
    updated_at: new Date().toISOString(),
  });
}

function advanceDownloadJob(modelName, receivedBytes) {
  const job = DOWNLOAD_JOBS.get(String(modelName));
  if (!job) return;
  job.received_bytes = receivedBytes;
  job.percent = job.total_bytes > 0 ? Math.round((received_bytes / job.total_bytes) * 100) : 0;
  job.updated_at = new Date().toISOString();
}

function finishDownloadJob(modelName, error) {
  const key = String(modelName || '');
  const job = DOWNLOAD_JOBS.get(key);
  if (!job) return;
  job.done = true;
  if (error) {
    job.error = String(error);
    setTimeout(() => DOWNLOAD_JOBS.delete(key), 30000);
  } else {
    job.percent = 100;
    setTimeout(() => DOWNLOAD_JOBS.delete(key), 10000);
  }
}

async function readDownloadProgress(modelName) {
  const requestedKey = String(modelName || '').trim();
  let job = requestedKey ? DOWNLOAD_JOBS.get(requestedKey) : null;
  let key = requestedKey;

  if (!job && DOWNLOAD_JOBS.size > 0) {
    let newestKey = null;
    let newestTime = -1;
    for (const [candidateKey, candidate] of DOWNLOAD_JOBS.entries()) {
      const updatedAt = Date.parse(candidate?.updated_at) || 0;
      const matches = requestedKey
        && (candidateKey.toLowerCase().includes(requestedKey.toLowerCase())
          || requestedKey.toLowerCase().includes(candidateKey.toLowerCase()));
      if (matches) { newestKey = candidateKey; newestTime = updatedAt; break; }
      if (updatedAt >= newestTime) { newestTime = updatedAt; newestKey = candidateKey; }
    }
    if (newestKey) {
      job = DOWNLOAD_JOBS.get(newestKey);
      key = String(job?.model || newestKey);
    }
  }

  if (!job) {
    return { active: false, model: null, percent: 0, total_bytes: null, received_bytes: 0, error: null };
  }

  return {
    active: true,
    model: job.model,
    percent: job.percent,
    total_bytes: job.total_bytes,
    received_bytes: job.received_bytes,
    error: job.error || null,
    done: job.done,
  };
}

function createProgressTracker(modelName) {
  return new Transform({
    transform(chunk, encoding, callback) {
      const job = DOWNLOAD_JOBS.get(String(modelName));
      if (job) {
        advanceDownloadJob(modelName, job.received_bytes + chunk.length);
      }
      callback(null, chunk);
    },
  });
}

async function checkDiskSpace(dirPath, requiredBytes) {
  if (!requiredBytes || requiredBytes <= 0) return true;
  try {
    const dfOutput = await execFileAsync('df', ['-B1', dirPath], { encoding: 'utf8' });
    const lines = dfOutput.stdout.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const availableBytes = parseInt(parts[3], 10);
      if (!Number.isFinite(availableBytes)) return true;
      return availableBytes >= requiredBytes * 1.1;
    }
  } catch {
    // Si on ne peut pas vérifier, on laisse passer et le système d'exploitation gérera l'erreur.
  }
  return true;
}

function startLoadJob(modelName) {
  if (!modelName) return;
  LOAD_JOBS.set(String(modelName), {
    model: String(modelName),
    stage: 'parsing',
    started_at: new Date().toISOString(),
    error: null,
  });
}

function advanceLoadJob(modelName, stage, detail = null) {
  const job = LOAD_JOBS.get(String(modelName));
  if (job && LOAD_STAGE_LABELS[stage]) {
    job.stage = stage;
    if (detail) job.detail = detail;
  }
}

function finishLoadJob(modelName, error = null) {
  const key = String(modelName || '');
  const job = LOAD_JOBS.get(key);
  if (!job) return;
  if (error) {
    job.stage = 'failed';
    job.error = String(error);
    // Laisse l'erreur visible 15 s pour que le polling UI la voie.
    setTimeout(() => LOAD_JOBS.delete(key), 15000);
  } else {
    // On garde le job en "ready" 5 s pour que le polling UI voie le succès.
    job.stage = 'ready';
    setTimeout(() => LOAD_JOBS.delete(key), 5000);
  }
}

async function readLoadProgress(modelName) {
  const requestedKey = String(modelName || '').trim();
  let job = requestedKey ? LOAD_JOBS.get(requestedKey) : null;
  let key = requestedKey;

  // L'UI peut interroger sans nom de modèle (ou avec un nom approchant) :
  // on retombe sur le job le plus récent pour ne jamais afficher « rien ne se
  // passe » pendant un chargement de plusieurs dizaines de secondes.
  if (!job && LOAD_JOBS.size > 0) {
    let newestKey = null;
    let newestTime = -1;
    for (const [candidateKey, candidate] of LOAD_JOBS.entries()) {
      const startedAt = Date.parse(candidate?.started_at) || 0;
      const matches = requestedKey
        && (candidateKey.toLowerCase().includes(requestedKey.toLowerCase())
          || requestedKey.toLowerCase().includes(candidateKey.toLowerCase()));
      if (matches) { newestKey = candidateKey; newestTime = startedAt; break; }
      if (startedAt >= newestTime) { newestTime = startedAt; newestKey = candidateKey; }
    }
    if (newestKey) {
      job = LOAD_JOBS.get(newestKey);
      key = String(job?.model || newestKey);
    }
  }

  if (!job) {
    return { active: false, stage: null, elapsed_seconds: 0, message: null };
  }

  const startedAt = Date.parse(job.started_at);
  const elapsed = Number.isFinite(startedAt) ? Math.round((Date.now() - startedAt) / 1000) : 0;
  let stage = job.stage;
  let server_port = null;
  let server_pid = null;

  // Étape "spawning" : dès que le state disque contient le modèle avec un
  // pid, le processus llama-server a été lancé → poids en cours de chargement.
  if (stage === 'parsing' || stage === 'spawning') {
    try {
      const raw = await fs.promises.readFile(RUNTIME_STATE_PATH, 'utf8');
      const parsed = parseJsonFileContent(raw);
      const instances = Array.isArray(parsed) ? (parsed[0]?.instances || []) : (parsed.instances || []);
      const needle = key.toLowerCase();
      const found = instances.find((i) => {
        const f = String(i.filename || '').toLowerCase();
        const m = String(i.model || '').toLowerCase();
        return f === `${needle}.gguf` || f === needle || m === needle;
      });
      if (found && found.pid && found.port) {
        server_pid = found.pid;
        server_port = found.port;
        if (stage === 'parsing') stage = 'warmup';
        else stage = 'warmup';
      } else if (stage === 'parsing' && elapsed > 3) {
        // Parsing GGUF > 3 s : on bascule visuellement vers le spawn.
        stage = 'spawning';
      }
    } catch { /* state non lisible : garder l'étape estimée */ }
  }

  // Étape "ready" : le port llama-server répond en HTTP → modèle utilisable.
  if (stage === 'warmup' && server_port) {
    try {
      const probeController = new AbortController();
      const probeTimeout = setTimeout(() => probeController.abort(), 1500);
      const probe = await fetch(`http://host.docker.internal:${server_port}/v1/models`, {
        signal: probeController.signal,
      });
      clearTimeout(probeTimeout);
      if (probe.ok) { stage = 'ready'; }
    } catch { /* pas prêt encore */ }
  }

  return {
    active: true,
    model: key,
    stage,
    elapsed_seconds: elapsed,
    message: LOAD_STAGE_LABELS[stage] || stage,
    server_port,
    server_pid,
    error: job.error || null,
  };
}
const CIRCUIT_BREAKER = {
  open: false,
  failures: 0,
  lastFailure: 0,
  resetTimeout: 5000,
  maxFailures: 40
};

// Endpoints NON idempotents : un retry déclencherait un second choc complet
// (rechargement du modèle GGUF, arrêt d'instance). On ne retente JAMAIS.
const NON_IDEMPOTENT_ENDPOINTS = new Set(['/start', '/stop', '/restart', '/open-folder']);

// Cache global pour /status
let STATUS_CACHE = null;
let STATUS_CACHE_TTL = 0;
let STATUS_INFLIGHT = null;
let STATUS_INFLIGHT_ID = 0;
const STATUS_CACHE_MAX_AGE = 2000;

const LOG_HISTORY = [];
const LOG_HISTORY_MAX = 240;
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const CONTAINER_LOG_NODES = (process.env.CONTAINER_LOG_NAMES || 'anythingllm,openwebui,open-webui,librechat,model-loader')
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const CONTAINER_LOG_PATTERNS = CONTAINER_LOG_NODES.map((item) => item.replace(/[-_.]/g, '').toLowerCase());

function normalizeLogLevel(level) {
  const normalized = String(level || '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'critique') return 'critical';
  if (normalized === 'error' || normalized === 'erreur') return 'error';
  if (normalized === 'warn' || normalized === 'warning') return 'critical';
  return 'info';
}

function determineLogLevel(type, message, overrideLevel = null) {
  if (overrideLevel) {
    return normalizeLogLevel(overrideLevel);
  }

  const normalizedType = String(type || '').trim().toLowerCase();
  const lowerMessage = String(message || '').toLowerCase();

  if (normalizedType === 'critical' || normalizedType === 'critique') return 'critical';
  if (normalizedType === 'error' || normalizedType === 'stderr') return 'error';
  if (normalizedType === 'warn' || normalizedType === 'warning') return 'critical';

  if (/(critical|critique)/.test(lowerMessage)) return 'critical';
  if (/(error|erreur|failed|fail|panic)/.test(lowerMessage)) return 'error';

  return 'info';
}

function pushLogEntry(origin, source, type, message, level = null) {
  const normalizedType = String(type || '').toLowerCase();
  const severity = determineLogLevel(normalizedType, message, level);
  const entry = {
    origin,
    source,
    type: normalizedType,
    level: severity,
    message: String(message || ''),
    timestamp: new Date().toISOString(),
  };
  LOG_HISTORY.unshift(entry);
  if (LOG_HISTORY.length > LOG_HISTORY_MAX) {
    LOG_HISTORY.length = LOG_HISTORY_MAX;
  }
}

function getRecentLogEntries() {
  return LOG_HISTORY.slice(0, LOG_HISTORY_MAX);
}

function invalidateStatusCache() {
  STATUS_CACHE = null;
  STATUS_CACHE_TTL = 0;
  STATUS_INFLIGHT = null;
  STATUS_INFLIGHT_ID += 1;
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

function logRequest(method, path, payload) {
  console.log('[model-manager] incoming', method, path, payload || 'no payload');
  pushLogEntry('server', path || 'server', 'info', `${method} ${path} ${payload ? JSON.stringify(payload) : ''}`, 'info');
}

function logError(path, error) {
  console.error('[model-manager] error', path, error?.stack || error);
  pushLogEntry('server', path || 'server', 'error', error?.stack || error || 'Unknown error', 'error');
}

app.use((req, res, next) => {
  logRequest(req.method, req.originalUrl, req.body);
  next();
});

const CONTROLLER_URL = (process.env.LLAMA_HOST_CONTROL_URL || 'http://host.docker.internal:13579').replace(/\/$/, '');
const CONTROLLER_HOST_LAUNCHER_URL = (process.env.CONTROLLER_HOST_LAUNCHER_URL || 'http://host.docker.internal:13580').replace(/\/$/, '');
const LLAMA_SERVER_BASE_URL = (process.env.LLAMA_SERVER_BASE_URL || 'http://host.docker.internal:12434').replace(/\/$/, '');
const MODEL_STORAGE_DIR = process.env.MODEL_STORAGE_DIR || path.join(__dirname, 'models');
// Chemin des modèles côté hôte Windows (informé par l'installateur / lia.ps1).
// Affiché dans la section Modèles de l'UI pour ouvrir le dossier de stockage.
const MODEL_HOST_DIR = process.env.HOST_MODELS_DIR || '';
const RUNTIME_STATE_PATH = process.env.RUNTIME_STATE_PATH || '/runtime/host-runtime-state.json';
const RUNTIME_HARDWARE_PROFILE_PATH = process.env.RUNTIME_HARDWARE_PROFILE_PATH || path.join(path.dirname(RUNTIME_STATE_PATH), 'hardware-profile.json');
const EMBEDDING_MODEL_STATE_PATH = process.env.EMBEDDING_MODEL_STATE_PATH || path.join(MODEL_STORAGE_DIR, '.lia', 'embedding-model.json');
const PORT = Number(process.env.MODEL_MANAGER_PORT || 3005);
const PROXY_MODEL_ID = process.env.PROXY_MODEL_ID || 'lia-local';
const ROOCODE_SOURCE_HEADER_NAME = String(process.env.ROOCODE_SOURCE_HEADER_NAME || 'x-roocode-source').trim().toLowerCase();
const ROOCODE_SOURCE_HEADER_VALUE = String(process.env.ROOCODE_SOURCE_HEADER_VALUE || 'true').trim().toLowerCase();
const DOCKER_INTERNAL = String(process.env.DOCKER_INTERNAL || 'false').toLowerCase() === 'true';
const METRICS_HOST_URL = process.env.METRICS_HOST_URL || (DOCKER_INTERNAL ? 'http://host.docker.internal:13610' : 'http://127.0.0.1:13610');
const CONTROLLER_START_TIMEOUT_MS = Number(process.env.CONTROLLER_START_TIMEOUT_MS || '300000');
const OLLAMA_REGISTRY_BASE_URL = 'https://registry.ollama.ai';
const GGUF_METADATA_CACHE = new Map();

const GGUF_VALUE_TYPE_NAMES = {
  0: 'u8',
  1: 'i8',
  2: 'u16',
  3: 'i16',
  4: 'u32',
  5: 'i32',
  6: 'f32',
  7: 'bool',
  8: 'str',
  9: 'arr',
  10: 'u64',
  11: 'i64',
  12: 'f64',
};

const GGML_TENSOR_TYPE_NAMES = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  6: 'Q5_0',
  7: 'Q5_1',
  8: 'Q8_0',
  9: 'Q8_1',
  10: 'Q2_K',
  11: 'Q3_K',
  12: 'Q4_K',
  13: 'Q5_K',
  14: 'Q6_K',
  15: 'Q8_K',
  16: 'IQ2_XXS',
  17: 'IQ2_XS',
  18: 'IQ3_XXS',
  19: 'IQ1_S',
  20: 'IQ4_NL',
  21: 'IQ3_S',
  22: 'IQ2_S',
  23: 'IQ4_XS',
  24: 'I8',
  25: 'I16',
  26: 'I32',
  27: 'I64',
  28: 'F64',
  29: 'IQ1_M',
  30: 'BF16',
  34: 'TQ1_0',
   35: 'TQ2_0',
};

const EMBEDDING_MODEL_CANDIDATES = [
  'nomic-embed-text',
  'Qwen3-Embedding-4B',
  'all-minilm',
  'embed',
];

const LLAMA_FILE_TYPE_NAMES = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  6: 'Q5_0',
  7: 'Q5_1',
  8: 'Q8_0',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'IQ3_XXS',
  22: 'IQ1_S',
  23: 'IQ4_NL',
  24: 'IQ3_S',
  25: 'IQ2_S',
  26: 'IQ4_XS',
  27: 'I8',
  28: 'I16',
  29: 'I32',
  30: 'BF16',
  34: 'TQ1_0',
  35: 'TQ2_0',
};

class BufferedFileReader {
  constructor(fileHandle, bufferSize = 64 * 1024) {
    this.fileHandle = fileHandle;
    this.buffer = Buffer.allocUnsafe(bufferSize);
    this.bufferPos = 0;
    this.bufferLength = 0;
    this.offset = 0;
  }

  get unread() {
    return this.bufferLength - this.bufferPos;
  }

  async ensure(length) {
    if (length <= this.unread) {
      return;
    }

    if (length > this.buffer.length) {
      throw new Error(`Lecture trop grande pour le buffer interne: ${length}`);
    }

    if (this.unread > 0 && this.bufferPos > 0) {
      this.buffer.copy(this.buffer, 0, this.bufferPos, this.bufferLength);
    }

    this.bufferLength = this.unread;
    this.bufferPos = 0;

    while (this.unread < length) {
      const { bytesRead } = await this.fileHandle.read(
        this.buffer,
        this.bufferLength,
        this.buffer.length - this.bufferLength,
        this.offset,
      );

      if (!bytesRead) {
        throw new Error('Fin de fichier GGUF inattendue');
      }

      this.offset += bytesRead;
      this.bufferLength += bytesRead;
    }
  }

  consume(length) {
    const slice = this.buffer.subarray(this.bufferPos, this.bufferPos + length);
    this.bufferPos += length;
    return slice;
  }

  async readBuffer(length) {
    if (length <= this.buffer.length) {
      await this.ensure(length);
      return Buffer.from(this.consume(length));
    }

    const output = Buffer.allocUnsafe(length);
    let written = 0;

    if (this.unread > 0) {
      const prefix = this.consume(this.unread);
      prefix.copy(output, 0);
      written = prefix.length;
    }

    this.bufferPos = 0;
    this.bufferLength = 0;

    while (written < length) {
      const { bytesRead } = await this.fileHandle.read(output, written, length - written, this.offset);
      if (!bytesRead) {
        throw new Error('Fin de fichier GGUF inattendue');
      }

      this.offset += bytesRead;
      written += bytesRead;
    }

    return output;
  }

  async skip(length) {
    if (length <= this.unread) {
      this.bufferPos += length;
      return;
    }

    const remaining = length - this.unread;
    this.bufferPos = 0;
    this.bufferLength = 0;
    this.offset += remaining;
  }

  async readUInt8() {
    await this.ensure(1);
    return this.consume(1).readUInt8(0);
  }

  async readInt8() {
    await this.ensure(1);
    return this.consume(1).readInt8(0);
  }

  async readUInt16() {
    await this.ensure(2);
    return this.consume(2).readUInt16LE(0);
  }

  async readInt16() {
    await this.ensure(2);
    return this.consume(2).readInt16LE(0);
  }

  async readUInt32() {
    await this.ensure(4);
    return this.consume(4).readUInt32LE(0);
  }

  async readInt32() {
    await this.ensure(4);
    return this.consume(4).readInt32LE(0);
  }

  async readFloat32() {
    await this.ensure(4);
    return this.consume(4).readFloatLE(0);
  }

  async readBigUInt64() {
    await this.ensure(8);
    return this.consume(8).readBigUInt64LE(0);
  }

  async readBigInt64() {
    await this.ensure(8);
    return this.consume(8).readBigInt64LE(0);
  }

  async readFloat64() {
    await this.ensure(8);
    return this.consume(8).readDoubleLE(0);
  }

  async readString() {
    const length = Number(await this.readBigUInt64());
    if (!length) {
      return '';
    }
    const buffer = await this.readBuffer(length);
    return buffer.toString('utf8');
  }
}

function normalizeLargeNumber(value) {
  if (typeof value !== 'bigint') {
    return value;
  }

  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString();
}

function formatPreviewItem(value) {
  if (typeof value === 'string') {
    return value.length > 120 ? `${value.slice(0, 117)}...` : value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : Number(value.toPrecision(8));
  }

  return value;
}

function formatMetadataDisplayValue(key, value) {
  if (key === 'general.file_type' && Number.isInteger(value) && LLAMA_FILE_TYPE_NAMES[value]) {
    return LLAMA_FILE_TYPE_NAMES[value];
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => String(formatPreviewItem(item))).join(', ')}]`;
  }

  if (typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value)) {
    return String(Number(value.toPrecision(10)));
  }

  return typeof value === 'boolean' ? String(value) : String(value ?? '');
}

async function readGgufScalarValue(reader, valueType) {
  switch (valueType) {
    case 0: return reader.readUInt8();
    case 1: return reader.readInt8();
    case 2: return reader.readUInt16();
    case 3: return reader.readInt16();
    case 4: return reader.readUInt32();
    case 5: return reader.readInt32();
    case 6: return reader.readFloat32();
    case 7: return Boolean(await reader.readUInt8());
    case 8: return reader.readString();
    case 10: return normalizeLargeNumber(await reader.readBigUInt64());
    case 11: return normalizeLargeNumber(await reader.readBigInt64());
    case 12: return reader.readFloat64();
    default:
      throw new Error(`Type GGUF non supporté: ${valueType}`);
  }
}

async function readGgufValue(reader, valueType, options = {}) {
  const { arrayPreviewLimit = 8 } = options;

  if (valueType !== 9) {
    const value = await readGgufScalarValue(reader, valueType);
    return {
      kind: 'scalar',
      value,
      displayValue: value,
      typeName: GGUF_VALUE_TYPE_NAMES[valueType] || `type_${valueType}`,
    };
  }

  const itemType = await reader.readUInt32();
  const itemCount = normalizeLargeNumber(await reader.readBigUInt64());
  const totalCount = typeof itemCount === 'number' ? itemCount : Number(itemCount);
  const preview = [];
  const limit = Number.isFinite(totalCount) ? Math.min(totalCount, arrayPreviewLimit) : arrayPreviewLimit;

  if (itemType === 8) {
    for (let index = 0; index < totalCount; index += 1) {
      const entryLength = Number(await reader.readBigUInt64());
      if (index < limit) {
        const entryBuffer = await reader.readBuffer(entryLength);
        preview.push(entryBuffer.toString('utf8'));
      } else {
        await reader.skip(entryLength);
      }
    }
  } else {
    for (let index = 0; index < totalCount; index += 1) {
      const entryValue = await readGgufScalarValue(reader, itemType);
      if (index < limit) {
        preview.push(entryValue);
      }
    }
  }

  const truncated = totalCount > limit;
  const displayItems = truncated ? [...preview, '...'] : preview;
  return {
    kind: 'array',
    value: preview,
    displayValue: displayItems,
    typeName: `arr[${GGUF_VALUE_TYPE_NAMES[itemType] || `type_${itemType}`},${itemCount}]`,
    itemTypeName: GGUF_VALUE_TYPE_NAMES[itemType] || `type_${itemType}`,
    itemCount,
    truncated,
  };
}

function extractContextLength(architecture, metadataMap) {
  if (architecture && Number.isInteger(metadataMap[`${architecture}.context_length`])) {
    return metadataMap[`${architecture}.context_length`];
  }

  const fallbackKey = Object.keys(metadataMap)
    .find((key) => /\.context_length$/u.test(key) && !/original_context_length$/u.test(key) && Number.isInteger(metadataMap[key]));

  return fallbackKey ? metadataMap[fallbackKey] : null;
}

function extractGpuLayers(metadataMap) {
  const fallbackKey = Object.keys(metadataMap)
    .find((key) => /gpu_layers$/u.test(key) || /default_gpu_layers$/u.test(key));

  if (!fallbackKey) return null;
  const value = metadataMap[fallbackKey];
  if (Number.isInteger(value)) return value;
  const number = Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

async function parseGgufFile(filePath) {
  const fileHandle = await fs.promises.open(filePath, 'r');
  const reader = new BufferedFileReader(fileHandle);

  try {
    const magic = (await reader.readBuffer(4)).toString('ascii');
    if (magic !== 'GGUF') {
      throw new Error(`Le fichier n'est pas un GGUF valide: ${filePath}`);
    }

    const version = await reader.readUInt32();
    const tensorCount = normalizeLargeNumber(await reader.readBigUInt64());
    const kvCount = normalizeLargeNumber(await reader.readBigUInt64());
    const metadata = [];
    const metadataMap = {};
    const totalKvCount = typeof kvCount === 'number' ? kvCount : Number(kvCount);

    for (let index = 0; index < totalKvCount; index += 1) {
      const key = await reader.readString();
      const valueType = await reader.readUInt32();
      const parsedValue = await readGgufValue(reader, valueType);
      const value = parsedValue.kind === 'array'
        ? parsedValue.displayValue.map((item) => formatPreviewItem(item))
        : parsedValue.value;

      const displayValue = Array.isArray(value)
        ? `[${value.map((item) => String(item)).join(', ')}]`
        : formatMetadataDisplayValue(key, value);

      metadata.push({
        key,
        type: parsedValue.typeName,
        item_type: parsedValue.itemTypeName || null,
        item_count: parsedValue.itemCount ?? null,
        truncated: Boolean(parsedValue.truncated),
        value_display: displayValue,
      });

      if (parsedValue.kind === 'scalar') {
        metadataMap[key] = parsedValue.value;
      } else {
        metadataMap[key] = parsedValue.itemCount;
      }
    }

    const tensors = [];
    const totalTensorCount = typeof tensorCount === 'number' ? tensorCount : Number(tensorCount);
    for (let index = 0; index < totalTensorCount; index += 1) {
      const name = await reader.readString();
      const dimensionCount = await reader.readUInt32();
      const dimensions = [];
      for (let dimIndex = 0; dimIndex < dimensionCount; dimIndex += 1) {
        dimensions.push(normalizeLargeNumber(await reader.readBigUInt64()));
      }

      const tensorTypeId = await reader.readUInt32();
      const offset = normalizeLargeNumber(await reader.readBigUInt64());
      tensors.push({
        name,
        dimensions,
        type: GGML_TENSOR_TYPE_NAMES[tensorTypeId] || `TYPE_${tensorTypeId}`,
        offset,
      });
    }

    const architecture = typeof metadataMap['general.architecture'] === 'string' ? metadataMap['general.architecture'] : '';
    const contextLength = extractContextLength(architecture, metadataMap);
    const gpuLayers = extractGpuLayers(metadataMap);
    return {
      version,
      tensor_count: tensorCount,
      kv_count: kvCount,
      architecture,
      context_length: contextLength,
      gpu_layers: gpuLayers,
      metadata,
      tensors,
    };
  } finally {
    await fileHandle.close();
  }
}

async function getModelGgufDetails(model) {
  const stat = await fs.promises.stat(model.path);
  const cacheKey = `${model.path}:${stat.size}:${stat.mtimeMs}`;

  if (GGUF_METADATA_CACHE.has(cacheKey)) {
    return GGUF_METADATA_CACHE.get(cacheKey);
  }

  const details = await parseGgufFile(model.path);
  GGUF_METADATA_CACHE.set(cacheKey, details);
  return details;
}

function normalizeRequestedContext(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return null;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return null;
  }

  const rounded = Math.floor(value);
  return rounded > 0 ? rounded : null;
}

async function buildModelStartRequest(identifier, requestedContext = null, requestedGpuLayers = null) {
  const model = await resolveModel(identifier);
  const details = await getModelGgufDetails(model);
  const profile = await readHardwareProfile();
  const recommended = getRecommendedRuntimeDefaults(profile);
  const runtimeState = await readRuntimeStateFallback();
  
  const payload = {
    model: model.name,
  };

  // ✅ 1. PRIORITE ABSOLUE: Valeur explicitement demandée par l'utilisateur (UI) - JAMAIS bridée
  const normalizedContext = normalizeRequestedContext(requestedContext);
  if (normalizedContext !== null) {
    payload.context = normalizedContext;
  } 
  // ✅ 2. Deuxième priorité: Valeur déjà sauvegardée dans le runtime state pour ce modèle
  else if (runtimeState && Array.isArray(runtimeState.instances)) {
    const existingInstance = runtimeState.instances.find(
      i => i.filename === model.filename && Number.isInteger(i.context) && i.context > 0
    );
    if (existingInstance) {
      payload.context = existingInstance.context;
    }
  }
  // ✅ 3. Seulement si aucune valeur personnalisée: utiliser native modèle + hardware limite
  else if (Number.isInteger(details.context_length) && details.context_length > 0) {
    payload.context = Math.min(details.context_length, recommended.context);
  } 
  // ✅ 4. Fallback final: hardware default
  else {
    payload.context = recommended.context;
  }

  const normalizedGpuLayers = normalizeRequestedGpuLayers(requestedGpuLayers);
  if (normalizedGpuLayers !== null) {
    payload.gpu_layers = normalizedGpuLayers;
  } else if (recommended?.gpu_layers !== undefined && recommended?.gpu_layers !== null) {
    payload.gpu_layers = recommended.gpu_layers;
  } else if (Number.isInteger(details.gpu_layers) && details.gpu_layers >= 0) {
    payload.gpu_layers = details.gpu_layers;
  }

  return {
    model,
    details,
    payload,
  };
}

function normalizeRequestedGpuLayers(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return null;
  }

  const value = Number(rawValue);
  if (!Number.isFinite(value)) {
    return null;
  }

  const rounded = Math.floor(value);
  return rounded >= 0 ? rounded : null;
}

app.use(express.static(path.join(__dirname, 'dist')));

function err(res, status, message) {
  logError(res.req?.originalUrl || 'unknown', message);
  return res.status(status).json({ detail: message });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeControllerError(error) {
  const message = String(error?.message || error);
  const cause = error?.cause;
  if (!cause) {
    return message;
  }

  // undici n'expose le motif réseau réel (ECONNREFUSED / ECONNRESET / timeout)
  // que dans error.cause : sans lui, "fetch failed" est indiagnosticable.
  const causeCode = cause.code || cause.errno || '';
  const causeMessage = String(cause.message || cause);
  return causeCode
    ? `${message} (cause: ${causeCode} - ${causeMessage})`
    : `${message} (cause: ${causeMessage})`;
}

function registerControllerFailure(detail) {
  CIRCUIT_BREAKER.failures += 1;
  CIRCUIT_BREAKER.lastFailure = Date.now();
  if (CIRCUIT_BREAKER.failures >= CIRCUIT_BREAKER.maxFailures) {
    CIRCUIT_BREAKER.open = true;
  }
  logError('controller', detail);
  pushLogEntry('controller', 'request', 'error', detail);
}

function isRetryableControllerError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.name === 'AbortError'
    || message.includes('fetch failed')
    || message.includes('socket hang up')
    || message.includes('econnreset')
    || message.includes('econnrefused')
    || message.includes('etimedout')
    || message.includes('this operation was aborted');
}

async function controllerRequest(endpoint, options = {}) {
  logRequest('CONTROLLER', endpoint, options.body ? JSON.parse(options.body) : null);
  // Vérifier état Circuit Breaker
  if (CIRCUIT_BREAKER.open) {
    if (Date.now() - CIRCUIT_BREAKER.lastFailure > CIRCUIT_BREAKER.resetTimeout) {
      // Demi-ouvert: autoriser 1 requête de test
      CIRCUIT_BREAKER.open = false;
    } else {
      throw new Error(`Circuit Breaker ouvert. Prochaine tentative dans ${Math.ceil((CIRCUIT_BREAKER.resetTimeout - (Date.now() - CIRCUIT_BREAKER.lastFailure)) / 1000)}s`);
    }
  }

  const controllerUrl = new URL(`${CONTROLLER_URL}${endpoint}`);
  const agent = controllerUrl.protocol === 'https:' ? httpsAgent : httpAgent;
  const { timeout: requestTimeout, maxRetries: requestMaxRetries, retryBaseDelayMs: requestRetryBaseDelayMs, ...fetchOptions } = options;
  const maxRetries = Number.isFinite(Number(requestMaxRetries))
    ? Number(requestMaxRetries)
    : (NON_IDEMPOTENT_ENDPOINTS.has(endpoint) ? 0 : (endpoint === '/status' ? 1 : 2));
  const retryBaseDelayMs = Number.isFinite(Number(requestRetryBaseDelayMs))
    ? Number(requestRetryBaseDelayMs)
    : 300;
  const effectiveTimeout = Number.isFinite(Number(requestTimeout)) ? Number(requestTimeout) : 15000;

  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    // Compatibilité NodeJS < 18: AbortController manuel
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const response = await fetch(controllerUrl.href, {
        ...fetchOptions,
        agent,
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          ...(options.headers || {}),
        },
      });

      const text = await response.text();
      let payload = null;
      try {
        payload = text ? JSON.parse(text) : null;
      } catch (parseError) {
        // Gérer le cas où le backend .NET retourne un Hashtable non sérialisable
        // Détecter l'erreur spécifique System.Collections.Hashtable
        if (text.includes('System.Collections.Hashtable') && text.includes('Keys must be strings')) {
          payload = {
            detail: 'Erreur de sérialisation coté backend: Le contrôleur .NET a retourné un dictionnaire avec des clés non-string. Ceci est une erreur du runtime hôte.'
          };
        } else {
          payload = text;
        }
      }

      logRequest('CONTROLLER-RAW-RESPONSE', endpoint, { status: response.status, text, payload, attempt: attempt + 1 });

      if (!response.ok) {
        const detail = typeof payload === 'object' && payload?.detail ? payload.detail : payload || response.statusText;
        const retryableHttp = response.status >= 500 && response.status < 600;
        if (retryableHttp && attempt < maxRetries) {
          const waitMs = retryBaseDelayMs * (attempt + 1);
          pushLogEntry('controller', endpoint, 'warn', `Retry ${attempt + 1}/${maxRetries} après HTTP ${response.status}: ${detail}`);
          await delay(waitMs);
          continue;
        }

        const finalDetail = `Controller response ${response.status}: ${detail}`;
        registerControllerFailure(finalDetail);
        throw new Error(String(detail));
      }

      logRequest('CONTROLLER-RESPONSE', endpoint, { status: response.status, payload, attempt: attempt + 1 });
      pushLogEntry('controller', endpoint, 'info', `Controller response ${response.status}`);

      // Réinitialiser Circuit Breaker en cas de succès
      CIRCUIT_BREAKER.failures = 0;
      CIRCUIT_BREAKER.open = false;

      // Invalidate the cached runtime status after state-changing controller calls.
      if (['/start', '/stop', '/restart'].includes(endpoint)) {
        invalidateStatusCache();
      }

      return payload;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && isRetryableControllerError(error)) {
        const waitMs = retryBaseDelayMs * (attempt + 1);
        pushLogEntry('controller', endpoint, 'warn', `Retry ${attempt + 1}/${maxRetries} après erreur réseau: ${error?.message || error}`);
        await delay(waitMs);
        continue;
      }

      const detailedError = `Controller request failed: ${describeControllerError(error)}`;
      if (!(error instanceof Error && /^Controller response \d+:/u.test(error.message))) {
        registerControllerFailure(detailedError);
      }
      throw new Error(detailedError);
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Controller request failed');
}

async function hostLauncherRequest(endpoint, options = {}) {
  const launcherUrl = `${CONTROLLER_HOST_LAUNCHER_URL}${endpoint}`;
  logRequest('LAUNCHER', endpoint, options.body ? JSON.parse(options.body) : null);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  try {
    const response = await fetch(launcherUrl, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : null;
    if (!response.ok) {
      throw new Error(typeof payload === 'object' && payload?.error ? payload.error : payload || response.statusText);
    }
    return payload;
  } catch (error) {
    throw new Error(`Launcher request failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function getRuntimeStatus() {
  const now = Date.now();
  if (STATUS_CACHE && now < STATUS_CACHE_TTL) {
    return STATUS_CACHE;
  }

  if (STATUS_INFLIGHT) {
    return STATUS_INFLIGHT;
  }

  const statusRequestId = ++STATUS_INFLIGHT_ID;
  STATUS_INFLIGHT = (async () => {
    try {
      const status = await controllerRequest('/status', { method: 'GET', timeout: 30000 });
      if (statusRequestId === STATUS_INFLIGHT_ID) {
        STATUS_CACHE = status;
        STATUS_CACHE_TTL = Date.now() + STATUS_CACHE_MAX_AGE;
        STATUS_INFLIGHT = null;
      }
      return status;
    } catch (error) {
      if (STATUS_CACHE) {
        STATUS_CACHE_TTL = Date.now() + 5000;
        console.warn('[model-manager] getRuntimeStatus falling back to stale cache after controller error', error?.message || error);
        return STATUS_CACHE;
      }

      throw error;
    } finally {
      if (statusRequestId === STATUS_INFLIGHT_ID) {
        STATUS_INFLIGHT = null;
      }
    }
  })();

  return STATUS_INFLIGHT;
}

// Les fichiers runtime sont écrits par PowerShell (Set-Content) et peuvent
// contenir un BOM UTF-8 (U+FEFF) : JSON.parse échoue alors sur le premier
// caractère et le profil devient silencieusement null.
function parseJsonFileContent(raw) {
  const text = String(raw || '').replace(/^\uFEFF/, '').trim();
  if (!text) {
    return null;
  }
  return JSON.parse(text);
}

async function readRuntimeStateFallback() {
  try {
    const raw = await fs.promises.readFile(RUNTIME_STATE_PATH, 'utf8');
    const parsed = parseJsonFileContent(raw);
    if (Array.isArray(parsed)) {
      return parsed.length > 0 ? parsed[0] : null;
    }

    return parsed;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Dossier des modèles CÔTÉ HÔTE (Windows)
// Priorité : variable d'env de l'installeur (HOST_MODELS_DIR) → config runtime
// écrite par lia.ps1 (models_dir) → état runtime. Permet d'afficher/ouvrir le
// vrai dossier de stockage même si le conteneur a été démarré manuellement.
// ─────────────────────────────────────────────────────────────────────────────
const RUNTIME_CONFIG_PATH = process.env.RUNTIME_CONFIG_PATH
  || path.join(path.dirname(RUNTIME_STATE_PATH), 'host-runtime-config.json');
let HOST_MODELS_DIR_CACHE = { value: null, expiresAt: 0 };

function normalizeHostDir(value) {
  const candidate = String(value || '').trim();
  if (!candidate) {
    return '';
  }
  // Un chemin relatif n'est pas exploitable côté hôte : on l'ignore.
  return /^[a-zA-Z]:[\\/]/.test(candidate) || candidate.startsWith('\\\\') ? candidate : '';
}

async function resolveHostModelsDir() {
  const fromEnv = normalizeHostDir(MODEL_HOST_DIR);
  if (fromEnv) {
    return fromEnv;
  }

  if (HOST_MODELS_DIR_CACHE.value && Date.now() < HOST_MODELS_DIR_CACHE.expiresAt) {
    return HOST_MODELS_DIR_CACHE.value;
  }

  let resolved = '';
  try {
    const raw = await fs.promises.readFile(RUNTIME_CONFIG_PATH, 'utf8');
    const config = parseJsonFileContent(raw);
    resolved = normalizeHostDir(config?.models_dir);
  } catch {
    resolved = '';
  }

  if (!resolved) {
    const state = await readRuntimeStateFallback();
    resolved = normalizeHostDir(state?.models_dir);
  }

  HOST_MODELS_DIR_CACHE = { value: resolved, expiresAt: Date.now() + 30000 };
  return resolved;
}

async function readHardwareProfile() {
  try {
    const raw = await fs.promises.readFile(RUNTIME_HARDWARE_PROFILE_PATH, 'utf8');
    return parseJsonFileContent(raw);
  } catch {
    return null;
  }
}

function getRecommendedRuntimeDefaults(hardwareProfile) {
  // ✅ PLUS AUCUN BRIDAGE AUTOMATIQUE
  // ✅ La fonction ne retourne PLUS AUCUNE VALEUR PAR DEFAUT DANS LE PAYLOAD /start
  // (la valeur explicite de l'UI reste toujours prioritaire, cf. buildModelStartRequest).
  return {
    backend: 'cpu',
    context: 131072,
    gpu_layers: 999,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// P-UX : recommandation VRAM (SUGGESTION, jamais imposée).
// Sert à pré-remplir le curseur de contexte et l'info-bulle « recommandé » de
// l'UI d'après le profil matériel (ex: Intel Arc 140V, 16 Go partagés) et la
// taille du GGUF. L'utilisateur reste libre de tout modifier.
// ─────────────────────────────────────────────────────────────────────────────
function getVramBudgetBytes(hardwareProfile) {
  const gpu = hardwareProfile?.gpu || {};
  const memory = hardwareProfile?.memory || {};

  // 1. VRAM dédiée déclarée par les adaptateurs (GPU discret).
  let dedicated = 0;
  if (Array.isArray(gpu.devices)) {
    for (const device of gpu.devices) {
      const bytes = Number(device?.adapter_ram_bytes ?? device?.vram_bytes ?? 0);
      if (Number.isFinite(bytes) && bytes > 0) { dedicated += bytes; }
    }
  }
  for (const candidate of [gpu.total_bytes, gpu.vram_total_bytes, gpu.memory_total_bytes]) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value > 0) { dedicated = Math.max(dedicated, value); }
  }

  // 2. GPU intégré (Intel Arc 140V, iGPU AMD…) : la mémoire est PARTAGÉE avec
  //    la RAM système. Le pilote ne déclare qu'une petite réserve dédiée
  //    (ex: 2 Go) alors que 16 Go sont réellement adressables. On se base donc
  //    sur la RAM système, avec une marge conservatrice (50 %, plafonnée à 16 Go).
  const vendor = String(gpu.vendor || hardwareProfile?.vendor || '').toLowerCase();
  const isIntegrated = ['intel', 'amd', 'apple'].some((name) => vendor.includes(name));
  const systemRam = Number(memory.total_bytes) || 0;
  if (isIntegrated && systemRam > 0) {
    const shared = Math.min(Math.floor(systemRam * 0.5), 16 * 1024 ** 3);
    return Math.max(dedicated, shared);
  }

  return dedicated;
}

function computeRecommendedRuntime(hardwareProfile, modelSizeBytes = 0) {
  const vram = getVramBudgetBytes(hardwareProfile);
  // Marge de sécurité : le GPU est partagé avec le système (iGPU) ou le
  // contexte/KV cache consomme de la mémoire.
  const usable = vram > 0 ? Math.floor(vram * 0.75) : 0;
  const size = Number(modelSizeBytes) || 0;

  // Offload complet si les poids tiennent dans le budget utilisable.
  let gpuLayers = 999;
  if (usable > 0 && size > usable) {
    // Proportion des couches qu'on peut placer en VRAM (approximation linéaire).
    gpuLayers = Math.max(0, Math.floor(999 * (usable / size)));
  }

  // Contexte conseillé : proportionnel à la VRAM restante après les poids.
  let context = 32768;
  if (usable > 0) {
    const freeForKv = Math.max(0, usable - size);
    if (freeForKv < 1.5 * 1024 ** 3) {
      context = 8192;
    } else if (freeForKv < 3 * 1024 ** 3) {
      context = 16384;
    }
  }

  return {
    backend: String(hardwareProfile?.gpu?.vendor || hardwareProfile?.backend || 'auto'),
    context,
    gpu_layers: gpuLayers,
    vram_budget_bytes: usable,
    model_size_bytes: size,
    source: vram > 0 ? 'hardware-profile' : 'default',
    note: 'Suggestion informative : jamais imposée, modifiable dans l\'UI.',
  };
}

function normalizeNumber(value) {
  if (value == null) {
    return null;
  }
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function mapHostCpuMetrics(cpuMetrics, hardwareProfile) {
  const hasCpuMetrics = cpuMetrics && typeof cpuMetrics === 'object';
  const model = String(
    (hasCpuMetrics && (cpuMetrics.Name || cpuMetrics.Caption)) ||
    hardwareProfile?.cpu?.model ||
    'CPU'
  );
  const speed_mhz = normalizeNumber(
    (hasCpuMetrics && (cpuMetrics.MaxClockSpeed || cpuMetrics.MaxClockSpeedMHz || cpuMetrics.Speed || cpuMetrics.CurrentFrequency)) ||
    hardwareProfile?.cpu?.max_clock_speed_mhz ||
    0
  );
  const cores = normalizeNumber(
    (hasCpuMetrics && (cpuMetrics.NumberOfCores || cpuMetrics.Cores || cpuMetrics.CoreCount)) ||
    hardwareProfile?.cpu?.physical_cores ||
    0
  );
  const threads = normalizeNumber(
    (hasCpuMetrics && (cpuMetrics.NumberOfLogicalProcessors || cpuMetrics.LogicalProcessors || cpuMetrics.ThreadCount)) ||
    hardwareProfile?.cpu?.logical_processors ||
    0
  );
  const usage = normalizeNumber(
    (hasCpuMetrics && (cpuMetrics.Load || cpuMetrics.CpuLoadPercentage || cpuMetrics.Usage || cpuMetrics.usage_percent)) ||
    null
  );

  return [{
    id: 'cpu-host',
    type: 'cpu',
    model,
    speed_mhz,
    usage_percent: usage,
    cores,
    threads,
    times: hasCpuMetrics ? cpuMetrics.times || null : null,
  }];
}

function mapHostGpuMetrics(gpuMetrics) {
  if (!gpuMetrics) {
    return [];
  }

  const gpus = Array.isArray(gpuMetrics) ? gpuMetrics : [gpuMetrics];
  return gpus.filter(Boolean).map((gpu, index) => {
    const vendor = String(gpu.Adapter || gpu.AdapterCompatibility || gpu.Vendor || gpu.vendor || 'Unknown').trim();
    const model = String(gpu.Description || gpu.Name || gpu.Adapter || gpu.label || gpu.model || 'GPU').trim();
    const usage = normalizeNumber(gpu.Workload || gpu.AdapterWorkloadPercentage || gpu.utilization || gpu.Usage || gpu.usage_percent);
    const totalBytes = normalizeNumber(gpu.MemoryTotal || gpu.AdapterMemoryTotal || gpu.memory_total_bytes || gpu.total_bytes);
    const usedBytes = normalizeNumber(gpu.MemoryUsed || gpu.AdapterMemoryUsage || gpu.memory_used_bytes || gpu.used_bytes);

    return {
      id: `gpu-host-${index}`,
      type: 'gpu',
      vendor: vendor.toUpperCase().includes('INTEL') ? 'Intel' : vendor,
      model,
      usage_percent: usage,
      memory_total_bytes: totalBytes != null ? totalBytes * (totalBytes > 1000000 ? 1 : 1024 * 1024) : null,
      memory_used_bytes: usedBytes != null ? usedBytes * (usedBytes > 1000000 ? 1 : 1024 * 1024) : null,
      driver: String(gpu.DriverVersion || gpu.Driver || gpu.driver_version || '').trim(),
    };
  });
}

function normalizeMemoryBytes(value) {
  const num = normalizeNumber(value);
  if (num == null) {
    return null;
  }

  // If the value is very large, assume bytes already.
  if (num > 1000) {
    return num;
  }

  // Small values are likely GB.
  return Math.round(num * 1024 * 1024 * 1024);
}

function mapHostMemoryMetrics(memoryMetrics) {
  if (!memoryMetrics || typeof memoryMetrics !== 'object') {
    return null;
  }

  const total = normalizeMemoryBytes(memoryMetrics.Total || memoryMetrics.TotalPhysicalMemory || memoryMetrics.total_bytes || memoryMetrics.host_total_bytes);
  const free = normalizeMemoryBytes(memoryMetrics.Free || memoryMetrics.FreePhysicalMemory || memoryMetrics.free_bytes || memoryMetrics.host_free_bytes);
  const used = normalizeMemoryBytes(memoryMetrics.Used || memoryMetrics.UsedPhysicalMemory || memoryMetrics.used_bytes || (total != null && free != null ? total - free : null));

  return {
    total_bytes: total,
    free_bytes: free,
    used_bytes: used,
  };
}

async function fetchHostMetrics() {
  try {
    const response = await fetch(`${METRICS_HOST_URL.replace(/\/$/, '')}/metrics/host`, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Host metrics fetch failed ${response.status}`);
    }
    const body = await response.json();
    return body.metrics || body;
  } catch (error) {
    console.warn('[model-manager] fetchHostMetrics failed', error.message);
    return null;
  }
}

function hasUsefulRuntimeState(runtime) {
  if (!runtime || typeof runtime !== 'object') {
    return false;
  }

  const instances = Array.isArray(runtime.instances)
    ? runtime.instances
    : runtime.instances
      ? [runtime.instances]
      : [];

  return Boolean(runtime.active_model || runtime.active_filename || instances.length > 0);
}

function resolveActiveModel(runtime) {
  const instances = Array.isArray(runtime?.instances)
    ? runtime.instances
    : runtime?.instances
      ? [runtime.instances]
      : [];

  const liveInstances = instances.filter((instance) => isLiveInstance(instance));
  // Les instances d'autres projets (proxy non LIA) ne doivent jamais être
  // présentées comme « le modèle principal » du model-loader LIA-X.
  const liveProjectInstances = liveInstances.filter((instance) => isProjectInstance(instance));

  const declared = String(runtime?.active_model || '');
  if (declared) {
    // Le state hôte peut conserver un active_model orphelin (GGUF supprimé ou
    // processus mort) : on ne le valide que si une instance VIVANTE du projet
    // le porte, ou si /status confirme un PID actif sans liste d'instances
    // (state mono-instance historique). Sinon l'UI annonçait un modèle
    // principal inexistant alors que le dossier de modèles était vide.
    if (liveProjectInstances.some((instance) => instance.model === declared)) {
      return declared;
    }
    if (liveInstances.length === 0 && runtime?.running && runtime?.pid) {
      return declared;
    }
    return '';
  }

  const activeFlaggedInstance = liveProjectInstances.find((instance) => Boolean(instance.active));
  if (activeFlaggedInstance) {
    return activeFlaggedInstance.model;
  }

  if (liveProjectInstances.length === 1) {
    return liveProjectInstances[0].model;
  }

  return '';
}

function isProjectInstance(instance) {
  if (!instance || typeof instance !== 'object') {
    return false;
  }
  if (instance.proxy_id && String(instance.proxy_id).startsWith(`${PROXY_MODEL_ID}-`)) {
    return true;
  }
  if (instance.proxy_model_id && instance.proxy_model_id === PROXY_MODEL_ID) {
    return true;
  }
  return false;
}

function isLiveInstance(instance) {
  if (!instance || typeof instance !== 'object') {
    return false;
  }
  if (!instance.running) {
    return false;
  }
  // pid=null/0/absent => processus hôte disparu : instance fantôme.
  // Number(null)=0, Number('')=0, Number(undefined)=NaN : tout est rejeté.
  const pid = Number(instance.pid);
  return Number.isFinite(pid) && pid > 0;
}

function buildLoadedModelList(runtime) {
  const instances = Array.isArray(runtime?.instances)
    ? runtime.instances
    : runtime?.instances
      ? [runtime.instances]
      : [];
  const activeModel = resolveActiveModel(runtime);

  const loaded = instances
    // Un modèle n'est réellement « chargé » que si une instance tourne ET
    // possède un PID vivant côté hôte. Un state persisté peut conserver
    // running=true avec pid=null (processus disparu, GGUF supprimé) : sans ce
    // filtre l'UI affichait des modèles chargés alors qu'aucun GGUF n'existe.
    .filter((instance) => isProjectInstance(instance) && isLiveInstance(instance))
    .map((instance) => ({
      id: instance.model || instance.proxy_id || `${PROXY_MODEL_ID}-${instance.port}`,
      model: instance.model,
      filename: instance.filename,
      port: instance.port,
      pid: instance.pid ?? null,
      running: Boolean(instance.running),
      size_vram: instance.estimated_vram_bytes ?? null,
      context_length: Number.isFinite(Number(instance.context)) ? Number(instance.context) : null,
      expires_at: instance.started_at || null,
      active: activeModel ? instance.model === activeModel : Boolean(instance.active),
    }))
    .filter((item) => Boolean(item.model));

  // Repli « state legacy » : uniquement si le controller confirme un processus
  // vivant (running + pid). Sans PID, il s'agit d'un fantôme de state persisté
  // et l'UI ne doit surtout pas afficher un modèle principal inexistant.
  const runtimeHasLiveProcess = Boolean(runtime?.running) && runtime?.pid !== null && runtime?.pid !== undefined && runtime?.pid !== '';
  if (loaded.length === 0 && activeModel && runtimeHasLiveProcess) {
    loaded.push({
      id: activeModel,
      model: activeModel,
      filename: runtime?.active_filename || `${activeModel}.gguf`,
      port: runtime?.server_port ?? null,
      running: Boolean(runtime?.running),
      size_vram: null,
      expires_at: runtime?.started_at || null,
      active: true,
    });
  }

  return loaded;
}

function extractLogEntries(runtime) {
  const logs = [];
  if (!runtime || typeof runtime !== 'object') {
    return logs;
  }

  if (typeof runtime.stdout_log === 'string' && runtime.stdout_log.trim()) {
    logs.push({ source: 'runtime.stdout', type: 'stdout', text: runtime.stdout_log.trim() });
  }

  if (typeof runtime.stderr_log === 'string' && runtime.stderr_log.trim()) {
    logs.push({ source: 'runtime.stderr', type: 'stderr', text: runtime.stderr_log.trim() });
  }

  const instances = Array.isArray(runtime?.instances)
    ? runtime.instances
    : runtime?.instances
      ? [runtime.instances]
      : [];

  instances
    .filter((instance) => isProjectInstance(instance))
    .forEach((instance) => {
      const id = instance.proxy_id || instance.id || String(instance.port);
      if (typeof instance.stdout_log === 'string' && instance.stdout_log.trim()) {
        logs.push({ origin: 'container', source: id, type: 'stdout', message: instance.stdout_log.trim() });
      }
      if (typeof instance.stderr_log === 'string' && instance.stderr_log.trim()) {
        logs.push({ origin: 'container', source: id, type: 'stderr', message: instance.stderr_log.trim() });
      }
      if (typeof instance.last_error === 'string' && instance.last_error.trim()) {
        logs.push({ origin: 'container', source: id, type: 'stderr', message: instance.last_error.trim() });
      }
    });

  return logs;
}

async function collectControllerMonitorLogs() {
  const filePath = path.resolve(__dirname, '..', 'logs', 'controller', 'process-monitor.log');
  try {
    const raw = await fs.promises.readFile(filePath, 'utf8');
    const lines = raw.split(/\r?\n/).filter(Boolean);
    const tail = lines.slice(-120);
    return tail.map((line) => {
      const match = /^\[([^\]]+)\]\s*(.*)$/.exec(line);
      let timestamp = null;
      let message = line;
      if (match) {
        const parsed = Date.parse(match[1]);
        if (!Number.isNaN(parsed)) {
          timestamp = new Date(parsed).toISOString();
        }
        message = match[2];
      }

      const severity = determineLogLevel('stdout', message);

      return {
        origin: 'controller',
        source: 'process-monitor',
        type: severity === 'error' || severity === 'critical' ? 'stderr' : 'stdout',
        message,
        timestamp,
        level: severity,
      };
    });
  } catch {
    return [];
  }
}

function parseDockerLogsBuffer(buffer) {
  const entries = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (buffer.length - offset >= 8 && [0, 1, 2].includes(buffer[offset])) {
      const streamType = buffer[offset];
      const payloadSize = buffer.readUInt32BE(offset + 4);
      const chunkStart = offset + 8;
      const chunkEnd = chunkStart + payloadSize;
      if (chunkEnd > buffer.length) {
        break;
      }
      const text = buffer.slice(chunkStart, chunkEnd).toString('utf8');
      entries.push({ streamType, text });
      offset = chunkEnd;
      continue;
    }

    entries.push({ streamType: 1, text: buffer.slice(offset).toString('utf8') });
    break;
  }

  return entries;
}

function dockerSocketAvailable() {
  try {
    const stats = fs.statSync(DOCKER_SOCKET_PATH);
    return stats.isSocket();
  } catch {
    return false;
  }
}

function normalizeContainerIdentifier(name) {
  return String(name || '').replace(/^\//, '');
}

function normalizeContainerMatchName(name) {
  return normalizeContainerIdentifier(name).replace(/[-_.]/g, '').toLowerCase();
}

function isMatchingContainerName(name) {
  const normalized = normalizeContainerMatchName(name);
  return CONTAINER_LOG_PATTERNS.some((pattern) => normalized.includes(pattern));
}

async function fetchDockerSocketJson(path) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath: DOCKER_SOCKET_PATH,
      path,
      method: 'GET',
      headers: { 'Host': 'localhost' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const raw = Buffer.concat(chunks).toString('utf8');
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      });
    });

    request.on('error', reject);
    request.end();
  });
}

async function listDockerContainers() {
  try {
    const containers = await fetchDockerSocketJson('/containers/json?all=0');
    if (!Array.isArray(containers)) {
      return [];
    }
    return containers;
  } catch {
    return [];
  }
}

async function fetchDockerContainerLogs(containerIdentifier, tail = 100, source = null) {
  return new Promise((resolve) => {
    if (!dockerSocketAvailable()) {
      return resolve([]);
    }

    const request = http.request({
      socketPath: DOCKER_SOCKET_PATH,
      path: `/containers/${encodeURIComponent(containerIdentifier)}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=1`,
      method: 'GET',
      headers: { 'Host': 'localhost' },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const raw = Buffer.concat(chunks);
        const entries = parseDockerLogsBuffer(raw);
        const mapped = entries.flatMap((entry) => {
          const lines = entry.text.split(/\r?\n/).filter(Boolean);
          return lines.map((line) => {
            const streamType = entry.streamType === 2 ? 'stderr' : 'stdout';
            return {
              origin: 'container',
              source: source || String(containerIdentifier),
              type: streamType,
              level: determineLogLevel(streamType, line),
              message: line,
            };
          });
        });
        resolve(mapped);
      });
    });

    request.on('error', (err) => {
      resolve([{ origin: 'container', source: source || String(containerIdentifier), type: 'stderr', message: `Erreur Docker logs: ${err.message}` }]);
    });
    request.end();
  });
}

async function collectContainerLogs() {
  if (!dockerSocketAvailable()) {
    return [];
  }

  const containers = await listDockerContainers();
  const matched = containers.filter((container) => {
    const names = Array.isArray(container.Names) ? container.Names : [container.Names];
    return names.some((name) => isMatchingContainerName(name));
  });

  let targets;
  if (matched.length > 0) {
    targets = matched.map((container) => ({
      id: container.Id,
      source: normalizeContainerIdentifier(Array.isArray(container.Names) ? container.Names[0] : container.Names),
    }));
  } else {
    targets = CONTAINER_LOG_NODES.map((name) => ({ id: name, source: name }));
  }

  const results = await Promise.all(targets.map((target) => fetchDockerContainerLogs(target.id, 100, target.source)));
  return results.flat();
}

function computeCpuUsage(currentCpus, previousCpus) {
  if (!Array.isArray(previousCpus) || previousCpus.length !== currentCpus.length) {
    return currentCpus.map(() => ({ usage_percent: null }));
  }

  return currentCpus.map((cpu, index) => {
    const previous = previousCpus[index];
    const currentTimes = cpu.times || {};
    const previousTimes = previous.times || {};
    const currentTotal = Object.values(currentTimes).reduce((sum, value) => sum + (value || 0), 0);
    const previousTotal = Object.values(previousTimes).reduce((sum, value) => sum + (value || 0), 0);
    const totalDelta = currentTotal - previousTotal;
    const idleDelta = (currentTimes.idle || 0) - (previousTimes.idle || 0);
    const usagePercent = totalDelta > 0 ? Math.max(0, Math.min(100, ((totalDelta - idleDelta) / totalDelta) * 100)) : null;
    return { usage_percent: usagePercent };
  });
}

let LAST_CPU_SNAPSHOT = null;

function getCpuSnapshot() {
  const cpus = os.cpus();
  const usage = computeCpuUsage(cpus, LAST_CPU_SNAPSHOT);
  LAST_CPU_SNAPSHOT = cpus;
  return cpus.map((cpu, index) => ({
    id: `cpu-${index}`,
    type: 'cpu',
    model: cpu.model,
    speed_mhz: cpu.speed,
    usage_percent: usage[index]?.usage_percent,
    times: cpu.times,
  }));
}

async function runCommand(command, args = []) {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5000 });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function probeGpuInfo() {
  const gpus = [];
  const nvidiaOutput = await runCommand('nvidia-smi', ['--query-gpu=name,utilization.gpu,memory.total,memory.used,driver_version', '--format=csv,noheader,nounits']);
  if (nvidiaOutput) {
    nvidiaOutput.split(/\r?\n/).forEach((line, index) => {
      const parts = line.split(',').map((part) => part.trim());
      if (parts.length >= 5) {
        gpus.push({
          id: `gpu-${index}`,
          type: 'gpu',
          vendor: 'NVIDIA',
          model: parts[0],
          usage_percent: Number(parts[1]) || 0,
          memory_total_bytes: Number(parts[2]) * 1024 * 1024,
          memory_used_bytes: Number(parts[3]) * 1024 * 1024,
          driver: parts[4],
        });
      }
    });
    return gpus;
  }

  const lspciOutput = await runCommand('lspci', ['-mm']);
  if (lspciOutput) {
    lspciOutput.split(/\r?\n/).forEach((line, index) => {
      const fields = line.split('"').filter((field) => field !== '' && field !== ' ');
      if (fields.length >= 4) {
        const type = fields[1] || '';
        if (/VGA|3D|Display/i.test(type)) {
          gpus.push({
            id: `gpu-${index}`,
            type: 'gpu',
            vendor: fields[2] || 'Unknown',
            model: fields.slice(3).join(' ').trim() || 'Unknown GPU',
            usage_percent: null,
            memory_total_bytes: null,
            memory_used_bytes: null,
            driver: null,
          });
        }
      }
    });
  }

  return gpus;
}

function getRuntimeGpuFallback(runtime) {
  if (!runtime || typeof runtime !== 'object' || !runtime.gpu || typeof runtime.gpu !== 'object') {
    return [];
  }

  const gpu = runtime.gpu;
  const label = String(gpu.label || gpu.name || gpu.model || 'GPU');
  const vendor = String(gpu.vendor || 'Unknown');
  const totalBytes = gpu.total_bytes ?? gpu.available_bytes ?? null;
  const usedBytes = gpu.used_bytes ?? null;
  const usagePercent = gpu.usage_percent != null ? Number(gpu.usage_percent) : null;

  return [{
    id: 'gpu-runtime',
    type: 'gpu',
    vendor,
    model: label,
    usage_percent: Number.isFinite(usagePercent) ? usagePercent : null,
    memory_total_bytes: Number.isFinite(Number(totalBytes)) ? Number(totalBytes) : null,
    memory_used_bytes: Number.isFinite(Number(usedBytes)) ? Number(usedBytes) : null,
    driver: String(gpu.driver || ''),
  }];
}

function parseGpuMemoryFromLabel(label) {
  if (!label || typeof label !== 'string') {
    return null;
  }

  const match = label.match(/(\d+(?:[\.,]\d+)?)\s*(GB|Go|MB|Mo)/i);
  if (!match) {
    return null;
  }

  const value = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) {
    return null;
  }

  const unit = match[2].toLowerCase();
  if (unit.startsWith('g')) {
    return Math.round(value * 1024 * 1024 * 1024);
  }
  if (unit.startsWith('m')) {
    return Math.round(value * 1024 * 1024);
  }

  return null;
}

function formatHardwareProfileGpu(profileGpu) {
  if (!profileGpu || typeof profileGpu !== 'object') {
    return null;
  }

  const device = profileGpu.devices?.[0] || {};
  const adapterBytes = device.adapter_ram_bytes ?? profileGpu.memory_total_bytes ?? null;
  let totalBytes = Number.isFinite(Number(adapterBytes)) ? Number(adapterBytes) : null;
  if (totalBytes === null) {
    totalBytes = parseGpuMemoryFromLabel(String(profileGpu.label || profileGpu.model || ''));
  }

  return {
    id: 'gpu-profile',
    type: 'gpu',
    vendor: String(profileGpu.vendor || 'Unknown'),
    model: String(profileGpu.label || profileGpu.model || 'GPU'),
    usage_percent: null,
    memory_total_bytes: totalBytes,
    memory_used_bytes: null,
    driver: String(device.driver_version || profileGpu.driver_version || ''),
  };
}

async function getPerformanceMetrics() {
  const hardwareProfile = await readHardwareProfile();
  const hostMetrics = await fetchHostMetrics();
  const runtime = await getRuntimeStatus().catch(() => null);

  let hardware = [];
  let memory = {
    total_bytes: os.totalmem(),
    free_bytes: os.freemem(),
    used_bytes: os.totalmem() - os.freemem(),
  };
  let system = {
    platform: os.platform(),
    arch: os.arch(),
    uptime_seconds: Math.floor(os.uptime()),
    hostname: os.hostname(),
    os_profile: hardwareProfile?.os || null,
  };

  const profileGpu = hardwareProfile?.gpu ? formatHardwareProfileGpu(hardwareProfile.gpu) : null;
  const baselineCpu = mapHostCpuMetrics(null, hardwareProfile);

  if (hostMetrics) {
    const hostData = hostMetrics;
    const hostGpuHardware = mapHostGpuMetrics(hostData.GPU);

    hardware = [
      ...mapHostCpuMetrics(hostData.System?.CPU || hostData.System, hardwareProfile),
      ...hostGpuHardware,
    ].filter((item) => item && item.type);

    const hostMemory = mapHostMemoryMetrics(hostData.System?.Memory || hostData.Memory);
    if (hostMemory) {
      memory = {
        ...memory,
        host_total_bytes: hostMemory.total_bytes,
        host_free_bytes: hostMemory.free_bytes,
        host_used_bytes: hostMemory.used_bytes,
      };
    }

    if (hostData.System?.OS) {
      system = {
        ...system,
        os_profile: hostData.System.OS.Caption || hostData.System.OS.Name || system.os_profile,
        uptime_seconds: normalizeNumber(hostData.System.OS.Uptime) ?? system.uptime_seconds,
      };
    }
  }

  if (hardware.length === 0 || hardware.every((item) => item.type !== 'gpu')) {
    hardware = [
      ...baselineCpu,
      ...(profileGpu ? [profileGpu] : getRuntimeGpuFallback(runtime)),
    ];
  }

  if (hardwareProfile?.memory?.total_bytes != null) {
    memory.host_total_bytes = Number(hardwareProfile.memory.total_bytes);
  }
  if (hardwareProfile?.memory?.free_bytes != null) {
    memory.host_free_bytes = Number(hardwareProfile.memory.free_bytes);
    if (memory.host_total_bytes != null) {
      memory.host_used_bytes = Math.max(0, memory.host_total_bytes - memory.host_free_bytes);
    }
  }

  return {
    system,
    memory,
    hardware,
    profile: hardwareProfile || null,
    source: hostMetrics?.source || 'host-metrics',
  };
}

async function getRuntimeSnapshot() {
  const fallbackRuntime = await readRuntimeStateFallback();

  try {
    const runtime = await getRuntimeStatus();
    return { runtime, source: 'controller' };
  } catch (error) {
    if (hasUsefulRuntimeState(fallbackRuntime)) {
      return { runtime: fallbackRuntime, source: 'runtime_state', detail: error.message };
    }

    throw error;
  }
}

async function ensureRuntimeReady(preferredModel, options = {}) {
  const runtimeStatus = await getRuntimeStatus();
  const activeModel = runtimeStatus?.active_model || runtimeStatus?.active_filename;

  if (preferredModel && preferredModel !== PROXY_MODEL_ID && preferredModel !== activeModel) {
    const startRequest = await buildModelStartRequest(preferredModel);
    if (options.embedding) {
      startRequest.payload.embedding = true;
    }
    await controllerRequest('/start', {
      method: 'POST',
      body: JSON.stringify(startRequest.payload),
      timeout: CONTROLLER_START_TIMEOUT_MS,
    });
    return getRuntimeStatus();
  }

  if (runtimeStatus?.running && runtimeStatus?.active_model) {
    return runtimeStatus;
  }

  const modelToStart = preferredModel || runtimeStatus?.active_filename || runtimeStatus?.active_model;
  if (!modelToStart) {
    return runtimeStatus;
  }

  const startRequest = await buildModelStartRequest(modelToStart);
  if (options.embedding) {
    startRequest.payload.embedding = true;
  }
  await controllerRequest('/start', {
    method: 'POST',
    body: JSON.stringify(startRequest.payload),
    timeout: CONTROLLER_START_TIMEOUT_MS,
  });

  return getRuntimeStatus();
}

function toModelId(filename) {
  return path.basename(filename, path.extname(filename));
}

async function listLocalModels() {
  await fs.promises.mkdir(MODEL_STORAGE_DIR, { recursive: true });
  const entries = await fs.promises.readdir(MODEL_STORAGE_DIR, { withFileTypes: true });
  const files = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.gguf'))
    .map(async (entry) => {
      const fullPath = path.join(MODEL_STORAGE_DIR, entry.name);
      const stat = await fs.promises.stat(fullPath);
      return {
        name: toModelId(entry.name),
        filename: entry.name,
        path: fullPath,
        size: stat.size,
        modified_at: Math.floor(stat.mtimeMs / 1000),
      };
    }));

  return files.sort((left, right) => left.name.localeCompare(right.name, 'fr', { sensitivity: 'base' }));
}

async function resolveEmbeddingModel() {
  const localModels = await listLocalModels();
  const lowerNames = localModels.map((item) => item.name.toLowerCase());

  for (const candidate of EMBEDDING_MODEL_CANDIDATES) {
    const index = lowerNames.findIndex((name) => name === candidate.toLowerCase() || name.startsWith(candidate.toLowerCase()));
    if (index >= 0) {
      return localModels[index].name;
    }
  }

  return null;
}

async function readEmbeddingModelPreference() {
  try {
    if (!fs.existsSync(EMBEDDING_MODEL_STATE_PATH)) {
      return null;
    }
    const raw = await fs.promises.readFile(EMBEDDING_MODEL_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return typeof parsed.model === 'string' && parsed.model.trim() !== '' ? parsed.model.trim() : null;
  } catch {
    return null;
  }
}

async function writeEmbeddingModelPreference(modelName) {
  const dir = path.dirname(EMBEDDING_MODEL_STATE_PATH);
  if (!fs.existsSync(dir)) {
    await fs.promises.mkdir(dir, { recursive: true });
  }
  await fs.promises.writeFile(EMBEDDING_MODEL_STATE_PATH, JSON.stringify({ model: modelName, updated_at: new Date().toISOString() }, null, 2), 'utf8');
}

async function resolveEmbeddingModelInstance(modelName) {
  const snapshot = await getRuntimeSnapshot();
  const runtime = snapshot.runtime;
  const instances = Array.isArray(runtime?.instances) ? runtime.instances : [];
  const name = String(modelName || '').trim();
  if (!name) {
    return null;
  }
  const match = instances.find((instance) => {
    const modelId = String(instance.model || instance.filename || '').trim();
    return modelId.toLowerCase() === name.toLowerCase();
  });
  return match || null;
}

async function resolveModel(identifier) {
  const models = await listLocalModels();
  const needle = String(identifier || '').trim();
  if (!needle) {
    throw new Error('model requis');
  }

  const exactFilename = models.find((item) => item.filename.toLowerCase() === needle.toLowerCase());
  if (exactFilename) {
    return exactFilename;
  }

  const exactId = models.find((item) => item.name.toLowerCase() === needle.toLowerCase());
  if (exactId) {
    return exactId;
  }

  throw new Error(`Modèle introuvable : ${needle}`);
}

function filenameFromUrl(value) {
  const pathname = new URL(value).pathname;
  return decodeURIComponent(path.basename(pathname));
}

function ensureGgufUrl(url) {
  return /^https?:\/\/.+\.gguf(?:\?.*)?$/i.test(String(url || '').trim());
}

function parseOllamaLibraryReference(value) {
  const raw = String(value || '').trim();
  if (!raw) {
    throw new Error('Référence Ollama requise');
  }

  let normalized = raw;
  if (/^https?:\/\//i.test(normalized)) {
    const parsed = new URL(normalized);
    const pathname = parsed.pathname.replace(/^\/+/u, '');
    if (!pathname.startsWith('library/')) {
      throw new Error('Lien Ollama invalide. Utilise un lien de bibliothèque ou un nom du type gemma3n:e4b.');
    }
    normalized = pathname.slice('library/'.length);
  }

  normalized = normalized.replace(/^library\//u, '');
  const slashIndex = normalized.lastIndexOf('/');
  const colonIndex = normalized.lastIndexOf(':');
  const hasExplicitTag = colonIndex > slashIndex;
  const modelPart = hasExplicitTag ? normalized.slice(0, colonIndex) : normalized;
  const tag = hasExplicitTag ? normalized.slice(colonIndex + 1) : 'latest';
  const repository = modelPart.includes('/') ? modelPart : `library/${modelPart}`;
  const displayName = modelPart.replace(/^library\//u, '');
  const safeName = `${displayName.replace(/[\/]/gu, '-')}-${tag}`.replace(/[^a-zA-Z0-9._-]/gu, '-');

  return {
    repository,
    tag,
    safeName,
  };
}

async function downloadToModelsDir(url, name) {
  const response = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'LIA-Model-Loader',
    },
  });

  if (!response.ok || !response.body) {
    throw new Error(`Téléchargement impossible (${response.status} ${response.statusText})`);
  }

  await fs.promises.mkdir(MODEL_STORAGE_DIR, { recursive: true });
  const rawBase = String(name || filenameFromUrl(url)).trim();
  const safeBase = path.basename(rawBase) || filenameFromUrl(url);
  const normalizedBase = safeBase.trim();
  if (!normalizedBase) {
    throw new Error('Nom de fichier invalide pour le téléchargement.');
  }
  const targetFilename = normalizedBase.toLowerCase().endsWith('.gguf') ? normalizedBase : `${normalizedBase}.gguf`;
  const targetPath = path.join(MODEL_STORAGE_DIR, targetFilename);

  if (fs.existsSync(targetPath)) {
    throw new Error(`Le fichier existe déjà : ${targetFilename}`);
  }

  const contentLength = response.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : null;
  if (totalBytes && !(await checkDiskSpace(MODEL_STORAGE_DIR, totalBytes))) {
    throw new Error('Espace disque insuffisant pour le téléchargement.');
  }

  const modelKey = toModelId(targetFilename);
  startDownloadJob(modelKey, totalBytes);
  const tracker = createProgressTracker(modelKey);
  try {
    await pipeline(Readable.fromWeb(response.body), tracker, fs.createWriteStream(targetPath));
  } finally {
    finishDownloadJob(modelKey, null);
  }
  return {
    filename: targetFilename,
    model: modelKey,
    path: targetPath,
  };
}

async function importFromOllamaLibrary(reference, localName) {
  const parsed = parseOllamaLibraryReference(reference);
  const manifestResponse = await fetch(`${OLLAMA_REGISTRY_BASE_URL}/v2/${parsed.repository}/manifests/${parsed.tag}`, {
    headers: {
      Accept: 'application/vnd.docker.distribution.manifest.v2+json',
      'User-Agent': 'LIA-Model-Loader',
    },
  });

  if (!manifestResponse.ok) {
    throw new Error(`Manifest Ollama introuvable (${manifestResponse.status} ${manifestResponse.statusText})`);
  }

  const manifest = await manifestResponse.json();
  const modelLayer = Array.isArray(manifest.layers)
    ? manifest.layers.find((layer) => layer.mediaType === 'application/vnd.ollama.image.model')
    : null;

  if (!modelLayer?.digest) {
    throw new Error('Le manifest Ollama ne contient pas de couche modèle exploitable.');
  }

  const blobResponse = await fetch(`${OLLAMA_REGISTRY_BASE_URL}/v2/${parsed.repository}/blobs/${modelLayer.digest}`, {
    redirect: 'follow',
    headers: {
      'User-Agent': 'LIA-Model-Loader',
    },
  });

  if (!blobResponse.ok || !blobResponse.body) {
    throw new Error(`Téléchargement Ollama impossible (${blobResponse.status} ${blobResponse.statusText})`);
  }

  await fs.promises.mkdir(MODEL_STORAGE_DIR, { recursive: true });
  const baseName = String(localName || parsed.safeName).trim();
  const targetFilename = baseName.toLowerCase().endsWith('.gguf') ? baseName : `${baseName}.gguf`;
  const targetPath = path.join(MODEL_STORAGE_DIR, targetFilename);

  if (fs.existsSync(targetPath)) {
    throw new Error(`Le fichier existe déjà : ${targetFilename}`);
  }

  const contentLength = blobResponse.headers.get('content-length');
  const totalBytes = contentLength ? parseInt(contentLength, 10) : null;
  if (totalBytes && !(await checkDiskSpace(MODEL_STORAGE_DIR, totalBytes))) {
    throw new Error('Espace disque insuffisant pour le téléchargement.');
  }

  const modelKey = toModelId(targetFilename);
  startDownloadJob(modelKey, totalBytes);
  const tracker = createProgressTracker(modelKey);
  try {
    await pipeline(Readable.fromWeb(blobResponse.body), tracker, fs.createWriteStream(targetPath));
  } finally {
    finishDownloadJob(modelKey, null);
  }
  return {
    filename: targetFilename,
    model: modelKey,
    path: targetPath,
  };
}

function proxyModelPayload(runtimeStatus) {
  const activeModel = resolveActiveModel(runtimeStatus);
  const loadedModels = buildLoadedModelList(runtimeStatus);

  return loadedModels
    .map((model) => ({
      id: model.model,
      object: 'model',
      owned_by: 'lia',
      permission: [],
      active_model: activeModel,
      backend: runtimeStatus?.backend,
      filename: model.filename,
      running: model.running,
      size_vram: model.size_vram,
      expires_at: model.expires_at,
      embedding_capable: EMBEDDING_MODEL_CANDIDATES.some((candidate) => {
        const name = String(model.model || model.filename || '').toLowerCase();
        return name === candidate.toLowerCase() || name.startsWith(candidate.toLowerCase());
      }),
    }))
    .filter((entry, index, array) => array.findIndex((item) => item.id === entry.id) === index);
}

async function buildFullModelList(runtimeStatus) {
  const loaded = proxyModelPayload(runtimeStatus);
  const loadedIds = new Set(loaded.map((item) => item.id));
  const localModels = await listLocalModels();

  const extras = localModels.map((item) => ({
    id: item.name,
    object: 'model',
    owned_by: 'lia',
    permission: [],
    active_model: resolveActiveModel(runtimeStatus),
    backend: runtimeStatus?.backend,
    filename: item.filename,
    running: loadedIds.has(item.name),
    size_vram: null,
    expires_at: null,
    embedding_capable: EMBEDDING_MODEL_CANDIDATES.some((candidate) => {
      const name = String(item.name || item.filename || '').toLowerCase();
      return name === candidate.toLowerCase() || name.startsWith(candidate.toLowerCase());
    }),
  }));

  const hasLiaLocal = loadedIds.has(PROXY_MODEL_ID);
  const list = [...loaded];

  if (!hasLiaLocal) {
    list.unshift({
      id: PROXY_MODEL_ID,
      object: 'model',
      owned_by: 'lia',
      permission: [],
      active_model: resolveActiveModel(runtimeStatus),
      backend: runtimeStatus?.backend,
      filename: runtimeStatus?.active_filename || null,
      running: Boolean(runtimeStatus?.running),
      size_vram: null,
      expires_at: runtimeStatus?.started_at || null,
    });
  }

  for (const model of extras) {
    if (!list.some((entry) => entry.id === model.id)) {
      list.push(model);
    }
  }

  return list;
}

function translateToDockerHost(url) {
  if (!DOCKER_INTERNAL || typeof url !== 'string') {
    return url;
  }

  return url
    .replace(/^http:\/\/127\.0\.0\.1(:\d+)/i, 'http://host.docker.internal$1')
    .replace(/^http:\/\/localhost(:\d+)/i, 'http://host.docker.internal$1');
}

function getRuntimeBaseUrl(runtimeStatus, requestedModel) {
  if (!runtimeStatus || typeof runtimeStatus !== 'object') {
    return translateToDockerHost(LLAMA_SERVER_BASE_URL);
  }

  const instances = Array.isArray(runtimeStatus.instances)
    ? runtimeStatus.instances
    : runtimeStatus.instances
      ? [runtimeStatus.instances]
      : [];

  if (requestedModel) {
    const matchedInstance = instances.find((instance) => {
      const modelId = String(instance.model || instance.filename || instance.proxy_id || instance.id || '').trim();
      return modelId === requestedModel || String(instance.proxy_id || '').trim() === requestedModel;
    });

    if (matchedInstance?.server_base_url) {
      return translateToDockerHost(String(matchedInstance.server_base_url).replace(/\/v1\/?$/, '').replace(/\/$/, ''));
    }
  }

  // BUG : find(active || running) prenait la PREMIERE instance running (ex:
  // Qwen3-Embedding sur 12434) au lieu de l'instance ACTIVE → le proxy
  // routait le chat vers le mauvais modèle. Priorité : active > running.
  const activeInstance = instances.find((instance) => Boolean(instance.active))
    || instances.find((instance) => Boolean(instance.running));
  if (activeInstance?.server_base_url) {
    return translateToDockerHost(String(activeInstance.server_base_url).replace(/\/v1\/?$/, '').replace(/\/$/, ''));
  }

  if (typeof runtimeStatus.server_port === 'number' && runtimeStatus.server_port > 0) {
    return translateToDockerHost(`http://127.0.0.1:${runtimeStatus.server_port}`);
  }

  return translateToDockerHost(LLAMA_SERVER_BASE_URL);
}

function normalizeHeaderValue(value) {
  if (typeof value === 'string') {
    return value.trim().toLowerCase();
  }

  if (Array.isArray(value)) {
    return value.map((item) => normalizeHeaderValue(item)).join(', ');
  }

  return '';
}

function requestContainsRoocodeHeader(req) {
  const headers = req.headers || {};
  const headerEntries = Object.entries(headers).map(([name, value]) => ({
    name: String(name || '').trim().toLowerCase(),
    value: normalizeHeaderValue(value),
  }));

  const knownSourcePattern = /roocode|coolcline|cline|roocodeclient|roocode-client|roocode-source/i;
  const hasKnownSourceHeader = headerEntries.some(({ name, value }) => knownSourcePattern.test(name) || knownSourcePattern.test(value));

  const hasCustomSourceHeader = ROOCODE_SOURCE_HEADER_NAME
    && headerEntries.some(({ name, value }) => name === ROOCODE_SOURCE_HEADER_NAME && value === ROOCODE_SOURCE_HEADER_VALUE);

  return hasKnownSourceHeader || hasCustomSourceHeader;
}

// P-UX (SSE) : proxy d'inférence en http.request natif.
// Pourquoi pas fetch() :
//  - undici refuse un agent http/agentkeepalive en `dispatcher` (fetch failed)
//  - undici coupe les corps après 5 min (bodyTimeout) : incompatible avec les
//    générations longues et le streaming SSE.
// http.request + agentkeepalive permet un pipe direct upstream → client, avec
// un timeout socket désactivé.
function proxyToRuntime(targetBaseUrl, endpoint, method, payload) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(`${targetBaseUrl}${endpoint}`);
    } catch (error) {
      reject(new Error(`URL runtime invalide: ${targetBaseUrl}${endpoint}`));
      return;
    }

    const transport = target.protocol === 'https:' ? require('https') : http;
    const bodyText = JSON.stringify(payload ?? {});
    const proxyReq = transport.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === 'https:' ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      agent: PROXY_STREAM_AGENT,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyText),
        Accept: 'application/json, text/event-stream',
      },
    });

    // Aucun timeout : une génération locale peut durer plusieurs minutes.
    proxyReq.setTimeout(0);
    proxyReq.on('response', (upstream) => resolve(upstream));
    proxyReq.on('error', (error) => reject(error));
    proxyReq.end(bodyText);
  });
}

async function proxyOpenAiRequest(req, res, endpoint) {
  try {
    const preferredModel = typeof req.body?.model === 'string' && req.body.model !== PROXY_MODEL_ID
      ? req.body.model
      : undefined;
    const isEmbeddingEndpoint = endpoint === '/v1/embeddings';
    const embeddingModelName = isEmbeddingEndpoint
      ? (preferredModel || (await readEmbeddingModelPreference()) || (await resolveEmbeddingModel()))
      : undefined;
    const isEmbeddingCapable = Boolean(embeddingModelName && EMBEDDING_MODEL_CANDIDATES.some((candidate) => {
      const name = String(embeddingModelName || '').toLowerCase();
      return name === candidate.toLowerCase() || name.startsWith(candidate.toLowerCase());
    }));
    const runtimeStatus = await ensureRuntimeReady(preferredModel || embeddingModelName, {
      embedding: isEmbeddingEndpoint && isEmbeddingCapable,
    });
    if (!runtimeStatus?.running || !runtimeStatus?.active_model) {
      return err(res, 503, 'Aucun modèle actif côté llama.cpp');
    }

    const isRoocodeRequest = requestContainsRoocodeHeader(req);
    const payload = isRoocodeRequest ? (req.body || {}) : { ...(req.body || {}) };
    const requestedModel = typeof payload.model === 'string' && payload.model !== PROXY_MODEL_ID
      ? payload.model
      : undefined;

    if (!isRoocodeRequest) {
      const upstreamModel = runtimeStatus.active_filename || runtimeStatus.active_model;
      if (!payload.model || payload.model === PROXY_MODEL_ID) {
        payload.model = upstreamModel;
      }
    }

    const runtimeUrl = getRuntimeBaseUrl(runtimeStatus, requestedModel);
    const isStreaming = payload.stream === true;
    console.log('[model-manager] proxy request', { endpoint, requestedModel, isRoocodeRequest, runtimeUrl, isStreaming });

    const upstream = await proxyToRuntime(runtimeUrl, endpoint, req.method, payload);

    res.status(upstream.statusCode || 502);
    Object.entries(upstream.headers).forEach(([key, value]) => {
      const lower = key.toLowerCase();
      // On laisse Node/Express gérer le framing ; on recopie le reste (ex:
      // content-type: text/event-stream indispensable au SSE).
      if (['content-length', 'transfer-encoding', 'connection', 'keep-alive'].includes(lower)) {
        return;
      }
      if (value === undefined) { return; }
      try {
        res.setHeader(key, value);
      } catch {
        // En-tête non copiable (ex: valeur invalide) : on l'ignore.
      }
    });

    // SSE : flusher les headers immédiatement pour que les chunks arrivent au
    // client au fil de l'eau (Open WebUI, LibreChat, etc.).
    if (isStreaming && String(upstream.headers['content-type'] || '').includes('text/event-stream')) {
      res.flushHeaders();
    }

    upstream.on('error', () => {
      if (!res.writableEnded) { res.end(); }
    });
    upstream.pipe(res);
  } catch (error) {
    if (!res.headersSent) {
      err(res, 502, error.message);
    } else {
      res.end();
    }
  }
}

app.get('/metrics/host', async (req, res) => {
  try {
    const metricsUrl = `${METRICS_HOST_URL.replace(/\/$/, '')}/metrics/host`;
    const hostResponse = await fetch(metricsUrl, { method: 'GET' });

    if (!hostResponse.ok) {
      const responseText = await hostResponse.text();
      throw new Error(`Host metrics service returned ${hostResponse.status}: ${responseText}`);
    }

    const hostMetrics = await hostResponse.json();
    res.json({
      source: 'host-metrics-service',
      metricsHostUrl: metricsUrl,
      hostMetrics,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError('/metrics/host', error);
    res.status(500).json({ error: `Error requesting host metrics: ${error.message}` });
  }
});

app.get('/health', async (req, res) => {
  // P1 : /health est le healthcheck Docker (toutes les 15 s, timeout 10 s).
  // Il NE DOIT PAS appeler getRuntimeStatus() (controller, ~0,5-3 s, file
  // derrière les longues requêtes /start) : c'est ce qui rendait le conteneur
  // "unhealthy" en permanence. On sert le cache mémoire, frais ou périmé.
  try {
    const now = Date.now();
    if (STATUS_CACHE) {
      const ageMs = Math.max(0, now - (STATUS_CACHE_TTL - STATUS_CACHE_MAX_AGE));
      return res.json({ ok: true, controller_ok: true, runtime: STATUS_CACHE, cache_age_ms: ageMs });
    }
    if (STATUS_INFLIGHT) {
      const runtime = await Promise.race([
        STATUS_INFLIGHT,
        new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (runtime) {
        return res.json({ ok: true, controller_ok: true, runtime });
      }
      return res.json({ ok: true, controller_ok: false, detail: 'controller busy (status in flight)', runtime: null });
    }
    const runtime = await Promise.race([
      getRuntimeStatus(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('health timeout 8s')), 8000)),
    ]);
    res.json({ ok: true, controller_ok: true, runtime });
  } catch (error) {
    res.json({
      ok: true,
      controller_ok: false,
      detail: error.message,
      runtime: STATUS_CACHE,
    });
  }
});

app.post('/api/controller/restart', async (req, res) => {
  try {
    try {
      const runtimeStatus = await getRuntimeStatus();
      const instance = Array.isArray(runtimeStatus?.instances)
        ? runtimeStatus.instances[0]
        : runtimeStatus?.instances;

      if (!instance || !instance.model || !instance.port) {
        throw new Error('Aucun modèle actif ou instance disponible pour redémarrage.');
      }

      await controllerRequest('/restart', {
        method: 'POST',
        body: JSON.stringify({
          model: instance.model,
          id: instance.id,
          proxy_id: instance.proxy_id,
          port: instance.port,
        }),
        timeout: CONTROLLER_START_TIMEOUT_MS,
      });

      const updatedStatus = await getRuntimeStatus();
      return res.json({ ok: true, runtime: updatedStatus, restarted_with: 'controller' });
    } catch (error) {
      const fallbackError = error;
      try {
        const launcherResult = await hostLauncherRequest('/restart', {
          method: 'POST',
          timeout: 15000,
        });
        return res.json({ ok: true, launcher: true, result: launcherResult, restarted_with: 'host_launcher' });
      } catch (launcherError) {
        const detail = `Controller API failed: ${fallbackError.message}; launcher failed: ${launcherError.message}`;
        return err(res, 502, detail);
      }
    }
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/version', async (req, res) => {
  try {
    const snapshot = await getRuntimeSnapshot();
    const runtime = snapshot.runtime;
    res.json({
      version: runtime?.backend_label ? `llama.cpp · ${runtime.backend_label}` : 'llama.cpp',
      device: runtime?.backend_label || 'Runtime indisponible',
      model_dir: MODEL_STORAGE_DIR,
      runtime_url: `${getRuntimeBaseUrl(runtime)}/v1`,
      source: snapshot.source,
      detail: snapshot.detail || null,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/hardware-profile', async (req, res) => {
  try {
    const profile = await readHardwareProfile();
    // P-UX : suggestion de réglages (contexte / couches GPU) d'après le matériel.
    // Purement informatif : buildModelStartRequest ne s'en sert que si l'UI
    // n'a fourni aucune valeur explicite.
    res.json({
      profile,
      recommended_runtime: computeRecommendedRuntime(profile)
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/performance', async (req, res) => {
  try {
    const performance = await getPerformanceMetrics();
    res.json(performance);
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/models/available', async (req, res) => {
  try {
    const snapshot = await getRuntimeSnapshot();
    const runtime = snapshot.runtime;
    const loadedModels = buildLoadedModelList(runtime);
    const loadedModelNames = new Set(loadedModels.map((item) => item.model));
    const models = await listLocalModels();
    const hardwareProfile = await readHardwareProfile();
    const files = await Promise.all(models.map(async (item) => {
      let contextLength = null;
      let gpuLayers = null;
      try {
        const details = await getModelGgufDetails(item);
        if (Number.isInteger(details?.context_length) && details.context_length > 0) {
          contextLength = details.context_length;
        }
        if (Number.isInteger(details?.gpu_layers) && details.gpu_layers >= 0) {
          gpuLayers = details.gpu_layers;
        }
      } catch (error) {
        pushLogEntry('server', '/api/models/available', 'warn', `GGUF metadata unavailable for ${item.name}: ${error?.message || error}`);
      }

      // P-UX : recommandation par modèle (suggestion affichée dans l'UI, jamais
      // imposée). Le contexte conseillé est borné par le contexte natif du GGUF.
      const recommendation = computeRecommendedRuntime(hardwareProfile, item.size);
      if (contextLength) {
        recommendation.context = Math.min(recommendation.context, contextLength);
      }

      return {
        name: item.name,
        path: item.path,
        size: item.size,
        modified_at: item.modified_at,
        loaded: loadedModelNames.has(item.name),
        context_length: contextLength,
        gpu_layers: gpuLayers,
        recommended_context: recommendation.context,
        recommended_gpu_layers: recommendation.gpu_layers,
      };
    }));
    res.json({ files, source: snapshot.source, hostDir: await resolveHostModelsDir() || MODEL_HOST_DIR || null });
  } catch (error) {
    err(res, 502, error.message);
  }
});

// Ouvre le dossier des modèles dans l'Explorateur Windows (côté hôte).
// Le controller (service Windows) est le seul à pouvoir lancer explorer.exe :
// en session 0 l'ouverture est impossible, on renvoie alors mode='session0'
// pour que l'UI propose le raccourci .url (toujours fonctionnel).
app.post('/api/system/open-models-folder', async (req, res) => {
  const target = normalizeHostDir(req.body?.path) || (await resolveHostModelsDir());
  if (!target) {
    return err(res, 503, "Dossier des modèles hôte inconnu (HOST_MODELS_DIR / runtime config non renseigné)");
  }

  const failures = [];

  try {
    const launcherResult = await hostLauncherRequest('/open-folder', {
      method: 'POST',
      body: JSON.stringify({ path: target }),
      timeout: 8000,
    });
    if (launcherResult?.ok) {
      return res.json({ ok: true, path: target, mode: 'launcher', result: launcherResult });
    }
    failures.push(`launcher: ${launcherResult?.message || 'refus'}`);
  } catch (error) {
    failures.push(`launcher: ${error.message}`);
  }

  try {
    const controllerResult = await controllerRequest('/open-folder', {
      method: 'POST',
      body: JSON.stringify({ path: target }),
      timeout: 15000,
    });
    const ok = Boolean(controllerResult?.ok);
    return res.json({
      ok,
      path: controllerResult?.path || target,
      mode: controllerResult?.mode || 'controller',
      message: controllerResult?.message || '',
      shortcut_url: '/api/system/models-folder-shortcut',
      failures,
    });
  } catch (error) {
    failures.push(`controller: ${error.message}`);
    return err(res, 502, `Ouverture du dossier impossible (${failures.join(' ; ')})`);
  }
});

// Raccourci Windows (.url) vers le dossier des modèles : cliqué, il ouvre
// l'Explorateur sur le bon chemin. Fonctionne même quand le service tourne en
// session 0 (cas nominal d'une installation NSSM).
app.get('/api/system/models-folder-shortcut', async (req, res) => {
  const target = await resolveHostModelsDir();
  if (!target) {
    return err(res, 503, "Dossier des modèles hôte inconnu (HOST_MODELS_DIR / runtime config non renseigné)");
  }

  const fileUrl = `file:///${target.replace(/\\/g, '/').replace(/ /g, '%20')}`;
  const iconFile = normalizeHostDir(process.env.HOST_INSTALL_DIR) ? `${process.env.HOST_INSTALL_DIR}\\logo.ico` : '';
  const lines = ['[InternetShortcut]', `URL=${fileUrl}`];
  if (iconFile) {
    lines.push(`IconFile=${iconFile}`);
    lines.push('IconIndex=0');
  }
  const body = `${lines.join('\r\n')}\r\n`;

  pushLogEntry('server', '/api/system/models-folder-shortcut', 'info', `Raccourci demandé pour ${target}`);
  res.setHeader('Content-Type', 'application/internet-shortcut');
  res.setHeader('Content-Disposition', 'attachment; filename="Dossier-modeles-LIA-X.url"');
  res.send(body);
});

app.get('/api/models', async (req, res) => {
  try {
    const snapshot = await getRuntimeSnapshot();
    const runtime = snapshot.runtime;
    const loadedModels = buildLoadedModelList(runtime);

    res.json({
      active_model: resolveActiveModel(runtime),
      models: loadedModels,
      source: snapshot.source,
      detail: snapshot.detail || null,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/modeles', async (req, res) => {
  try {
    const snapshot = await getRuntimeSnapshot();
    const runtime = snapshot.runtime;
    const loadedModels = buildLoadedModelList(runtime);

    res.json({
      active_model: resolveActiveModel(runtime),
      models: loadedModels,
      source: snapshot.source,
      detail: snapshot.detail || null,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/modeles', async (req, res) => {
  try {
    const snapshot = await getRuntimeSnapshot();
    const runtime = snapshot.runtime;
    const loadedModels = buildLoadedModelList(runtime);

    res.json({
      active_model: resolveActiveModel(runtime),
      models: loadedModels,
      source: snapshot.source,
      detail: snapshot.detail || null,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/models/active', async (req, res) => {
  try {
    const snapshot = await getRuntimeSnapshot();
    res.json({
      active_model: resolveActiveModel(snapshot.runtime),
      source: snapshot.source,
      detail: snapshot.detail || null,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/embedding-model', async (req, res) => {
  try {
    const model = await readEmbeddingModelPreference();
    const instance = model ? await resolveEmbeddingModelInstance(model) : null;
    res.json({
      embedding_model: model,
      loaded: !!instance,
      port: instance?.port || null,
      server_base_url: instance?.server_base_url || null,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.post('/api/embedding-model', async (req, res) => {
  try {
    const modelName = String(req.body?.model || '').trim();

    if (!modelName) {
      const current = await readEmbeddingModelPreference();
      if (current) {
        const instance = await resolveEmbeddingModelInstance(current);
        if (instance) {
          try {
            await controllerRequest('/stop', {
              method: 'POST',
              body: JSON.stringify({ model: current }),
              timeout: 30000,
              maxRetries: 0,
            });
          } catch (stopError) {
            console.error('[model-manager] /api/embedding-model stop error', stopError);
          }
        }
      }
      try {
        await fs.promises.rm(EMBEDDING_MODEL_STATE_PATH, { force: true });
      } catch {
        // no-op
      }
      return res.json({ ok: true, embedding_model: null });
    }

    const localModels = await listLocalModels();
    const exists = localModels.some((item) => item.name.toLowerCase() === modelName.toLowerCase());
    if (!exists) {
      return err(res, 404, `Modele introuvable: ${modelName}`);
    }

    await writeEmbeddingModelPreference(modelName);

    const instance = await resolveEmbeddingModelInstance(modelName);
    if (!instance || instance.embedding !== true) {
      try {
        if (instance && instance.embedding !== true) {
          await controllerRequest('/stop', {
            method: 'POST',
            body: JSON.stringify({ model: modelName }),
            timeout: 30000,
            maxRetries: 0,
          });
        }
        const startRequest = await buildModelStartRequest(modelName);
        startRequest.payload.embedding = true;
        await controllerRequest('/start', {
          method: 'POST',
          body: JSON.stringify(startRequest.payload),
          timeout: CONTROLLER_START_TIMEOUT_MS,
          maxRetries: 0,
        });
      } catch (startError) {
        console.error('[model-manager] /api/embedding-model start error', startError);
      }
    }

    res.json({ ok: true, embedding_model: modelName });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/models/status', async (req, res) => {
  try {
    const [snapshot, models] = await Promise.all([getRuntimeSnapshot(), listLocalModels()]);
    const runtime = snapshot.runtime;
    const loadedModels = buildLoadedModelList(runtime);
    const runtimeLogs = extractLogEntries(runtime);
    const containerLogs = await collectContainerLogs();
    const controllerMonitorLogs = await collectControllerMonitorLogs();
    const logEntries = [...getRecentLogEntries(), ...runtimeLogs, ...containerLogs, ...controllerMonitorLogs];

    res.json({
      total_models: models.length,
      running_models: loadedModels.filter((item) => item.running).length,
      gpu: { device: runtime?.backend_label || 'Runtime indisponible' },
      models: loadedModels.filter((item) => item.running).map((item) => ({
        model: item.model,
        device: runtime?.backend_label || 'Runtime indisponible',
        approx_memory_bytes: item.size_vram ?? 0,
      })),
      logs: logEntries,
      log_entries: logEntries,
      container_log_available: dockerSocketAvailable(),
      source: snapshot.source,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/models/details/:model', async (req, res) => {
  try {
    const model = await resolveModel(decodeURIComponent(req.params.model));
    const details = await getModelGgufDetails(model);
    res.json({
      model: {
        name: model.name,
        filename: model.filename,
        path: model.path,
        size: model.size,
        modified_at: model.modified_at,
      },
      gguf: details,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.post('/api/models/download', async (req, res) => {
  const { url, name, ollama_name: ollamaName } = req.body || {};

  try {
    let file;
    if (ollamaName) {
      file = await importFromOllamaLibrary(ollamaName, name);
    } else {
      if (!url || !ensureGgufUrl(url)) {
        return err(res, 400, 'URL GGUF invalide');
      }
      file = await downloadToModelsDir(url, name || filenameFromUrl(url));
    }
    res.json({ filename: file.model, status: 'ok' });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/models/load-progress', async (req, res) => {
  try {
    const progress = await readLoadProgress(req.query.model);
    res.json(progress);
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/models/download-progress', async (req, res) => {
  try {
    const progress = await readDownloadProgress(req.query.model);
    res.json(progress);
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.post('/api/models/load', async (req, res) => {
  try {
    const startRequest = await buildModelStartRequest(req.body?.model, req.body?.context, req.body?.gpu_layers);
    const modelName = String(req.body?.model || startRequest.model.name);
    const payload = { ...startRequest.payload, activate: false };
    startLoadJob(modelName);
    advanceLoadJob(modelName, 'spawning');
    console.log('[model-manager] /api/models/load', { model: startRequest.model.name, payload });
    try {
      await controllerRequest('/start', {
        method: 'POST',
        body: JSON.stringify(payload),
        timeout: CONTROLLER_START_TIMEOUT_MS,
        // PAS de retry : /start est non idempotent, un retry relancerait un
        // chargement complet de GGUF par-dessus le premier (minutes perdues).
        maxRetries: 0,
      });
      finishLoadJob(modelName, null);
    } catch (loadError) {
      finishLoadJob(modelName, loadError.message);
      throw loadError;
    }
    invalidateStatusCache();
    res.json({
      model: startRequest.model.name,
      status: 'loaded',
      active: false,
      context_applied: startRequest.payload.context || null,
      architecture: startRequest.details.architecture || null,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.post('/api/models/select', async (req, res) => {
  try {
    const modelName = String(req.body?.model || '').trim();
    if (!modelName) {
      return err(res, 400, 'model requis');
    }

    const payload = { model: modelName, activate: true };
    const normalizedContext = normalizeRequestedContext(req.body?.context);
    if (normalizedContext !== null) {
      payload.context = normalizedContext;
    }
    // gpu_layers était auparavant DROPPÉ ici : le controller retombait alors sur
    // default_gpu_layers, provoquant un mismatch et donc un rechargement complet.
    const normalizedGpuLayers = normalizeRequestedGpuLayers(req.body?.gpu_layers);
    if (normalizedGpuLayers !== null) {
      payload.gpu_layers = normalizedGpuLayers;
    }
    console.log('[model-manager] /api/models/select', { model: modelName, payload });
    // P-UX : on tracke aussi le job pour le cas où /select déclenche un vrai
    // chargement (modèle pas encore en mémoire). Si l'instance existe déjà,
    // la promotion est instantanée et le job disparaît aussitôt (ready).
    startLoadJob(modelName);
    try {
      await controllerRequest('/start', {
        method: 'POST',
        body: JSON.stringify(payload),
        timeout: CONTROLLER_START_TIMEOUT_MS,
        // P1 : /select est une activation pure quand context/gpu_layers ne sont
        // pas fournis. Un retry relancerait un chargement complet de GGUF
        // par-dessus le premier (minutes perdues + fetch failed) → jamais.
        maxRetries: 0,
      });
      finishLoadJob(modelName, null);
    } catch (selectError) {
      finishLoadJob(modelName, selectError.message);
      throw selectError;
    }
    invalidateStatusCache();
    res.json({
      active_model: modelName,
      context_applied: payload.context ?? null,
      architecture: null,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.post('/api/models/unload', async (req, res) => {
  try {
    const modelName = String(req.body?.model || '').trim();
    if (!modelName) {
      return err(res, 400, 'model requis');
    }

    console.log('[model-manager] /api/models/unload', { model: modelName });
    await controllerRequest('/stop', {
      method: 'POST',
      body: JSON.stringify({ model: modelName }),
      // /stop peut être en file derrière un /start long (chargement GGUF)
      // sur le controller mono-thread → timeout 15s par défaut risqué.
      // On donne 30s mais sans retry (non idempotent).
      timeout: 30000,
      maxRetries: 0,
    });
    invalidateStatusCache();
    res.json({ model: modelName, status: 'unloaded' });
  } catch (error) {
    try {
      const snapshot = await getRuntimeSnapshot();
      const runtime = snapshot.runtime;
      const loadedModels = buildLoadedModelList(runtime);
      const stillRunning = loadedModels.some((item) => item.model === modelName && item.running);
      if (!stillRunning) {
        return res.json({
          model: modelName,
          status: 'unloaded',
          source: 'reconciled_after_error',
          detail: error.message,
        });
      }
    } catch {
      // no-op: garder l'erreur initiale
    }
    err(res, 502, error.message);
  }
});

app.delete('/api/models/files/:filename', async (req, res) => {
  try {
    const model = await resolveModel(decodeURIComponent(req.params.filename));
    const runtime = await getRuntimeStatus();
    if (runtime?.active_model === model.name) {
      await controllerRequest('/stop', { method: 'POST', body: JSON.stringify({ model: model.name }) });
    }
    await fs.promises.rm(model.path, { force: true });
    res.json({ filename: model.name, status: 'deleted' });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.post('/api/models/import-hf', async (req, res) => {
  const { url, name } = req.body || {};
  if (!url || !ensureGgufUrl(url)) {
    return err(res, 400, 'URL Hugging Face GGUF invalide');
  }

  if (!name) {
    return err(res, 400, 'name requis');
  }

  try {
    const file = await downloadToModelsDir(url, name);
    res.json({ filename: file.model, status: 'ok' });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.all('/api/models/*', async (req, res) => {
  const subPath = (req.params[0] || '').replace(/^\/|\/$/g, '');
  const pathMap = {
    'models': '/v1/models',
    'chat/completions': '/v1/chat/completions',
    'completions': '/v1/completions',
    'embeddings': '/v1/embeddings',
  };
  const targetEndpoint = pathMap[subPath];

  if (!targetEndpoint) {
    return err(res, 404, `Endpoint /api/models/${subPath} non supporté`);
  }

  try {
    const queryString = Object.keys(req.query).length
      ? `?${new URLSearchParams(req.query).toString()}`
      : '';
    const url = `http://127.0.0.1:${PORT}${targetEndpoint}${queryString}`;

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && key.toLowerCase() !== 'host') {
        headers[key] = value;
      }
    }

    const response = await fetch(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!['content-length', 'transfer-encoding', 'connection'].includes(lower)) {
        res.setHeader(key, value);
      }
    });

    const bodyBuffer = Buffer.from(await response.arrayBuffer());
    res.end(bodyBuffer);
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.post('/api/cache/drop', async (req, res) => {
  res.status(501).json({ ok: false, error: 'Non applicable sur le runtime Windows llama.cpp.' });
});

app.get('/v1/models', async (req, res) => {
  try {
    const snapshot = await getRuntimeSnapshot();
    const runtime = snapshot.runtime;
    const models = await buildFullModelList(runtime);
    res.json({ object: 'list', data: models });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.post('/v1/chat/completions', async (req, res) => {
  await proxyOpenAiRequest(req, res, '/v1/chat/completions');
});

app.post('/v1/completions', async (req, res) => {
  await proxyOpenAiRequest(req, res, '/v1/completions');
});

app.post('/v1/embeddings', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.model || String(body.model).trim() === '') {
      const preferred = await readEmbeddingModelPreference();
      if (preferred) {
        body.model = preferred;
        req.body = body;
      } else {
        const embeddingModel = await resolveEmbeddingModel();
        if (embeddingModel) {
          body.model = embeddingModel;
          req.body = body;
        }
      }
    }
  } catch {
    // best-effort : on laisse le payload tel quel si la résolution échoue
  }
  await proxyOpenAiRequest(req, res, '/v1/embeddings');
});

app.get('/models', async (req, res) => {
  try {
    const snapshot = await getRuntimeSnapshot();
    const runtime = snapshot.runtime;
    const models = await buildFullModelList(runtime);
    res.json({ object: 'list', data: models });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.post('/chat/completions', async (req, res) => {
  await proxyOpenAiRequest(req, res, '/v1/chat/completions');
});

app.post('/completions', async (req, res) => {
  await proxyOpenAiRequest(req, res, '/v1/completions');
});

app.post('/embeddings', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.model || String(body.model).trim() === '') {
      const preferred = await readEmbeddingModelPreference();
      if (preferred) {
        body.model = preferred;
        req.body = body;
      } else {
        const embeddingModel = await resolveEmbeddingModel();
        if (embeddingModel) {
          body.model = embeddingModel;
          req.body = body;
        }
      }
    }
  } catch {
    // best-effort : on laisse le payload tel quel si la résolution échoue
  }
  await proxyOpenAiRequest(req, res, '/v1/embeddings');
});

app.all(['/api/models/*', '/models/*'], async (req, res) => {
  const subPath = (req.params[0] || '').replace(/^\/|\/$/g, '');
  const pathMap = {
    'models': '/v1/models',
    'chat/completions': '/v1/chat/completions',
    'completions': '/v1/completions',
    'embeddings': '/v1/embeddings',
  };
  const targetEndpoint = pathMap[subPath];

  if (!targetEndpoint) {
    return err(res, 404, `Endpoint ${req.path} non supporté`);
  }

  try {
    const queryString = Object.keys(req.query).length
      ? `?${new URLSearchParams(req.query).toString()}`
      : '';
    const url = `http://127.0.0.1:${PORT}${targetEndpoint}${queryString}`;

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === 'string' && key.toLowerCase() !== 'host') {
        headers[key] = value;
      }
    }

    const response = await fetch(url, {
      method: req.method,
      headers,
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : JSON.stringify(req.body || {}),
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!['content-length', 'transfer-encoding', 'connection'].includes(lower)) {
        res.setHeader(key, value);
      }
    });

    const bodyBuffer = Buffer.from(await response.arrayBuffer());
    res.end(bodyBuffer);
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});


app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Model Loader] UI: http://0.0.0.0:${PORT} -> controller: ${CONTROLLER_URL}`);
});
