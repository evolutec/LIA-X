'use strict';

const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Version du produit, source de vérité package.json. /api/version la renvoie
// telle quelle ; elle doit rester cohérente avec la version annoncée par
// l'installateur (qui la reçoit du tag via /DAppVersion).
const LIA_X_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
})();
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile } = require('child_process');
const { promisify } = require('util');

const db = require('./src/db/pool.cjs');
const { applySchema, waitForDatabase } = require('./src/db/migrate.cjs');
const conversationsRepo = require('./src/db/conversations.cjs');
const ragService = require('./src/rag/service.cjs');
const ragRepository = require('./src/rag/repository.cjs');
const ragLimits = require('./src/rag/limits.cjs');
const extractors = require('./src/rag/extractors.cjs');
const ragQueue = require('./src/rag/ingestQueue.cjs');
// Moteur de synthese vocale neuronale (Kokoro). Le require est tolerant :
// si le module est absent (installation sans la voix), le serveur demarre
// normalement et la synthese retombe sur SAPI.
// Moteur indisponible = objet neutre : la route TTS appelle toujours
// isAvailable()/synthesize(), qui deviennent sans effet, et le repli SAPI part.
let kokoroEngine = {
  isAvailable: () => false,
  synthesize: async () => { throw new Error('moteur non charge'); },
  KOKORO_DIR: '',
};
try {
  // eslint-disable-next-line global-require
  kokoroEngine = require('./src/voice/kokoro.cjs');
} catch (error) {
  console.warn('[model-manager] moteur Kokoro indisponible :', error.message);
}
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

const DOWNLOAD_JOBS = new Map(); // model -> job détaillé (voir startDownloadJob)
const DOWNLOAD_ABORTS = new Map(); // model -> AbortController (annulation utilisateur)
// Contrôleurs d'abort dédiés au mécanisme de pause : ils permettent d'interrompre
// la requête HTTP en cours sans marquer le job comme "annulé" (le .part est conservé).
const PAUSE_ABORTS = new Map();
// Les jobs terminés sont conservés un moment : l'UI affiche ainsi la fin du
// téléchargement (notification, bouton « Charger ») même après un rechargement
// de la page, et les téléchargements survivent à la fermeture de l'onglet.
const DOWNLOAD_JOB_TTL_MS = 15 * 60 * 1000;
let DOWNLOAD_JOB_SEQ = 0;

function downloadJobPublicView(job) {
  if (!job) return null;
  const total = Number(job.total_bytes) || 0;
  const received = Number(job.received_bytes) || 0;
  const paused = Boolean(job.paused);
  return {
    id: job.id,
    model: job.model,
    filename: job.filename,
    source: job.source,
    url: job.url,
    active: !job.done && !job.error && !job.cancelled && !paused,
    paused,
    paused_at: paused ? job.paused_at : null,
    total_bytes: total || null,
    received_bytes: received,
    percent: total > 0 ? Math.min(100, Math.round((received / total) * 100)) : 0,
    speed_bps: Math.round(Number(job.speed_bps) || 0),
    eta_seconds: Number.isFinite(job.eta_seconds) ? job.eta_seconds : null,
    attempts: Number(job.attempts) || 0,
    resumable: Boolean(job.resumable),
    started_at: job.started_at,
    updated_at: job.updated_at,
    finished_at: job.finished_at,
    error: job.error || null,
    retry_message: job.retry_message || null,
    done: Boolean(job.done),
    cancelled: Boolean(job.cancelled),
  };
}

// Pourcentage de progression d'un job brut. La vue publique le calcule aussi,
// mais les entrées « téléchargement partiel » de la table sont construites à
// partir du job interne (qui ne porte pas de champ percent).
function downloadPercent(job) {
  const total = Number(job?.total_bytes) || 0;
  const received = Number(job?.received_bytes) || 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.round((received / total) * 100));
}

function startDownloadJob(modelName, totalBytes, meta = {}) {
  const key = String(modelName || '').trim();
  if (!key) return null;

  const existing = DOWNLOAD_JOBS.get(key);
  if (existing && !existing.done && !existing.error && !existing.cancelled) {
    // Fusion : le job peut avoir été créé par l'endpoint HTTP (sans taille) puis
    // complété par la tâche de fond (taille réelle, URL du blob, chemin final).
    if (meta.filename) existing.filename = meta.filename;
    if (meta.storage_path) existing.storage_path = meta.storage_path;
    if (meta.url) existing.url = meta.url;
    if (meta.source) existing.source = meta.source;
    if (Number(meta.start_bytes) > 0 && !existing.received_bytes) {
      existing.received_bytes = Number(meta.start_bytes);
      existing.resumable = true;
    }
    if (Number(totalBytes) > 0) existing.total_bytes = Number(totalBytes);
    existing.updated_at = new Date().toISOString();
    return existing;
  }

  const startBytes = Number(meta.start_bytes) || 0;
  const job = {
    id: `dl-${Date.now()}-${++DOWNLOAD_JOB_SEQ}`,
    model: key,
    filename: meta.filename || `${key}.gguf`,
    source: meta.source || 'url',
    url: meta.url || '',
    storage_path: meta.storage_path || null,
    total_bytes: Number(totalBytes) > 0 ? Number(totalBytes) : null,
    received_bytes: startBytes,
    speed_bps: 0,
    eta_seconds: null,
    attempts: 0,
    resumable: startBytes > 0,
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    finished_at: null,
    error: null,
    retry_message: null,
    done: false,
    cancelled: false,
    _lastBytes: startBytes,
    _lastAt: Date.now(),
  };
  DOWNLOAD_JOBS.set(key, job);
  return job;
}

function advanceDownloadJob(modelName, receivedBytes) {
  const job = DOWNLOAD_JOBS.get(String(modelName || ''));
  if (!job) return;

  const now = Date.now();
  const total = Number(job.total_bytes) || 0;
  const received = Number(receivedBytes) || 0;
  job.received_bytes = received;
  job.updated_at = new Date().toISOString();

  const elapsedSeconds = (now - (job._lastAt || now)) / 1000;
  if (elapsedSeconds >= 0.5) {
    const delta = received - (Number(job._lastBytes) || 0);
    if (delta > 0) {
      const instantBps = delta / elapsedSeconds;
      // Moyenne glissante : évite des ETA erratiques sur un réseau irrégulier.
      job.speed_bps = job.speed_bps > 0 ? (job.speed_bps * 0.6 + instantBps * 0.4) : instantBps;
    }
    job._lastBytes = received;
    job._lastAt = now;
  }

  job.eta_seconds = (total > 0 && job.speed_bps > 0 && received < total)
    ? Math.round((total - received) / job.speed_bps)
    : null;
}

function setDownloadJobTotalBytes(modelName, totalBytes) {
  const job = DOWNLOAD_JOBS.get(String(modelName || ''));
  if (!job) return;
  const total = Number(totalBytes) || 0;
  if (total > 0) {
    job.total_bytes = total;
    if (job.received_bytes > 0) job.resumable = true;
  }
  job.updated_at = new Date().toISOString();
}

function finishDownloadJob(modelName, error, options = {}) {
  const key = String(modelName || '');
  const job = DOWNLOAD_JOBS.get(key);
  if (!job) return;

  job.finished_at = new Date().toISOString();
  job.updated_at = job.finished_at;
  DOWNLOAD_ABORTS.delete(key);

  if (options && options.cancelled) {
    job.cancelled = true;
    job.done = false;
    job.error = null;
  } else if (error) {
    job.error = String(error);
    job.done = false;
  } else {
    job.done = true;
    job.cancelled = false;
    job.error = null;
    if (job.total_bytes) job.received_bytes = job.total_bytes;
  }
  job.eta_seconds = job.done ? 0 : null;

  const timer = setTimeout(() => {
    if (DOWNLOAD_JOBS.get(key) === job) DOWNLOAD_JOBS.delete(key);
  }, DOWNLOAD_JOB_TTL_MS);
  if (timer && typeof timer.unref === 'function') timer.unref();
}

function cancelDownloadJob(modelName) {
  const key = String(modelName || '').trim();
  const controller = DOWNLOAD_ABORTS.get(key);
  if (controller && !controller.signal.aborted) {
    controller.abort(new Error("Téléchargement annulé par l'utilisateur."));
  }
  DOWNLOAD_ABORTS.delete(key);
  return Boolean(controller);
}

// Met le job en pause : interrompt la requête HTTP en cours (le .part est conservé)
// sans marquer le job comme "annulé" ou "fini". L'UI affiche alors un bouton Reprendre.
function pauseDownloadJob(modelName) {
  const key = String(modelName || '').trim();
  const job = DOWNLOAD_JOBS.get(key);
  if (!job) return false;
  if (job.done || job.error || job.cancelled || Boolean(job.paused)) return false;

  job.paused = true;
  job.paused_at = new Date().toISOString();
  job.pause_message = null;
  job.updated_at = job.paused_at;
  job.eta_seconds = null;
  job.speed_bps = 0;

  const pauseController = PAUSE_ABORTS.get(key);
  if (pauseController && !pauseController.signal.aborted) {
    pauseController.abort(new Error('Pause demandée.'));
  }
  return true;
}

// Interrompt définitivement une tâche (y compris lorsqu'elle est suspendue dans
// waitWhilePaused). Le drapeau cancelled est indispensable : supprimer le job de
// la Map ne suffit pas à empêcher une boucle déjà réveillée de créer une requête.
function stopDownloadTask(modelName) {
  const key = String(modelName || '').trim();
  const job = DOWNLOAD_JOBS.get(key);
  if (job) {
    job.cancelled = true;
    job.paused = false;
    job.paused_at = null;
    job.updated_at = new Date().toISOString();
  }
  const pauseController = PAUSE_ABORTS.get(key);
  if (pauseController && !pauseController.signal.aborted) {
    pauseController.abort(Object.assign(new Error('Téléchargement annulé par l’utilisateur.'), { cancelled: true }));
  }
  PAUSE_ABORTS.delete(key);
  return cancelDownloadJob(key);
}

async function waitForDownloadTaskToStop(modelName, timeoutMs = 15000) {
  const key = String(modelName || '').trim();
  const deadline = Date.now() + timeoutMs;
  while (DOWNLOAD_JOBS.get(key)?._taskRunning && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return !DOWNLOAD_JOBS.get(key)?._taskRunning;
}

// Relance le job depuis l'état de pause : recrée un AbortController pour la
// prochaine requête et reprend là où il s'était arrêté (start_bytes issus du .part).
function resumeDownloadJob(modelName) {
  const key = String(modelName || '').trim();
  const job = DOWNLOAD_JOBS.get(key);
  if (!job) return false;
  if (!job.paused) return false;

  job.paused = false;
  job.paused_at = null;
  job.pause_message = null;
  job.resumable = true;
  job.updated_at = new Date().toISOString();
  job.eta_seconds = null;

  PAUSE_ABORTS.delete(key);
  return true;
}

function listAllDownloadJobs() {
  return [...DOWNLOAD_JOBS.values()]
    .sort((a, b) => (Date.parse(b.started_at) || 0) - (Date.parse(a.started_at) || 0))
    .map(downloadJobPublicView);
}

async function readDownloadProgress(modelName) {
  const requestedKey = String(modelName || '').trim();
  let job = requestedKey ? DOWNLOAD_JOBS.get(requestedKey) : null;

  // L'UI peut interroger sans nom exact : on retombe sur le job le plus récent
  // pour ne jamais afficher « rien ne se passe » pendant un gros téléchargement.
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
    if (newestKey) job = DOWNLOAD_JOBS.get(newestKey);
  }

  if (!job) {
    return {
      active: false,
      model: null,
      filename: null,
      percent: 0,
      total_bytes: null,
      received_bytes: 0,
      speed_bps: 0,
      eta_seconds: null,
      error: null,
      done: false,
      cancelled: false,
    };
  }

  return downloadJobPublicView(job);
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
// Durée de validité du cache /status.
//
// Elle doit être SUPÉRIEURE à la latence réelle d'un GET /status côté
// contrôleur, sinon le cache n'est jamais réutilisé : un appel prend 0,7 à
// 2,5 s (jusqu'à plusieurs secondes en pic), donc un TTL de 2 s expirait
// systématiquement avant l'appel suivant et le cache ne servait à rien.
// Une recherche RAG enchaîne alors une dizaine de GET /status sur le contrôleur
// mono-thread, tous payants.
//
// 10 s est au-dessus de la latence observée, ce qui fait tomber une rafale de
// lectures à un seul appel réel, tout en bornant la péremption du cache.
//
// Sûr vis-à-vis de l'app : toute opération qui change l'état
// (/start, /stop, /restart) invalide explicitement le cache dans
// controllerRequest(), et les routes de chargement/selection/dechargement
// font de même. Un cache long ne peut donc pas masquer un changement
// déclenché par l'application. Seule une extinction survenue en dehors
// (crash, --sleep-idle) reste invisible au plus 10 s, et la requête
// suivante relance alors /start via ensureRuntimeReady().
const STATUS_CACHE_MAX_AGE = 10000;

const LOG_HISTORY = [];
const LOG_HISTORY_MAX = 240;
const DOCKER_SOCKET_PATH = process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
const CONTAINER_LOG_NODES = (process.env.CONTAINER_LOG_NAMES || 'anythingllm,openwebui,open-webui,librechat,lia-x')
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

// Taille maximale du corps JSON, partagée par le parseur global et la route
// d'ingestion. Doit être calculée avant app.use(...) ci-dessous.
// Dimensionnement : le plus gros fichier autorisé (64 Mo) augmenté du
// gonflement base64 (~33 %) et de l'encapsulation JSON.
const RAG_MAX_BODY = `${Math.ceil(ragLimits.MAX_REQUEST_BYTES / (1024 * 1024))}mb`;

// Le parseur JSON global est volontairement généreux. Une limite basse ici
// rejetterait le corps AVANT que les routes RAG puissent appliquer la leur, car
// ce middleware est monté avant elles. Chaque route reste libre de définir sa
// propre limite via express.json({ limit }).
app.use(express.json({ limit: RAG_MAX_BODY }));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// Champs dont la valeur n'est JAMAIS journalisée, même dans un résumé.
const LOG_SENSITIVE_KEYS = new Set([
  'content',
  'contentbase64',
  'input',
  'prompt',
  'text',
  'messages',
  'message',
  'embedding',
  // /api/rag/search reçoit la question de l'utilisateur dans `query` : sans
  // ce masque, chaque question posée via le RAG atterrissait dans docker logs
  // ET dans LOG_HISTORY (exposé par GET /api/models/status).
  'query',
  'question',
  'answer',
  'response',
  'password',
  'token',
  'secret',
  'authorization',
  'apikey',
  'api_key',
  'body',
  'data',
  'base64',
  'raw',
]);

// Résumé de forme d'un corps de requête : on conserve la STRUCTURE (utile au
// débogage : quelles routes sont appelées, avec quels champs) mais jamais les
// VALEURS. Un corps de 85 Mo (upload RAG en base64) ne doit ni être sérialisé
// ni stocké en mémoire.
function summarizePayload(payload, depth = 0) {
  if (payload === null || payload === undefined) {
    return '';
  }
  if (typeof payload === 'string') {
    return `<string ${payload.length} car.>`;
  }
  if (typeof payload !== 'object') {
    return `<${typeof payload}>`;
  }
  if (depth > 2) {
    return Array.isArray(payload) ? `<array ${payload.length}>` : '<objet>';
  }
  if (Array.isArray(payload)) {
    return `<array ${payload.length}>`;
  }
  const parts = Object.keys(payload).slice(0, 20).map((key) => {
    const lower = String(key).toLowerCase();
    if (LOG_SENSITIVE_KEYS.has(lower)) {
      return `${key}:<masque>`;
    }
    return `${key}:${summarizePayload(payload[key], depth + 1)}`;
  });
  if (parts.length === 0) {
    return '{}';
  }
  return `{${parts.join(', ')}}`;
}

// Les corps de requête ne sont PLUS journalises : ils contenaient le contenu
// integral des messages de chat et des documents RAG, et ils atterrissaient
// dans `docker logs` ET dans LOG_HISTORY, expose sans authentification par
// GET /api/models/status. Ils pouvaient en outre atteindre ~85 Mo par requete
// (upload RAG en base64) x 240 entrees retenues en RAM.
function logRequest(method, path, payload) {
  const summary = payload === undefined || payload === null ? '' : summarizePayload(payload);
  console.log('[model-manager] incoming', method, path, summary);
  pushLogEntry('server', path || 'server', 'info', `${method} ${path} ${summary}`, 'info');
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
// ═══════════════════════════════════════════════════════════════════════════
// Sécurité d'accès à l'API
// ═══════════════════════════════════════════════════════════════════════════
// Le LIA-X est publié sur 0.0.0.0:3005 et n'avait AUCUNE
// authentification : n'importe quel processus local pouvait supprimer un GGUF,
// charger un modèle, lire toutes les conversations ou redémarrer le contrôleur.
//
// Renforcement en DEUX couches, toutes deux désactivées par défaut pour ne
// rien casser :
//
//  1. Validation du header Host (anti-DNS-rebinding). Un site web peut faire
//     résoudre son nom vers 127.0.0.1 ; le navigateur enverrait alors
//     Host: attaquant.fr vers ce service. Sans CORS le navigateur ne peut pas
//     LIRE la reponse, mais la requete s'execute quand meme. En n'acceptant que
//     les Host connus, ce vecteur d'ecriture est ferme.
//     Activation : LIA_ALLOWED_HOSTS=localhost,127.0.0.1,...
//
//  2. Token d'API sur les routes /api/* MUTANTES (POST/PUT/PATCH/DELETE).
//     Volontairement NON appliqué à /v1/* : Open WebUI, AnythingLLM, LibreChat
//     et les clients OpenAI talkent à cette surface et ne/~pourraient pas
//     fournir de token sans configuration supplémentaire dans chaque conteneur.
//     Activation : LIA_API_TOKEN=1.
//
// Le token est AUTO-CONFIGURANT : généré au premier démarrage avec crypto
// (randomBytes 32 octets), persisté sur le montage partagé /models/.lia/, et
// injecté dans le HTML de la SPA (même origine uniquement, donc illisible par
// un site tiers). Aucune modification de l'installateur n'est requise.
// Supprimer le fichier fait tourner le token.
// ═══════════════════════════════════════════════════════════════════════════

const API_TOKEN_PATH = path.join(MODEL_STORAGE_DIR, '.lia', 'api-token');

function isTruthyEnv(value) {
  return !/^(0|false|off|no|)$/i.test(String(value ?? '').trim());
}

const API_TOKEN_ENFORCED = isTruthyEnv(process.env.LIA_API_TOKEN);
const ALLOWED_HOSTS = (process.env.LIA_ALLOWED_HOSTS || '')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter(Boolean);

function loadOrCreateApiToken() {
  try {
    if (fs.existsSync(API_TOKEN_PATH)) {
      const existing = String(fs.readFileSync(API_TOKEN_PATH, 'utf8') || '').trim();
      if (existing.length >= 32) {
        return existing;
      }
    }
  } catch {
    // fichier illisible : on repart d'un token neuf
  }
  const token = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(path.dirname(API_TOKEN_PATH), { recursive: true });
    fs.writeFileSync(API_TOKEN_PATH, token, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    console.warn('[model-manager] token API non persisté :', error?.message || error);
  }
  return token;
}

const API_TOKEN = loadOrCreateApiToken();

function timingSafeEquals(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length !== bufB.length || bufA.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function requestHasApiToken(req) {
  const header = req.get('x-lia-token') || req.get('x-api-token') || '';
  if (header) {
    return timingSafeEquals(header, API_TOKEN);
  }
  const queryToken = req.query && typeof req.query === 'object' ? req.query.lia_token : '';
  return queryToken ? timingSafeEquals(queryToken, API_TOKEN) : false;
}

// Host autorisés par défaut : loopback + les alias utilisés par les conteneurs
// et par le navigateur sur le poste. Une liste explicite passée via
// LIA_ALLOWED_HOSTS remplace entièrement celle-ci.
const DEFAULT_ALLOWED_HOSTS = [
  'localhost',
  '127.0.0.1',
  '[::1]',
  '::1',
  '0.0.0.0',
  'lia-x',
  'host.docker.internal',
];

function hostIsAllowed(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) {
    return true; // HTTP/1.0 sans Host : on ne casse pas ces clients
  }
  // On compare sur le nom seul, en ignorant le port.
  const hostname = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw.split(':')[0];
  const allowList = ALLOWED_HOSTS.length > 0 ? ALLOWED_HOSTS : DEFAULT_ALLOWED_HOSTS;
  return allowList.includes(hostname);
}

app.use((req, res, next) => {
  if (!hostIsAllowed(req.get('host'))) {
    res.status(421).json({ detail: 'Hôte non autorisé pour le LIA-X.' });
    return;
  }
  next();
});

// Token exigé sur les /api/* mutantes seulement. Les GET restent ouverts :
// ils ne modifient rien, et les garder lisibles préserve les usages de
// supervision (healthchecks, tableaux de bord).
app.use('/api', (req, res, next) => {
  if (!API_TOKEN_ENFORCED) {
    next();
    return;
  }
  const method = String(req.method || 'GET').toUpperCase();
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
    next();
    return;
  }
  if (requestHasApiToken(req)) {
    next();
    return;
  }
  res.status(401).json({
    detail: 'Token API absent ou invalide. Envoyez l\'en-tête X-LIA-Token.',
  });
});
const ROOCODE_SOURCE_HEADER_NAME = String(process.env.ROOCODE_SOURCE_HEADER_NAME || 'x-roocode-source').trim().toLowerCase();
const ROOCODE_SOURCE_HEADER_VALUE = String(process.env.ROOCODE_SOURCE_HEADER_VALUE || 'true').trim().toLowerCase();
const DOCKER_INTERNAL = String(process.env.DOCKER_INTERNAL || 'false').toLowerCase() === 'true';
// Le service GPU Metrics ecoute sur 13621 (config.json : ports.gpuMetrics, et
// METRICS_HOST_URL injecte par l'installateur). Le defaut 13610 etait errone :
// en cas d'absence de variable d'env, fetchHostMetrics() etait rejete et
// l'UI perdait toutes les metriques materiel.
const METRICS_HOST_URL = process.env.METRICS_HOST_URL || (DOCKER_INTERNAL ? 'http://host.docker.internal:13621' : 'http://127.0.0.1:13621');
// Délai d'attente maximal d'un POST /start vers le contrôleur.
//
// Ce délai doit être SUPÉRIEUR au plafond d'attente de démarrage du contrôleur
// (900 s), sinon le conteneur abandonne en premier et renvoie un 502 alors que
// le contrôleur, lui, attend toujours. Le modèle finit alors par démarrer côté
// llama-server, mais l'UI affiche « non chargé » : c'est le symptôme observé
// après un changement de contexte via le slider.
//
// 960 s laisse au contrôleur la place de conclure (succès ou son propre
// timeout), pour que la réponse HTTP reflète toujours la réalité.
const CONTROLLER_START_TIMEOUT_MS = Number(process.env.CONTROLLER_START_TIMEOUT_MS || '960000');
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

/**
 * Heuristique « ce FICHIER est-il un modèle d'embeddings ? ».
 *
 * ATTENTION : c'est une simple lecture du nom de fichier. Elle ne dit RIEN de
 * l'instance qui tourne : llama.cpp ne sert POST /v1/embeddings que si le
 * processus a été lancé avec --embedding (drapeau transmis par le contrôleur,
 * cf. llama-host-controller.ps1 et le champ `embedding` de chaque instance).
 *
 * Conséquence historique : /v1/models annonçait `embedding_capable: true`
 * pour nomic-embed-text alors que l'instance n'avait pas le drapeau — deux
 * informations apparemment contradictoires, dont aucune ne permettait de
 * distinguer « modèle d'embeddings » de « instance en mode embedding ».
 *
 * L'état RÉEL est désormais publié séparément via `embedding_active`
 * (instance.embedding === true, lu sur le runtime du contrôleur).
 */
function isEmbeddingDeclaredName(name) {
  const needle = String(name || '').toLowerCase();
  if (!needle) {
    return false;
  }
  return EMBEDDING_MODEL_CANDIDATES.some((candidate) => {
    const candidateLower = candidate.toLowerCase();
    return needle === candidateLower || needle.startsWith(candidateLower);
  });
}

/**
 * Décide si un FICHIER GGUF est un modèle d'embeddings, en lisant ses
 * métadonnées plutôt que son nom.
 *
 * Ordre de décision :
 *  1. `{arch}.pooling_type` présent  → embeddings (signal llama.cpp lui-même) ;
 *  2. architecture d'encodeur connue  → embeddings ;
 *  3. repli sur le nom                → embeddings (déjà utilisé, peu fiable).
 *
 * Le nom seul se trompait dans les deux sens :
 *  - faux négatif : `qwen3-embedding-0.6b` ne matchait ni `Qwen3-Embedding-4B`
 *    ni le préfixe `embed` → le modèle était considéré NON embedding, donc
 *    jamais lancé avec --embedding, donc inutilisable pour /v1/embeddings ;
 *  - faux positif : tout fichier nommé `embed*` était déclaré embedding.
 *
 * Ne leve jamais : toute erreur de lecture doit dégrader vers l'heuristique
 * nom, pas casser l'API.
 *
 * @returns {Promise<{declared: boolean, source: 'metadata'|'name'|'none'}>}
 */
async function inspectEmbeddingModel(identifier) {
  const fallback = { declared: isEmbeddingDeclaredName(identifier), source: 'name' };
  let model;
  try {
    model = await resolveModel(identifier);
  } catch {
    return { declared: fallback.declared, source: fallback.declared ? 'name' : 'none' };
  }

  try {
    const details = await getModelGgufDetails(model);
    const architecture = String(details?.architecture || '').toLowerCase();
    if (details?.pooling_type !== null && details?.pooling_type !== undefined) {
      return { declared: true, source: 'metadata' };
    }
    if (architecture && GGUF_ENCODER_ARCHITECTURES.has(architecture)) {
      return { declared: true, source: 'metadata' };
    }
  } catch {
    // Fichier illisible / GGUF corrompu : on retombe sur le nom.
    return { declared: fallback.declared, source: fallback.declared ? 'name' : 'none' };
  }

  return { declared: fallback.declared, source: fallback.declared ? 'name' : 'none' };
}

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

// Architectures GGUF d'encodeurs : modeles de transformation (bidirectionnels)
// qui produisent des vecteurs, pas des modeles de langage autocompletifs.
// C'est le signal le plus fiable pour reconnaitre un modele d'embeddings SANS
// se fier au nom du fichier (le nom se trompe : cf. qwen3-embedding-0.6b).
const GGUF_ENCODER_ARCHITECTURES = new Set([
  'bert',
  'nomic-bert',
  'jina-bert-v2',
  'neo-bert',
  't5',
  'mpt',
]);

// {arch}.pooling_type : 0=none 1=mean 2=cls 3=last 4=rank.
// C'est ce que llama.cpp regarde pour savoir qu'un modele peut produire des
// embeddings ; son absence est un signal negatif fort.
function extractPoolingType(architecture, metadataMap) {
  if (!architecture) {
    return null;
  }
  const value = metadataMap[`${architecture}.pooling_type`];
  if (Number.isInteger(value)) {
    return value;
  }
  const number = Number(value);
  return Number.isInteger(number) ? number : null;
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
    const poolingType = extractPoolingType(architecture, metadataMap);
    return {
      version,
      tensor_count: tensorCount,
      kv_count: kvCount,
      architecture,
      context_length: contextLength,
      gpu_layers: gpuLayers,
      pooling_type: poolingType,
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

  // Plafond absolu : le contexte natif du GGUF. Une valeur superieure allouerait
  // un cache KV que le modele ne peut pas remplir et ferait echouer la
  // generation ("the current context is larger than the model's context").
  // La demande explicite de l'utilisateur reste prioritaire : seule la valeur
  // issue du runtime state, qui peut dater d'une autre version, est bornee.
  const nativeContext = (Number.isInteger(details.context_length) && details.context_length > 0)
    ? details.context_length
    : null;
  const capContext = (value) => (nativeContext ? Math.min(value, nativeContext) : value);

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
      // Bornée par le recommandé en plus du contexte natif : cette valeur peut
      // dater d'une version anterieure du produit (qui renvoyait 131072 par
      // defaut) et ne reflecte donc pas necessarily un choix de l'utilisateur.
      // Mesure : ctx=74752 sur un 1,8 Go fait passer le prefill d'un historique
      // de 40 messages de ~0,6 s a ~4,2 s. Un reglage pose depuis l'onglet
      // Accueil reste couvert par la priorite 1, qui n'est pas bridée.
      payload.context = Math.min(capContext(existingInstance.context), recommended.context);
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

  // Modèle épinglé : sleep_idle_seconds = -1 omet complètement le drapeau
  // --sleep-idle-seconds côté contrôleur, donc llama-server ne décharge jamais
  // et le modèle reste intégralement en VRAM. Le contrôleur écrit aussi cette
  // valeur dans le runtime state : sa séquence de restauration relancera donc
  // le modèle dans les mêmes conditions après un redémarrage.
  const pinned = await listPinnedModels();
  if (pinned.has(model.filename)) {
    payload.sleep_idle_seconds = -1;
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

// ---------------------------------------------------------------------------
// API conversations — persistance PostgreSQL
//
// Chaque route renvoie 503 si la base est injoignable : l'interface sait alors
// distinguer « pas encore de base » d'une vraie erreur, et le chat reste
// utilisable en mémoire.
// ---------------------------------------------------------------------------

function requireDb(res) {
  if (db.isDbAvailable()) return true;
  res.status(503).json({
    detail: 'Base de données indisponible. L’historique est conservé en mémoire pour cette session.',
    database_error: db.getLastError(),
  });
  return false;
}

app.get('/api/db/health', async (req, res) => {
  const health = await db.checkConnection();
  res.json({
    available: health.available,
    error: health.error,
    // Indique à l'UI si elle doit afficher le bandeau « historique non conservé ».
    persistence: health.available,
  });
});

app.get('/api/conversations', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = await conversationsRepo.listConversations(limit);
    res.json({ conversations: rows, persistence: true });
  } catch (error) {
    err(res, 500, `Impossible de lire les conversations : ${error.message}`);
  }
});

app.post('/api/conversations', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { title, model } = req.body || {};
    const conversation = await conversationsRepo.createConversation({ title, model });
    res.status(201).json({ conversation, persistence: true });
  } catch (error) {
    err(res, 500, `Impossible de créer la conversation : ${error.message}`);
  }
});

app.get('/api/conversations/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const conversation = await conversationsRepo.getConversationWithMessages(req.params.id);
    if (!conversation) return res.status(404).json({ detail: 'Conversation introuvable' });
    res.json({ conversation, persistence: true });
  } catch (error) {
    // Un identifiant mal formé fait échouer le cast UUID : 400, pas 500.
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant de conversation invalide' });
    err(res, 500, `Impossible de lire la conversation : ${error.message}`);
  }
});

app.patch('/api/conversations/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { title, model } = req.body || {};
    if (title === undefined && model === undefined) {
      return res.status(400).json({ detail: 'Aucun champ à mettre à jour' });
    }
    if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
      return res.status(400).json({ detail: 'Titre invalide' });
    }
    if (model !== undefined && typeof model !== 'string') {
      return res.status(400).json({ detail: 'Modèle invalide' });
    }
    // Le nom de modèle n'est pas une donnée sensible : c'est un identifiant
    // choisi dans une liste fermée par l'UI. On le persiste malgré tout
    // paramétré, comme tout le reste.
    const updated = title === undefined
      ? (await conversationsRepo.setConversationModel(req.params.id, model || null))
      : (await conversationsRepo.renameConversation(req.params.id, title.trim().slice(0, 200)));
    if (!updated) return res.status(404).json({ detail: 'Conversation introuvable' });
    res.json({ conversation: updated, persistence: true });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant de conversation invalide' });
    err(res, 500, `Impossible de renommer la conversation : ${error.message}`);
  }
});

app.delete('/api/conversations/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const deleted = await conversationsRepo.deleteConversation(req.params.id);
    if (!deleted) return res.status(404).json({ detail: 'Conversation introuvable' });
    res.json({ deleted: true, persistence: true });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant de conversation invalide' });
    err(res, 500, `Impossible de supprimer la conversation : ${error.message}`);
  }
});

app.post('/api/conversations/:id/messages', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { role, content, reasoning, model, error: messageError } = req.body || {};
    if (!['user', 'assistant', 'system'].includes(role)) {
      return res.status(400).json({ detail: 'Rôle invalide (user, assistant ou system attendu)' });
    }
    if (typeof content !== 'string') {
      return res.status(400).json({ detail: 'Contenu invalide' });
    }
    const message = await conversationsRepo.addMessage(req.params.id, {
      role,
      content,
      reasoning: typeof reasoning === 'string' ? reasoning : null,
      model: typeof model === 'string' ? model : null,
      error: typeof messageError === 'string' ? messageError : null,
    });
    res.status(201).json({ message, persistence: true });
  } catch (error) {
    // 23503 = violation de clé étrangère : la conversation n'existe pas.
    if (error.code === '23503') return res.status(404).json({ detail: 'Conversation introuvable' });
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant de conversation invalide' });
    err(res, 500, `Impossible d’enregistrer le message : ${error.message}`);
  }
});

app.delete('/api/messages/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const deleted = await conversationsRepo.deleteMessage(req.params.id);
    if (!deleted) return res.status(404).json({ detail: 'Message introuvable' });
    res.json({ deleted: true, persistence: true });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant de message invalide' });
    err(res, 500, `Impossible de supprimer le message : ${error.message}`);
  }
});

// ---------------------------------------------------------------------------
// API RAG — ingestion asynchrone et recherche vectorielle
// ---------------------------------------------------------------------------

// L'ingestion passe par JSON en base64 plutôt que par multipart : cela évite une
// dépendance (multer) et une surface d'attaque inutile sur un endpoint local.
// La limite RAG_MAX_BODY est définie plus haut, car le parseur global en dépend.

function handleRagError(res, error) {
  const message = String(error?.message || error);
  // Corps JSON au-delà de la limite : c'est un fichier trop gros, pas une panne.
  if (error.type === 'entity.too.large' || error.status === 413) {
    return res.status(413).json({
      detail: `Fichier trop volumineux pour le transport (maximum ${ragService.formatBytes(ragLimits.MAX_FILE_BYTES)} par fichier).`,
    });
  }
  // Erreurs métier attendues : on renvoie 400 avec un message utilisable.
  if (/introuvable| vide| illisible| trop volumineux| maximum | incohérent| non pris en charge| invalide| sans couche texte| mot de passe| aucun texte| exploitable| fragments/i.test(message)) {
    return res.status(400).json({ detail: message });
  }
  // Modèle d'embeddings indisponible ou dimensions inattendues : problème de
  // configuration, pas de saisie.
  if (/dimension|embedding|Timeout|timeout/i.test(message)) {
    return res.status(503).json({ detail: `Modèle d’embeddings indisponible : ${message}` });
  }
  return err(res, 500, message);
}

app.get('/api/rag/status', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const folders = await ragRepository.listFolders();
    res.json({
      available: true,
      // Dimension RÉELLE de la colonne pgvector, lue en base : elle suit le
      // modèle d'embeddings choisi et peut avoir été alignée automatiquement
      // lors d'une ingestion (cf. ensureVectorDimensions). Annoncer une
      // constante 768 était faux dès que l'utilisateur changeait de modèle.
      embeddingDimensions: await ragRepository.getEmbeddingDimension(),
      maxFileBytes: ragLimits.MAX_FILE_BYTES,
      maxDocumentChars: ragLimits.MAX_DOCUMENT_CHARS,
      maxChunks: ragLimits.MAX_CHUNKS_PER_DOCUMENT,
      // L'interface s'en sert pour le accept="..." du champ fichier : la liste
      // reste ainsi alignée sur ce que le serveur sait réellement extraire.
      supportedExtensions: extractors.SUPPORTED_EXTENSIONS,
      // Un PDF scanné n'a pas de couche texte ; l'OCR n'est appliqué qu'aux
      // images. L'interface doit pouvoir l'expliquer avant l'échec.
      ocrExtensions: extractors.IMAGE_EXTENSIONS,
      folders,
      totalChunks: await ragRepository.countChunks(null),
    });
  } catch (error) {
    handleRagError(res, error);
  }
});

app.get('/api/rag/folders', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json({ folders: await ragRepository.listFolders() });
  } catch (error) {
    handleRagError(res, error);
  }
});

/**
 * Contenu d'un dossier : sous-dossiers et fichiers.
 *
 * Sans `folder`, la requête renvoie la racine (dossiers de premier niveau) et
 * une liste de fichiers vide. C'est ce que l'explorateur affiche à l'ouverture.
 */
app.get('/api/rag/folders/contents', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { folders, files } = await ragRepository.listFolderContents(
      req.query.folder || null,
    );
    // Le fil d'Ariane n'a de sens que pour un dossier réel : à la racine il est
    // vide, et le frontend affiche alors simplement « Mes fichiers ».
    const ancestors = req.query.folder
      ? await ragRepository.listFolderAncestors(req.query.folder)
      : [];
    res.json({ folders, files, ancestors });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

/** Espaces de travail auxquels un dossier est rattaché (menu contextuel). */
app.get('/api/rag/folders/:id/workspaces', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const folder = await ragRepository.getFolder(req.params.id);
    if (!folder) return res.status(404).json({ detail: 'Dossier introuvable' });
    res.json({ workspaces: await ragRepository.listFolderWorkspaces(req.params.id) });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

app.post('/api/rag/folders', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { name, description, parentId } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ detail: 'Nom de dossier requis' });
    }
    const trimmed = name.trim().slice(0, 200);

    // Le parent doit exister : un parent fantôme créerait un dossier invisible
    // dans l'explorateur, que rien ne pourrait retrouver.
    if (parentId) {
      const parent = await ragRepository.getFolder(parentId);
      if (!parent) return res.status(400).json({ detail: 'Dossier parent introuvable' });
    }
    // Unicité vérifiée dans l'application : le nom n'est unique que parmi les
    // frères, ce qu'une contrainte SQL globale n'exprimerait pas.
    if (await ragRepository.isDuplicateName({ name: trimmed, parentId })) {
      return res.status(409).json({ detail: 'Un dossier portant ce nom existe déjà ici' });
    }

    const folder = await ragRepository.createFolder({
      name: trimmed,
      description: typeof description === 'string' ? description.slice(0, 1000) : null,
      parentId: parentId || null,
    });
    res.status(201).json({ folder });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ detail: 'Un dossier portant ce nom existe déjà ici' });
    }
    handleRagError(res, error);
  }
});

/** Renomme et/ou déplace un dossier. */
app.patch('/api/rag/folders/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { name, parentId } = req.body || {};
    const folder = await ragRepository.getFolder(req.params.id);
    if (!folder) return res.status(404).json({ detail: 'Dossier introuvable' });

    if (typeof name === 'string' && name.trim()) {
      const trimmed = name.trim().slice(0, 200);
      const targetParent = parentId === undefined ? folder.parent_id : (parentId || null);

      if (await ragRepository.isDuplicateName({
        name: trimmed, parentId: targetParent, excludeId: folder.id,
      })) {
        return res.status(409).json({ detail: 'Un dossier portant ce nom existe déjà ici' });
      }
      await ragRepository.renameFolder(folder.id, trimmed);
    }

    if (parentId !== undefined) {
      const target = parentId || null;
      if (target) {
        const parent = await ragRepository.getFolder(target);
        if (!parent) return res.status(400).json({ detail: 'Dossier parent introuvable' });
        // Déplacer un dossier dans lui-même ou dans l'un de ses descendants
        // créerait une boucle infinie dans l'explorateur.
        if (await ragRepository.wouldCreateCycle(folder.id, target)) {
          return res.status(400).json({ detail: 'Un dossier ne peut pas contenir lui-même' });
        }
      }
      await ragRepository.moveFolder(folder.id, target);
    }

    res.json({ folder: await ragRepository.getFolder(folder.id) });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    if (error.code === '23505') {
      return res.status(409).json({ detail: 'Un dossier portant ce nom existe déjà ici' });
    }
    handleRagError(res, error);
  }
});

app.delete('/api/rag/folders/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const deleted = await ragRepository.deleteFolder(req.params.id);
    if (!deleted) return res.status(404).json({ detail: 'Folder introuvable' });
    res.json({ deleted: true });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

app.get('/api/rag/files', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const files = await ragRepository.listDocuments(req.query.folder || null);
    res.json({ files });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

// L'ingestion est asynchrone : la route enregistre le fichier et répond
// immédiatement (202). Indexer un file de 20 Mo demande plusieurs minutes
// de calcul de vecteurs ; le faire pendant la requête bloquerait le navigateur
// et finirait par expirer. La progression se lit sur /api/rag/files.
app.post('/api/rag/files', express.json({ limit: RAG_MAX_BODY }), async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { folderId, content, contentBase64, fileName, title } = req.body || {};
    if (typeof folderId !== 'string' || !folderId) {
      return res.status(400).json({ detail: 'folderId requis' });
    }
    // Le dossier doit exister : sinon le travail échouerait en arrière-plan
    // sans que l'utilisateur puisse corriger quoi que ce soit.
    const folder = await ragRepository.getFolder(folderId);
    if (!folder) {
      return res.status(400).json({ detail: 'Folder introuvable' });
    }

    // Tout le reste se passe dans la file : enqueueDocument lève encore pour les
    // erreurs immédiates (format non supporté, fichier trop gros), ce qui est
    // justement ce que l'utilisateur doit voir tout de suite.
    const file = await ragQueue.enqueueDocument({
      folderId, content, contentBase64, fileName, title,
    });

    res.status(202).json({ file, queue: ragQueue.getQueueState() });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant de folder invalide' });
    handleRagError(res, error);
  }
});

/** Demande l'annulation de l'indexation en cours. */
app.post('/api/rag/cancel', async (req, res) => {
  if (!requireDb(res)) return;
  res.json({ cancelled: ragQueue.cancelCurrent() });
});

/** État de la file : travaille en cours et files non terminés. */
app.get('/api/rag/queue', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json({
      ...ragQueue.getQueueState(),
      files: await ragRepository.listUnfinishedDocuments(),
    });
  } catch (error) {
    handleRagError(res, error);
  }
});

// ---------------------------------------------------------------------------
// Espaces de travail
//
// Un espace regroupe des conversations et des dossiers de files. Les
// files se rattachent ici, une fois pour toutes les conversations de
// l'espace : c'est la différence avec le modèle précédent, où il fallait
// cocher les mêmes dossiers dans chaque chat.
// ---------------------------------------------------------------------------

app.get('/api/workspaces', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    res.json({ workspaces: await ragRepository.listWorkspaces() });
  } catch (error) {
    handleRagError(res, error);
  }
});

app.post('/api/workspaces', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { name, description } = req.body || {};
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ detail: 'Nom d’espace de travail requis' });
    }
    const workspace = await ragRepository.createWorkspace({
      name: name.trim().slice(0, 200),
      description: typeof description === 'string' ? description.slice(0, 1000) : null,
    });
    res.status(201).json({ workspace });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ detail: 'Un espace de travail porte déjà ce nom' });
    }
    handleRagError(res, error);
  }
});

app.get('/api/workspaces/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const workspace = await ragRepository.getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ detail: 'Espace de travail introuvable' });
    res.json({
      workspace,
      folders: await ragRepository.getWorkspaceFolders(req.params.id),
      conversations: await ragRepository.listConversationsByWorkspace(req.params.id),
    });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

app.delete('/api/workspaces/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const deleted = await ragRepository.deleteWorkspace(req.params.id);
    if (!deleted) return res.status(404).json({ detail: 'Espace de travail introuvable' });
    res.json({ deleted: true });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

/** Folders rattachées à un espace. */
app.put('/api/workspaces/:id/folders', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const workspace = await ragRepository.getWorkspace(req.params.id);
    if (!workspace) return res.status(404).json({ detail: 'Espace de travail introuvable' });

    const { folderIds } = req.body || {};
    if (!Array.isArray(folderIds)) {
      return res.status(400).json({ detail: 'folderIds doit être un tableau' });
    }
    const known = await ragRepository.listFolders();
    const knownIds = new Set(known.map((folder) => folder.id));
    const valid = folderIds.filter((id) => knownIds.has(id));
    res.json({ folderIds: await ragRepository.setWorkspaceFolders(req.params.id, valid) });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

/** Rattache (ou détache) une conversation d'un espace. */
app.put('/api/conversations/:id/workspace', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const conversation = await conversationsRepo.getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ detail: 'Conversation introuvable' });

    const { workspaceId } = req.body || {};
    if (workspaceId) {
      const workspace = await ragRepository.getWorkspace(workspaceId);
      if (!workspace) return res.status(400).json({ detail: 'Espace de travail introuvable' });
    }
    res.json({ conversation: await ragRepository.setConversationWorkspace(req.params.id, workspaceId) });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

/** Folders effectivement utilisées par une conversation.
 *
 *  Résolution = union des dossiers de son espace et de sa sélection propre.
 *  La sélection directe reste possible pour un chat ponctuel, et l'union évite
 *  qu'une conversation perde ses files au moment où on la rattache à un
 *  espace.
 */
app.get('/api/conversations/:id/folders', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const conversation = await conversationsRepo.getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ detail: 'Conversation introuvable' });

    const direct = await ragRepository.getConversationFolders(req.params.id);
    const fromWorkspace = conversation.workspace_id
      ? (await ragRepository.getWorkspaceFolders(conversation.workspace_id)).map((c) => c.id)
      : [];
    res.json({ folderIds: [...new Set([...direct, ...fromWorkspace])] });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

/** Remplace la sélection directe d'une conversation. */
app.put('/api/conversations/:id/folders', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const conversation = await conversationsRepo.getConversation(req.params.id);
    if (!conversation) return res.status(404).json({ detail: 'Conversation introuvable' });

    const { folderIds } = req.body || {};
    if (!Array.isArray(folderIds)) {
      return res.status(400).json({ detail: 'folderIds doit être un tableau' });
    }
    // Un dossier supprimé entre-temps ne doit pas bloquer toute la
    // sélection : on ne conserve que celles qui existent encore.
    const known = await ragRepository.listFolders();
    const knownIds = new Set(known.map((folder) => folder.id));
    const valid = folderIds.filter((id) => knownIds.has(id));

    const saved = await ragRepository.setConversationFolders(req.params.id, valid);
    res.json({ folderIds: saved });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

app.delete('/api/rag/files/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const deleted = await ragRepository.deleteDocument(req.params.id);
    if (!deleted) return res.status(404).json({ detail: 'File introuvable' });
    res.json({ deleted: true });
  } catch (error) {
    if (error.code === '22P02') return res.status(400).json({ detail: 'Identifiant invalide' });
    handleRagError(res, error);
  }
});

app.post('/api/rag/search', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { query: question, folderIds, limit, minSimilarity } = req.body || {};
    if (typeof question !== 'string' || !question.trim()) {
      return res.status(400).json({ detail: 'Question requise' });
    }
    const folders = Array.isArray(folderIds) ? folderIds.filter((id) => typeof id === 'string') : [];
    const passages = await ragService.search(question, {
      folderIds: folders,
      limit,
      minSimilarity,
    });
    res.json({
      passages,
      context: ragService.buildContextBlock(passages),
    });
  } catch (error) {
    handleRagError(res, error);
  }
});

// `index: false` est INDISPENSABLE : sans lui, express.static sert
// dist/index.html pour « / » et intercepte la requete AVANT d'atteindre
// app.get('*'), qui est le handler capable d'injecter le token dans la SPA.
// Les assets (/assets/*.js, *.css) restent servis normalement.
app.use(express.static(path.join(__dirname, 'dist'), { index: false }));

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

/**
 * Trace d'une tentative d'appel au contrôleur.
 *
 * Objectif : distinguer les trois sources de lenteur qui se ressemblent
 * depuis l'extérieur — un chargement de modèle long, un délai dépassé, ou
 * des retries en cascade. Sans la durée par tentative, une attente de
 * plusieurs minutes observée en API ne permet aucune conclusion.
 *
 * Activé par CONTROLLER_TRACE (défaut : actif). La variable d'environnement
 * permet de le couper en production sans redéployer.
 */
const CONTROLLER_TRACE = !String(process.env.CONTROLLER_TRACE || '1').match(/^(0|false|off)$/i);

function traceControllerAttempt(event, endpoint, attempt, maxRetries, extra = {}) {
  if (!CONTROLLER_TRACE) return;
  const elapsed = extra.elapsedMs !== undefined ? ` elapsed=${extra.elapsedMs}ms` : '';
  const line = `[ctrl-trace] ${event} ${endpoint} attempt=${attempt + 1}/${maxRetries + 1}${elapsed}`
    + (extra.detail ? ` detail=${extra.detail}` : '');
  // console.log : visible dans `docker logs lia-x`.
  console.log(line);
  // pushLogEntry : visible dans /api/models/status, donc depuis l'interface.
  pushLogEntry('controller-trace', endpoint, event === 'ok' ? 'info' : 'warn', line);
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
    // Horodatage de la tentative : c'est la durée par tentative qui manque
    // pour expliquer une attente de plusieurs minutes côté API.
    const attemptStartedAt = Date.now();
    traceControllerAttempt('start', endpoint, attempt, maxRetries, {
      detail: `timeout=${effectiveTimeout}ms`,
    });

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
        // Détecter l'erreur spécifique System.Folders.Hashtable
        if (text.includes('System.Folders.Hashtable') && text.includes('Keys must be strings')) {
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
        traceControllerAttempt('http-error', endpoint, attempt, maxRetries, {
          elapsedMs: Date.now() - attemptStartedAt,
          detail: `http=${response.status} retryable=${retryableHttp} body=${String(detail).slice(0, 100)}`,
        });
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
      traceControllerAttempt('ok', endpoint, attempt, maxRetries, {
        elapsedMs: Date.now() - attemptStartedAt,
        detail: `http=${response.status}`,
      });

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
      // Un AbortError vient soit du timeout, soit d'une annulation externe. On
      // les distingue : le timeout est le symptôme clé d'un contrôleur bloqué,
      // une annulation ne doit pas se lire comme une panne du runtime.
      const aborted = error?.name === 'AbortError';
      const wasTimeout = aborted && !controller.signal.reason;
      traceControllerAttempt(wasTimeout ? 'timeout' : 'error', endpoint, attempt, maxRetries, {
        elapsedMs: Date.now() - attemptStartedAt,
        detail: `${error?.name || 'Error'}: ${String(error?.message || error).slice(0, 120)}`,
      });
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

// Configuration runtime écrite par le détecteur matériel (installateur .exe ou
// scripts/lia.ps1) : backend retenu, binaire validé, capacités réellement
// détectées (cuda/rocm/vulkan/cpu) et mémoire GPU. Le dossier runtime est monté
// en lecture seule dans le conteneur, donc l'UI lit la détection de l'hôte.
async function readRuntimeConfig() {
  try {
    const raw = await fs.promises.readFile(RUNTIME_CONFIG_PATH, 'utf8');
    return parseJsonFileContent(raw);
  } catch {
    return null;
  }
}

// Diagnostic matériel prêt à afficher : aucune valeur n'est inventée, tout vient
// de la détection réelle de l'hôte.
function buildHardwareDiagnostic(runtimeConfig, hardwareProfile) {
  const config = runtimeConfig || {};
  const profile = hardwareProfile || {};
  const memory = config.gpu_memory || profile?.gpu?.memory || null;
  const toGb = (bytes) => (Number.isFinite(Number(bytes))
    ? Number((Number(bytes) / (1024 ** 3)).toFixed(2))
    : null);

  return {
    backend: config.backend || null,
    backend_label: config.backend_label || null,
    recommended_backend: config.recommended_backend || null,
    proven_backends: Array.isArray(config.proven_backends) ? config.proven_backends : [],
    fallback_reason: config.plan_fallback_reason || null,
    capabilities: config.capabilities || null,
    binary_path: config.binary_path || null,
    binary_validated: config.binary_validated === true,
    binary_version: config.binary_version || null,
    binary_validated_at: config.binary_validated_at || null,
    binary_error: config.binary_error || null,
    gpu_memory: memory,
    gpu_memory_gb: memory
      ? {
        dedicated: toGb(memory.dedicated_bytes),
        unified: toGb(memory.unified_bytes),
        usable: toGb(memory.usable_bytes),
        is_unified: Boolean(memory.is_unified),
        source: memory.source || null,
      }
      : null,
    gpu: profile.gpu || null,
    cpu: profile.cpu || null,
    memory: profile.memory || null,
    os: profile.os || null,
    models_dir: config.models_dir || null,
    hardware_detected_at: config.hardware_detected_at || null,
    profile_generation: profile.generation_count || null,
  };
}

function getRecommendedRuntimeDefaults(hardwareProfile) {
  // Valeur de DERNIER RECOURS, employee uniquement quand l'utilisateur n'a
  // rien choisi ET qu'aucune instance memoire ne fournit de contexte (voir
  // l'ordre de priorite de buildModelStartRequest).
  //
  // Elle doit rester SAGESSE, pas ambitieuse : --ctx-size alloue un cache KV
  // proportionnel au contexte, et ce cache commande le temps de demarrage ET
  // le traitement du prompt. Mesure sur cette machine (Arc 140V, 16 Go
  // partages) : ctx=8192 demarre en ~45 s la ou ctx=109568 demande ~195 s, et
  // le prefill d'un historique de 40 messages passe de ~0,6 s a ~4,2 s.
  //
  // 131072 (ancienne valeur) transformait donc chaque premier lancement en
  // plein chargement de 75 a 98k de contexte, sans que l'utilisateur l'ait
  // demande. La valeur reste identique a default_context du controleur, donc
  // c'est le comportement nominal du produit, et non une restriction de plus.
  //
  // Le choix explicite de l'utilisateur reste prioritaire et n'est jamais
  // bride ici : un contexte superieur se regle depuis l'onglet Modèles.
  return {
    backend: 'cpu',
    context: 8192,
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
  // présentées comme « le modèle principal » du lia-x LIA-X.
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

// Les mesures du controller hôte arrivent en JSON : on ne retient qu'une valeur
// strictement positive (null = mesure indisponible ; 0 = rien à afficher).
function toPositiveNumberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
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
    .map((instance) => {
      // VRAM affichée par l'UI, par ordre de fiabilité :
      //   1. gpu_memory_bytes    → ce que Windows attribue réellement au
      //      processus llama-server.exe (compteurs « GPU Process Memory », lus
      //      par le controller hôte : fiable en Vulkan/CUDA/ROCm, y compris sur
      //      iGPU où la mémoire est partagée avec la RAM système) ;
      //   2. estimated_vram_bytes → estimation fournie par le state, si présente ;
      //   3. process_memory_bytes → WorkingSet du processus (backend CPU, où les
      //      poids vivent bien dans la mémoire du process).
      const gpuMemoryBytes = toPositiveNumberOrNull(instance.gpu_memory_bytes);
      const estimatedVramBytes = toPositiveNumberOrNull(instance.estimated_vram_bytes);
      const processMemoryBytes = toPositiveNumberOrNull(instance.process_memory_bytes);
      const sizeVram = gpuMemoryBytes ?? estimatedVramBytes ?? processMemoryBytes ?? null;
      const sizeVramSource = gpuMemoryBytes
        ? 'gpu-process'
        : estimatedVramBytes
          ? 'estimate'
          : processMemoryBytes
            ? 'process-ram'
            : null;

      return {
        id: instance.model || instance.proxy_id || `${PROXY_MODEL_ID}-${instance.port}`,
        model: instance.model,
        filename: instance.filename,
        port: instance.port,
        pid: instance.pid ?? null,
        running: Boolean(instance.running),
        size_vram: sizeVram,
        size_vram_source: sizeVramSource,
        process_memory_bytes: processMemoryBytes,
        peak_process_memory_bytes: toPositiveNumberOrNull(instance.peak_process_memory_bytes),
        gpu_memory_bytes: gpuMemoryBytes,
        gpu_memory_dedicated_bytes: toPositiveNumberOrNull(instance.gpu_memory_dedicated_bytes),
        gpu_memory_shared_bytes: toPositiveNumberOrNull(instance.gpu_memory_shared_bytes),
        context_length: Number.isFinite(Number(instance.context)) ? Number(instance.context) : null,
        expires_at: instance.started_at || null,
        active: activeModel ? instance.model === activeModel : Boolean(instance.active),
        // Drapeau réel --embedding transmis par le contrôleur au lancement.
        // C'est le SEUL indicateur fiable : `embedding_declared` (heuristique
        // sur le nom du fichier) ne dit rien de l'instance qui tourne.
        embedding: instance.embedding === true,
      };
    })
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
      size_vram_source: null,
      expires_at: runtime?.started_at || null,
      active: true,
      // Repli sur un runtime sans `instances` : l'état du drapeau est inconnu,
      // donc on ne l'invente pas (false ≠ « démarré sans --embedding », mais on
      // n'a aucune preuve du contraire : le client doit recharger le modèle).
      embedding: runtime?.embedding === true,
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

// ─────────────────────────────────────────────────────────────────────────────
// Code mort retiré
// ─────────────────────────────────────────────────────────────────────────────
// getCpuSnapshot() / LAST_CPU_SNAPSHOT / computeCpuUsage() / probeGpuInfo() /
// runCommand() n'étaient plus appelés nulle part. probeGpuInfo interrogeait
// `lspci`, qui n'existe pas sur Windows : ce chemin était mort depuis le
// portage, et sa présence laissait croire à une détection GPU active alors que
// la vraie source est hardware-profile.json + getRuntimeGpuFallback.
// runCommand n'était utilisé que par probeGpuInfo, computeCpuUsage que par
// getCpuSnapshot : le bloc était donc entièrement auto-contenu.
// Conservé ici : getRuntimeGpuFallback() (utilisé), plus bas.
//
// ─────────────────────────────────────────────────────────────────────────────
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

  // Cas particulier embeddings : /v1/embeddings n'est servi QUE par une
  // instance lancée avec --embedding. Si le modèle demandé est déjà actif mais
  // ne tourne pas dans ce mode, il faut quand même rappeler le contrôleur avec
  // embedding=true, faute de quoi llama-server répond 501. On force donc un
  // passage par /start dès que l'option embedding est demandée.
  const needsEmbeddingRestart = Boolean(options.embedding)
    && preferredModel
    && preferredModel === activeModel
    && runtimeStatus?.running;

  if (preferredModel && preferredModel !== PROXY_MODEL_ID && (preferredModel !== activeModel || needsEmbeddingRestart)) {
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

  // Passe 1 — métadonnées GGUF : signal fiable, détecte les modèles dont le
  // nom ne dit rien (qwen3-embedding-0.6b, bge-m3, gte-base…).
  for (const item of localModels) {
    const inspect = await inspectEmbeddingModel(item.name);
    if (inspect.source === 'metadata') {
      return item.name;
    }
  }

  // Passe 2 — repli historique sur le nom, dans l'ordre de la liste.
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

/**
 * Etat de l'instance d'embeddings, pour le diagnostic du 501/404 upstream.
 * Ne leve jamais : un diagnostic ne doit pas masquer l'erreur d'origine.
 */
async function describeEmbeddingState(modelName) {
  const fallback = { model: modelName || null, port: null, loaded: false, embedding: false };
  try {
    const preference = await readEmbeddingModelPreference();
    const target = modelName || preference;
    if (!target) {
      return fallback;
    }
    const instance = await resolveEmbeddingModelInstance(target);
    return {
      model: target,
      port: instance?.port ?? null,
      loaded: Boolean(instance),
      embedding: instance?.embedding === true,
    };
  } catch {
    return fallback;
  }
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

/**
 * Autorise-t-on cette URL pour un téléchargement de modèle ?
 *
 * Le endpoint accepte une URL fournie par l'utilisateur : sans contrainte,
 * c'est un SSRF — le serveur peut être utilisé pour sonder le réseau local ou
 * les métadonnées cloud (169.254.169.254) depuis la machine de l'utilisateur.
 *
 * On impose donc :
 *  - un protocole http/https (pas de file:, gopher:, ftp:) ;
 *  - un hôte PUBLIC (on rejette loopback, RFC1918, link-local, .local) ;
 *  - un port standard ou explicitement autorisé.
 *
 * L'extension .gguf reste exigée : ce n'est pas une protection (n'importe quel
 * chemin peut se terminer par .gguf), c'est une commodité de saisie.
 */
function ensureGgufUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return false;
  if (!/\.gguf(?:[?#].*)?$/i.test(raw)) return false;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // Port implicite uniquement : un port exotique sur un hôte public est un
  // signal d'abus (scan de services tiers via le poste de l'utilisateur).
  if (parsed.port && !['', '80', '443', '8080', '8443'].includes(parsed.port)) {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  // Nom d'hôte SANS point (« printer », « internal-svc ») : il ne peut pas
  // désigner un hôte public, et Windows le résout via le domaine de recherche
  // vers un hôte du réseau local. On l'exige donc.
  if (!host.includes('.') && !host.includes(':')) {
    return false;
  }
  // IPv4 réservées : loopback, lien-local (169.254.x = métadonnées cloud),
  // RFC1918, CGNAT, multicast, 0.0.0.0.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    const octets = host.split('.').map(Number);
    if (octets.some((octet) => octet > 255)) return false;
    const [a, b] = octets;
    if (a === 0 || a === 127 || a >= 224) return false;
    if (a === 10 || (a === 192 && b === 168)) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 169 && b === 254) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  // IPv6 : loopback, unspecified, unique-local (fc00::/7), link-local (fe80::/10).
  if (host === '::1' || host === '::' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) {
    return false;
  }

  return true;
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

// ─────────────────────────────────────────────────────────────────────────────
// Téléchargement robuste (Hugging Face / Ollama / URL GGUF directe)
//   - écriture dans <fichier>.gguf.part puis renommage atomique : aucun .gguf
//     tronqué ne peut apparaître dans la liste des modèles
//   - reprise automatique via « Range: bytes=<déjà reçu>- » (le CDN HF et le
//     registry Ollama acceptent les requêtes partielles)
//   - plusieurs tentatives avec backoff + détection de flux bloqué
//   - progression réelle : octets reçus, total, vitesse, ETA, annulation
// ─────────────────────────────────────────────────────────────────────────────
const DOWNLOAD_MAX_ATTEMPTS = 6;
const DOWNLOAD_STALL_TIMEOUT_MS = 90 * 1000;
const DOWNLOAD_CONNECT_TIMEOUT_MS = 60 * 1000;

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

function downloadAuthHeaders(url, token) {
  const explicit = String(token || '').trim();
  if (explicit) return { Authorization: `Bearer ${explicit}` };
  const envToken = String(process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || '').trim();
  if (envToken && /huggingface\.co|hf\.co/i.test(String(url || ''))) {
    return { Authorization: `Bearer ${envToken}` };
  }
  return {};
}

// fetch + délai de connexion + propagation d'un signal externe (annulation).
async function fetchWithTimeout(url, init = {}, timeoutMs = DOWNLOAD_CONNECT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    const timeoutError = new Error('Délai de connexion dépassé');
    timeoutError.name = 'TimeoutError';
    controller.abort(timeoutError);
  }, timeoutMs);
  if (timer && typeof timer.unref === 'function') timer.unref();

  const external = init.signal;
  const onExternalAbort = () => controller.abort(external?.reason);
  if (external) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    if (external && typeof external.removeEventListener === 'function') {
      external.removeEventListener('abort', onExternalAbort);
    }
  }
}

async function fileSizeOrNull(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.size;
  } catch {
    return null;
  }
}

// Taille distante (HEAD) : permet de reprendre un transfert interrompu et de
// répondre « déjà téléchargé » sans relancer plusieurs Go de téléchargement.
async function remoteContentLength(url, headers = {}) {
  try {
    const response = await fetchWithTimeout(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: { 'User-Agent': 'LIA-X/2.0', ...headers },
    });
    if (!response.ok) return null;
    const length = Number(parseInt(response.headers.get('content-length') || '0', 10));
    const linked = Number(parseInt(response.headers.get('x-linked-size') || '0', 10));
    return length || linked || null;
  } catch {
    return null;
  }
}

function computeTargetFilename(url, name) {
  const rawBase = String(name || filenameFromUrl(url)).trim();
  const safeBase = path.basename(rawBase) || filenameFromUrl(url);
  const normalizedBase = safeBase.trim();
  if (!normalizedBase) {
    throw new Error('Nom de fichier invalide pour le téléchargement.');
  }
  return normalizedBase.toLowerCase().endsWith('.gguf') ? normalizedBase : `${normalizedBase}.gguf`;
}

// Détermine le fichier cible, gère le fichier partiel et la reprise.
async function prepareDownloadTarget(url, name, options = {}) {
  await fs.promises.mkdir(MODEL_STORAGE_DIR, { recursive: true });

  const targetFilename = computeTargetFilename(url, name);
  const targetPath = path.join(MODEL_STORAGE_DIR, targetFilename);
  const partPath = `${targetPath}.part`;

  const headers = downloadAuthHeaders(url, options.token);
  const remoteTotalBytes = await remoteContentLength(url, headers);
  const existingSize = await fileSizeOrNull(targetPath);

  if (existingSize !== null && existingSize > 0) {
    if (!remoteTotalBytes || existingSize >= remoteTotalBytes) {
      throw new Error(`Le fichier existe déjà : ${targetFilename}`);
    }
    // Fichier final incomplet (échec d'une version précédente) : on reprend.
    await fs.promises.rename(targetPath, partPath).catch(() => {});
  } else if (existingSize === 0) {
    await fs.promises.rm(targetPath, { force: true }).catch(() => {});
  }

  return { targetFilename, targetPath, partPath, headers, remoteTotalBytes };
}

// Attend la fin d'une pause demandée depuis l'UI. Une pause n'est PAS un échec
// réseau : elle ne consomme aucune tentative et ne doit jamais faire sortir le
// job de DOWNLOAD_JOBS (sinon l'UI perd la ligne et le bouton « Reprendre »).
async function waitWhilePaused(jobKey) {
  for (;;) {
    const job = DOWNLOAD_JOBS.get(jobKey);
    if (!job) return;
    if (job.cancelled) throw Object.assign(new Error('Téléchargement annulé.'), { cancelled: true });
    if (!job.paused) {
      job.pause_message = null;
      return;
    }
    await sleep(500);
  }
}

// Télécharge (ou reprend) une URL vers targetPath en publiant la progression.
async function streamUrlToFile({ url, targetPath, partPath, jobKey, headers = {}, jobTotalBytes = null }) {
  let written = (await fileSizeOrNull(partPath)) || 0;
  let totalBytes = Number(jobTotalBytes) || 0;
  let lastError = null;

  for (let attempt = 1; attempt <= DOWNLOAD_MAX_ATTEMPTS; attempt++) {
    // Un job resté en pause après l'abandon de la connexion précédente doit
    // attendre ici la reprise (ou l'annulation) avant toute nouvelle requête.
    await waitWhilePaused(jobKey);

    const job = DOWNLOAD_JOBS.get(jobKey);
    if (job) {
      if (job.cancelled) throw Object.assign(new Error('Téléchargement annulé.'), { cancelled: true });
      job.attempts = attempt;
      job.retry_message = null;
      job.updated_at = new Date().toISOString();
    }

    let jobController = DOWNLOAD_ABORTS.get(jobKey);
    if (!jobController) {
      jobController = new AbortController();
      DOWNLOAD_ABORTS.set(jobKey, jobController);
    }
    const attemptController = new AbortController();
    const abortFromJob = () => attemptController.abort(jobController.signal.reason);
    if (jobController.signal.aborted) abortFromJob();
    else jobController.signal.addEventListener('abort', abortFromJob, { once: true });
    // Le bouton Pause doit couper la connexion EN COURS (et non seulement poser
    // un drapeau) : on publie l'AbortController de la tentative pour
    // pauseDownloadJob, qui l'utilise sans marquer le job comme annulé.
    PAUSE_ABORTS.set(jobKey, attemptController);

    const requestHeaders = { 'User-Agent': 'LIA-X/2.0', 'Accept-Encoding': 'identity', ...headers };
    if (written > 0) requestHeaders.Range = `bytes=${written}-`;

    let response = null;
    let stallTimer = null;
    let lastDataAt = Date.now();

    try {
      response = await fetchWithTimeout(url, { redirect: 'follow', headers: requestHeaders, signal: attemptController.signal });

      if (response.status === 416 && written > 0) {
        const resumedSize = (await fileSizeOrNull(partPath)) || written;
        if (totalBytes > 0 && resumedSize < totalBytes) {
          throw new Error(`Reprise impossible (${resumedSize}/${totalBytes} octets reçus)`);
        }
        await fs.promises.rename(partPath, targetPath);
        return { filename: path.basename(targetPath), total_bytes: totalBytes || resumedSize, received_bytes: resumedSize };
      }

      if (!response.ok || !response.body) {
        const status = response.status;
        const message = `Téléchargement impossible (${status} ${response.statusText || ''})`.trim();
        if (status >= 400 && status < 500 && status !== 408 && status !== 429) {
          throw Object.assign(new Error(message), { fatal: true });
        }
        throw new Error(message);
      }

      const resumed = response.status === 206;
      if (!resumed && written > 0) {
        // Serveur sans support des requêtes partielles : on repart de zéro.
        written = 0;
        await fs.promises.rm(partPath, { force: true }).catch(() => {});
      }

      if (resumed) {
        const contentRange = response.headers.get('content-range') || '';
        const match = /\/(\d+)\s*$/u.exec(contentRange);
        if (match) totalBytes = Number(match[1]) || totalBytes;
      } else {
        const contentLength = Number(parseInt(response.headers.get('content-length') || '0', 10));
        const linkedSize = Number(parseInt(response.headers.get('x-linked-size') || '0', 10));
        totalBytes = contentLength || linkedSize || totalBytes;
      }
      setDownloadJobTotalBytes(jobKey, totalBytes);

      if (totalBytes > 0 && !(await checkDiskSpace(MODEL_STORAGE_DIR, Math.max(0, totalBytes - written)))) {
        throw Object.assign(new Error('Espace disque insuffisant pour le téléchargement.'), { fatal: true });
      }

      // Pause demandée pendant la préparation de la requête : on attend la
      // reprise avant d'écrire quoi que ce soit de plus sur disque.
      await waitWhilePaused(jobKey);

      const tracker = new Transform({
        transform(chunk, _encoding, callback) {
          written += chunk.length;
          lastDataAt = Date.now();
          advanceDownloadJob(jobKey, written);
          callback(null, chunk);
        },
      });

      // Un flux qui ne livre plus rien (réseau coupé, CDN bloqué) ne doit pas
      // bloquer le téléchargement indéfiniment : on relance et on reprend.
      stallTimer = setInterval(() => {
        if (Date.now() - lastDataAt > DOWNLOAD_STALL_TIMEOUT_MS) {
          attemptController.abort(Object.assign(new Error('Flux interrompu (aucune donnée reçue)'), { name: 'TimeoutError' }));
        }
      }, 5000);
      if (stallTimer && typeof stallTimer.unref === 'function') stallTimer.unref();

      await pipeline(Readable.fromWeb(response.body), tracker, fs.createWriteStream(partPath, { flags: resumed ? 'a' : 'w' }));

      const downloadedSize = (await fileSizeOrNull(partPath)) || written;
      if (totalBytes > 0 && downloadedSize < totalBytes) {
        throw new Error(`Flux interrompu (${downloadedSize}/${totalBytes} octets reçus)`);
      }

      await fs.promises.rename(partPath, targetPath);
      const finalSize = (await fileSizeOrNull(targetPath)) || downloadedSize;
      return { filename: path.basename(targetPath), total_bytes: totalBytes || finalSize, received_bytes: finalSize };
    } catch (error) {
      lastError = error;
      if (jobController.signal.aborted) {
        throw Object.assign(new Error('Téléchargement annulé.'), { cancelled: true });
      }
      if (error && error.fatal) throw error;

      written = (await fileSizeOrNull(partPath)) || written; // point de reprise
      const current = DOWNLOAD_JOBS.get(jobKey);
      if (current) {
        current.resumable = written > 0;
        current.updated_at = new Date().toISOString();
      }

      // Mise en pause volontaire : la connexion vient d'être coupée par le bouton
      // Pause. Ce n'est pas un échec — on conserve le .part, on ne consomme
      // aucune tentative et on attend la reprise (en tête de boucle).
      if (current && current.paused) {
        current.received_bytes = written;
        current.speed_bps = 0;
        current.eta_seconds = null;
        current.retry_message = null;
        attempt -= 1;
        continue;
      }
      console.warn(`[model-manager] téléchargement ${jobKey} : tentative ${attempt}/${DOWNLOAD_MAX_ATTEMPTS} échouée — ${error?.message || error}`);

      if (attempt < DOWNLOAD_MAX_ATTEMPTS) {
        const waitMs = Math.min(20000, 1000 * attempt * attempt);
        const retryJob = DOWNLOAD_JOBS.get(jobKey);
        if (retryJob) {
          retryJob.retry_message = `Connexion instable : nouvelle tentative dans ${Math.round(waitMs / 1000)} s (${attempt}/${DOWNLOAD_MAX_ATTEMPTS}).`;
          retryJob.updated_at = new Date().toISOString();
        }
        await sleep(waitMs);
      }
    } finally {
      if (stallTimer) clearInterval(stallTimer);
      if (typeof jobController.signal.removeEventListener === 'function') {
        jobController.signal.removeEventListener('abort', abortFromJob);
      }
      if (PAUSE_ABORTS.get(jobKey) === attemptController) PAUSE_ABORTS.delete(jobKey);
      try { await response?.body?.cancel?.(); } catch { /* flux déjà consommé */ }
    }
  }

  const received = (await fileSizeOrNull(partPath)) || written;
  const suffix = received > 0
    ? ` ${received} octet(s) déjà reçus sont conservés : le prochain essai reprendra automatiquement.`
    : '';
  throw new Error(`${lastError?.message || 'Téléchargement interrompu.'}${suffix}`);
}

// Point d'entrée : télécharge une URL GGUF (Hugging Face, CDN, …) avec reprise,
// progression temps réel et écriture atomique. Le job est enregistré dans
// DOWNLOAD_JOBS pour que l'UI suive l'avancement sans bloquer la page.
async function downloadToModelsDir(url, name, options = {}) {
  const { targetFilename, targetPath, partPath, headers, remoteTotalBytes } = await prepareDownloadTarget(url, name, options);
  const modelKey = options.modelKey || toModelId(targetFilename);
  const startBytes = (await fileSizeOrNull(partPath)) || 0;

  startDownloadJob(modelKey, remoteTotalBytes, {
    filename: targetFilename,
    source: options.source || 'url',
    url,
    storage_path: targetPath,
    start_bytes: startBytes,
  });

  // Marqueur d'exécution (non persisté) : permet à /api/models/download/resume
  // de relancer la tâche si elle s'est arrêtée pour une raison quelconque.
  const runningJob = DOWNLOAD_JOBS.get(modelKey);
  if (runningJob) runningJob._taskRunning = true;

  try {
    const result = await streamUrlToFile({ url, targetPath, partPath, jobKey: modelKey, headers, jobTotalBytes: remoteTotalBytes });
    finishDownloadJob(modelKey, null);
    return { filename: targetFilename, model: modelKey, path: targetPath, ...result };
  } catch (error) {
    if (error && error.cancelled) {
      finishDownloadJob(modelKey, null, { cancelled: true });
      throw error;
    }
    // Un job en pause n'est pas « en erreur » : on conserve son état pour que
    // l'UI propose toujours « Reprendre » avec le .part déjà téléchargé.
    const pausedJob = DOWNLOAD_JOBS.get(modelKey);
    if (pausedJob && pausedJob.paused && !error?.fatal) {
      pausedJob.error = null;
      pausedJob.done = false;
      pausedJob.updated_at = new Date().toISOString();
      throw error;
    }
    finishDownloadJob(modelKey, error?.message || String(error));
    throw error;
  } finally {
    const finishedJob = DOWNLOAD_JOBS.get(modelKey);
    if (finishedJob) finishedJob._taskRunning = false;
  }
}

async function importFromOllamaLibrary(reference, localName) {
  const parsed = parseOllamaLibraryReference(reference);
  const manifestResponse = await fetchWithTimeout(`${OLLAMA_REGISTRY_BASE_URL}/v2/${parsed.repository}/manifests/${parsed.tag}`, {
    headers: {
      Accept: 'application/vnd.docker.distribution.manifest.v2+json',
      'User-Agent': 'LIA-X/2.0',
    },
  }, DOWNLOAD_CONNECT_TIMEOUT_MS);

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

  // Le blob Ollama est téléchargé comme n'importe quelle URL GGUF : reprise via
  // Range, progression réelle et fichier .part (jamais de GGUF tronqué).
  //
  // IMPORTANT — nom de fichier et deux-points.
  // Un nom Ollama s'écrit « modele:tag » (qwen3-embedding:0.6b). Le caractère
  // deux-points est INTERDIT dans un nom de fichier Windows, et le volume
  // /models est un montage lié : le fichier est donc créé par le conteneur
  // (Linux, où ':' est légal) puis transcrit par Docker Desktop en U+F03A sur
  // NTFS. Résultat mesuré : le conteneur voit
  // « qwen3-embedding:0.6b.gguf » et le contrôleur, natif Windows,
  // « qwen3-embedding<U+F03A>0.6b.gguf » — la résolution du modèle échoue
  // alors que le fichier est là, avec un message trompeur
  // (« Modèle introuvable ») et un dossier annoncé comme vide.
  //
  // On applique donc au nom local la même neutralisation que safeName : le
  // fichier est créé avec un nom directement lisible par Windows, et le
  // deux-points disparaît au lieu d'être transcrit en un caractère fantôme.
  const requestedName = String(localName || parsed.safeName).trim();
  const baseName = requestedName.replace(/[\\/]/gu, '-').replace(/[^a-zA-Z0-9._-]/gu, '-');
  const targetFilename = baseName.toLowerCase().endsWith('.gguf') ? baseName : `${baseName}.gguf`;
  const targetPath = path.join(MODEL_STORAGE_DIR, targetFilename);
  const partPath = `${targetPath}.part`;
  const blobUrl = `${OLLAMA_REGISTRY_BASE_URL}/v2/${parsed.repository}/blobs/${modelLayer.digest}`;
  const layerSize = Number(modelLayer.size) || null;

  await fs.promises.mkdir(MODEL_STORAGE_DIR, { recursive: true });
  const existingSize = await fileSizeOrNull(targetPath);

  if (existingSize !== null && existingSize > 0) {
    if (!layerSize || existingSize >= layerSize) {
      throw new Error(`Le fichier existe déjà : ${targetFilename}`);
    }
    await fs.promises.rename(targetPath, partPath).catch(() => {});
  } else if (existingSize === 0) {
    await fs.promises.rm(targetPath, { force: true }).catch(() => {});
  }

  const modelKey = toModelId(targetFilename);
  startDownloadJob(modelKey, layerSize, {
    filename: targetFilename,
    source: 'ollama',
    url: blobUrl,
    storage_path: targetPath,
    start_bytes: (await fileSizeOrNull(partPath)) || 0,
  });

  try {
    const result = await streamUrlToFile({ url: blobUrl, targetPath, partPath, jobKey: modelKey, headers: {}, jobTotalBytes: layerSize });
    finishDownloadJob(modelKey, null);
    return { filename: targetFilename, model: modelKey, path: targetPath, ...result };
  } catch (error) {
    if (error && error.cancelled) {
      finishDownloadJob(modelKey, null, { cancelled: true });
      throw error;
    }
    finishDownloadJob(modelKey, error?.message || String(error));
    throw error;
  }
}

async function proxyModelPayload(runtimeStatus) {
  const activeModel = resolveActiveModel(runtimeStatus);
  const loadedModels = buildLoadedModelList(runtimeStatus);

  // Détection par métadonnées GGUF pour chaque instance chargée. Les détails
  // GGUF sont mis en cache par chemin+taille+mtime : le coût est nul après le
  // premier appel, et /v1/models n'est pas un chemin chaud.
  const declaredByModel = new Map();
  for (const model of loadedModels) {
    const identifier = model.filename || model.model;
    const inspect = await inspectEmbeddingModel(identifier);
    declaredByModel.set(model.model, inspect);
  }

  return loadedModels
    .map((model) => {
      const inspect = declaredByModel.get(model.model) || { declared: false, source: 'none' };
      return {
        id: model.model,
        object: 'model',
        owned_by: 'lia',
        permission: [],
        active_model: activeModel,
        backend: runtimeStatus?.backend,
        filename: model.filename,
        running: model.running,
        size_vram: model.size_vram,
        size_vram_source: model.size_vram_source,
        process_memory_bytes: model.process_memory_bytes,
        peak_process_memory_bytes: model.peak_process_memory_bytes,
        gpu_memory_bytes: model.gpu_memory_bytes,
        gpu_memory_dedicated_bytes: model.gpu_memory_dedicated_bytes,
        gpu_memory_shared_bytes: model.gpu_memory_shared_bytes,
        expires_at: model.expires_at,
        // embedding_capable : declaration (ce FICHIER est un modele
        // d'embeddings). Conserve tel quel pour ne pas casser les clients
        // existants (Open WebUI, AnythingLLM, Cline…).
        embedding_capable: inspect.declared,
        // embedding_declared : meme information, nom explicite et non ambigu.
        embedding_declared: inspect.declared,
        // embedding_source : comment on l'a determine. 'metadata' = lu dans le
        // GGUF (fiable) ; 'name' = repli par heuristique de nom (incertain).
        embedding_source: inspect.source,
        // embedding_active : etat REEL de l'instance (drapeau --embedding pose
        // par le controleur au lancement). C'est lui qui dit si
        // POST /v1/embeddings fonctionnera sur cette instance.
        embedding_active: model.embedding === true,
      };
    })
    .filter((entry, index, array) => array.findIndex((item) => item.id === entry.id) === index);
}

async function buildFullModelList(runtimeStatus) {
  const loaded = await proxyModelPayload(runtimeStatus);
  const loadedIds = new Set(loaded.map((item) => item.id));
  const localModels = await listLocalModels();

  // Index des instances chargées par identifiant ET par filename : un modèle
  // local est aussi listé quand il tourne, et c'est la SEULE source pour
  // connaître son état d'embedding réel.
  const loadedByName = new Map();
  for (const entry of loaded) {
    if (entry.id) loadedByName.set(String(entry.id).toLowerCase(), entry);
    if (entry.filename) loadedByName.set(String(entry.filename).toLowerCase(), entry);
  }

  const extras = await Promise.all(localModels.map(async (item) => {
    const loadedEntry = loadedByName.get(String(item.name).toLowerCase())
      || loadedByName.get(String(item.filename).toLowerCase());
    // Métadonnées GGUF d'abord, repli sur le nom (cf. inspectEmbeddingModel).
    const inspect = await inspectEmbeddingModel(item.name);
    return {
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
      embedding_capable: inspect.declared,
      embedding_declared: inspect.declared,
      embedding_source: inspect.source,
      // Une entrée locale n'a pas d'instance propre : on reprend l'état réel
      // de l'instance chargée correspondante, sinon false (aucune instance).
      embedding_active: loadedEntry ? loadedEntry.embedding_active === true : false,
    };
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
      // `lia-local` est un alias du modèle actif : il hérite de son état réel.
      embedding_capable: isEmbeddingDeclaredName(runtimeStatus?.active_model || runtimeStatus?.active_filename),
      embedding_declared: isEmbeddingDeclaredName(runtimeStatus?.active_model || runtimeStatus?.active_filename),
      embedding_active: runtimeStatus?.embedding === true,
    });
  }

  for (const model of extras) {
    if (!list.some((entry) => entry.id === model.id)) {
      list.push(model);
    }
  }

  // Téléchargements partiels : un fichier .gguf.part en cours doit apparaître
  // dans la table avec ses boutons de reprise / annulation, même si le fichier
  // final n'existe pas encore (listLocalModels ne les voit pas).
  const partialJobs = listAllDownloadJobs()
    // Un job en pause reste un téléchargement en cours : il doit rester visible
    // dans la table pour que l'utilisateur puisse le reprendre.
    .filter((job) => !job.done && !job.cancelled && !job.error && job.source !== 'ollama')
    .filter((job) => {
      // Ne pas dupliquer un modèle déjà listé (fichier final présent ou en mémoire).
      const targetName = job.filename || '';
      return !list.some((entry) => entry.id === targetName || entry.id === `${targetName}_download`);
    });
  for (const job of partialJobs) {
    const targetName = job.filename || '';
    const partPath = job.storage_path ? `${job.storage_path}.part` : null;
    const partSize = partPath ? (job.received_bytes ?? (await fileSizeOrNull(partPath))) : 0;
    list.push({
      id: `${targetName}_download`,
      object: 'model',
      owned_by: 'lia',
      permission: [],
      active_model: resolveActiveModel(runtimeStatus),
      backend: runtimeStatus?.backend,
      filename: targetName,
      partial: true,
      partial_job: {
        model: job.model,
        source: job.source,
        url: job.url || null,
        active: !job.done && !job.cancelled && !job.error && !job.paused,
        paused: Boolean(job.paused),
        received_bytes: job.received_bytes ?? partSize,
        total_bytes: job.total_bytes ?? null,
        percent: downloadPercent(job),
        speed_bps: job.speed_bps ?? null,
        eta_seconds: job.eta_seconds ?? null,
        retry_message: job.retry_message || null,
        updated_at: job.updated_at || null,
      },
      running: false,
      size_vram: null,
      expires_at: null,
      embedding_capable: false,
      embedding_declared: false,
      // Fichier encore en cours de téléchargement : aucune instance, donc
      // l'état d'embedding est nécessairement faux.
      embedding_active: false,
    });
  }

  return list;
}

// Téléchargements partiels : un fichier .gguf.part en cours doit apparaître dans
// la table des modèles (avec ses boutons Pause / Reprendre / Retirer) alors que
// le fichier final n'existe pas encore — listLocalModels ne le voit pas.
function buildPartialDownloadEntries(loadedModels) {
  const loadedNames = new Set();
  (loadedModels || []).forEach((item) => {
    if (item?.model) loadedNames.add(String(item.model));
    if (item?.filename) loadedNames.add(String(item.filename));
  });

  const entries = [];
  for (const job of listAllDownloadJobs()) {
    if (!job) continue;
    // Les jobs terminés, annulés ou en erreur ne sont pas des téléchargements en
    // cours : ils n'ont rien à faire dans la table des modèles.
    if (job.done || job.cancelled || job.error) continue;
    // Les blobs Ollama ne sont pas des GGUF natifs : hors périmètre de la table.
    if (job.source === 'ollama') continue;

    const targetFilename = String(job.filename || '');
    if (!targetFilename) continue;

    const modelName = toModelId(targetFilename);
    if (loadedNames.has(modelName) || loadedNames.has(targetFilename)) continue;

    entries.push({
      id: `${targetFilename}_download`,
      object: 'model',
      owned_by: 'lia',
      model: modelName,
      filename: targetFilename,
      partial: true,
      // Tout ce qu'il faut à l'UI pour afficher la progression et proposer
      // Pause / Reprendre / Retirer sans requête supplémentaire.
      partial_job: {
        model: job.model,
        source: job.source,
        url: job.url || null,
        active: !job.done && !job.cancelled && !job.error && !job.paused,
        paused: Boolean(job.paused),
        received_bytes: job.received_bytes ?? 0,
        total_bytes: job.total_bytes ?? null,
        percent: downloadPercent(job),
        speed_bps: job.speed_bps ?? null,
        eta_seconds: job.eta_seconds ?? null,
        retry_message: job.retry_message || null,
        updated_at: job.updated_at || null,
      },
      running: false,
      active_model: false,
      size_vram: null,
      size_vram_source: null,
      expires_at: null,
      context_length: null,
      embedding_capable: false,
      embedding_declared: false,
      embedding_active: false,
    });
  }
  return entries;
}

function translateToDockerHost(url) {
  if (!DOCKER_INTERNAL || typeof url !== 'string') {
    return url;
  }

  return url
    .replace(/^http:\/\/127\.0\.0\.1(:\d+)/i, 'http://host.docker.internal$1')
    .replace(/^http:\/\/localhost(:\d+)/i, 'http://host.docker.internal$1');
}

function getRuntimeBaseUrl(runtimeStatus, requestedModel, options = {}) {
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

  // CORRECTIF : /v1/embeddings doit viser l'instance d'embeddings, meme si elle
  // n'est pas l'instance ACTIVE (le modele de chat reste alors le principal).
  // Sans cela, une requete d'embeddings sans `model` explicite partait sur le
  // port du modele de chat, qui n'a pas --embedding → 501.
  // On ne cible que des instances VRAIMENT en mode embedding : le drapeau
  // `embedding` vient du controleur, il ne peut pas etre declare par erreur.
  if (options.embeddingTarget) {
    const embeddingInstance = instances.find((instance) => (
      Boolean(instance.running) && instance.embedding === true
    ));
    if (embeddingInstance?.server_base_url) {
      return translateToDockerHost(String(embeddingInstance.server_base_url).replace(/\/v1\/?$/, '').replace(/\/$/, ''));
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
    // Détection par MÉTADONNÉES GGUF (pooling_type / architecture d'encodeur),
    // avec repli sur le nom. Indispensable : un vrai modèle d'embeddings dont
    // le nom n'est pas dans la liste (qwen3-embedding-0.6b) doit quand même
    // recevoir --embedding, sinon /v1/embeddings renvoie 501.
    const embeddingInspect = isEmbeddingEndpoint && embeddingModelName
      ? await inspectEmbeddingModel(embeddingModelName)
      : null;
    const isEmbeddingCapable = Boolean(embeddingInspect?.declared);

    // AUTO-RÉPARATION : l'instance embeddings tourne mais SANS --embedding.
    // Le contrôleur a un fast path sur /start (llama-host-controller.ps1 :
    // « Promoted existing instance as active ») qui promeut une instance déjà
    // vivante SANS la relancer — le drapeau `embedding` y est ignoré. Sans
    // l'arrêt explicite ci-dessous, ensureRuntimeReady rapporterait un succès
    // et llama-server continuerait de répondre 501 sur /v1/embeddings.
    // On.aligne donc sur ce que fait déjà POST /api/embedding-model.
    if (isEmbeddingEndpoint && isEmbeddingCapable && embeddingModelName) {
      const currentInstance = await resolveEmbeddingModelInstance(embeddingModelName);
      if (currentInstance && currentInstance.embedding !== true) {
        console.warn('[model-manager] instance embeddings sans --embedding, redemarrage', {
          model: embeddingModelName,
          port: currentInstance.port,
        });
        try {
          await controllerRequest('/stop', {
            method: 'POST',
            body: JSON.stringify({ model: embeddingModelName }),
            timeout: 60000,
            maxRetries: 1,
          });
        } catch (stopError) {
          console.error('[model-manager] arret instance embeddings echoue', stopError?.message || stopError);
        }
        try {
          const restartRequest = await buildModelStartRequest(embeddingModelName);
          restartRequest.payload.embedding = true;
          await controllerRequest('/start', {
            method: 'POST',
            body: JSON.stringify(restartRequest.payload),
            timeout: CONTROLLER_START_TIMEOUT_MS,
            maxRetries: 0,
          });
        } catch (startError) {
          console.error('[model-manager] redemarrage embeddings echoue', startError?.message || startError);
        }
      }
    }

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

    const runtimeUrl = getRuntimeBaseUrl(runtimeStatus, requestedModel, {
      // Uniquement sur /v1/embeddings, et seulement si le modèle demandé est
      // bien un modèle d'embeddings (sinon on ne détourne pas le routage).
      embeddingTarget: isEmbeddingEndpoint && isEmbeddingCapable,
    });
    const isStreaming = payload.stream === true;
    console.log('[model-manager] proxy request', { endpoint, requestedModel, isRoocodeRequest, runtimeUrl, isStreaming });

    const upstream = await proxyToRuntime(runtimeUrl, endpoint, req.method, payload);

    // llama.cpp ne sert POST /v1/embeddings que si le processus a ete lance
    // avec --embedding. Selon la version, il repond 501 ("not implemented")
    // ou 404 (route non enregistree). On ne laisse pas passer ces deux codes
    // bruts : le client (AnythingLLM, Open WebUI, un script) ne peut rien en
    // faire. On les convertit en 503 + diagnostic actionnable.
    if (isEmbeddingEndpoint && [404, 501].includes(upstream.statusCode)) {
      upstream.resume();
      const state = await describeEmbeddingState(embeddingModelName);
      console.warn('[model-manager] /v1/embeddings indisponible', {
        upstream_status: upstream.statusCode,
        runtime_url: runtimeUrl,
        ...state,
      });
      return err(res, 503,
        `Le modele d'embeddings ne sert pas /v1/embeddings : l'instance sur le port ${state.port} n'a pas ete lancee avec le drapeau --embedding `
        + `(upstream ${upstream.statusCode}). ${state.model ? `Modele : ${state.model}. ` : ''}`
        + 'Rechargez le modele d\'embeddings depuis l\'onglet Modèles (ou via POST /api/embedding-model), ce qui le redemarre avec --embedding.');
    }

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

// ─────────────────────────────────────────────────────────────────────────────
// Synthèse vocale : moteur neuronal local, avec repli sur SAPI.
//
// DEUX MOTEURS, UN SEUL CONTRAT
// -----------------------------
// 1. Kokoro-82M (src/voice/kokoro.cjs) : reseau StyleTTS 2 execute dans ce
//    conteneur via ONNX Runtime, qui est DEJA present (tire par
//    @huggingface/transformers, le meme qui sert Whisper pour la reconnaissance
//    vocale). Aucune installation supplementaire, aucun GPU.
//
// 2. SAPI, via le controleur : le seul TTS systeme de la machine (trois voix,
//    aucune voix neuronale Windows installee). Conserve comme REPLI.
//
// Le repli n est pas decoratif. Kokoro exige espeak-ng et un modele de 310 Mo
// present dans le cache : sur une installation fraiche, ou si le modele n a pas
// encore ete telecharge, SAPI est la seule chose qui fonctionne. On ne laisse
// donc jamais l utilisateur sans voix.
//
// Pourquoi ne pas synthetiser dans le navigateur : speechSynthesis sort du
// systeme, donc le navigateur ne dispose pas du signal de reference qui
// permettrait d annuler l echo. En passant par un <audio>, ce signal existe, et
// l annulation d echo peut enfin fonctionner. C est la condition du duplex.
// ─────────────────────────────────────────────────────────────────────────────

// Disponibilite decidee au premier appel, jamais recalculee a chaque requete.
const TTS_ENGINE_STATE = { kokoro: null, notice: '' };

app.get('/api/voice/engines', (req, res) => {
  res.json({
    engines: {
      kokoro: TTS_ENGINE_STATE.kokoro === null ? kokoroEngine.isAvailable() : TTS_ENGINE_STATE.kokoro,
      sapi: true,
    },
    kokoro_dir: kokoroEngine.KOKORO_DIR,
    notice: TTS_ENGINE_STATE.notice,
  });
});

app.post('/api/voice/tts', async (req, res) => {

  try {

    const text = String(req.body?.text || '').trim();

    if (!text) return err(res, 400, 'texte manquant');

    // L interface expose un multiplicateur (0,5 a 2), identique pour les deux
    // moteurs : l utilisateur ne doit avoir a regler ni SAPI ni le reseau.
    const rateMultiplier = Number.isFinite(Number(req.body?.rate))
      ? Math.max(0.5, Math.min(2, Number(req.body.rate)))
      : 1;

    // ── Moteur neuronal, s il est utilisable ──────────────────────────────
    // On tente d abord Kokoro. Toute erreur (modele absent, espeak-ng manquant,
    // session impossible) fait TOMBER sur SAPI plutot que de renvoyer une
    // erreur a l interface : une voix mediocre vaut mieux qu aucune voix.
    if (kokoroEngine.isAvailable() && TTS_ENGINE_STATE.kokoro !== false) {
      try {
        const wav = await kokoroEngine.synthesize(text, rateMultiplier);
        TTS_ENGINE_STATE.kokoro = true;
        res.setHeader('Content-Type', 'audio/wav');
        res.setHeader('Content-Length', String(wav.length));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-TTS-Engine', 'kokoro');
        return res.end(wav);
      } catch (engineError) {
        TTS_ENGINE_STATE.kokoro = false;
        TTS_ENGINE_STATE.notice = `Kokoro indisponible (${engineError.message}) - repli sur SAPI.`;
        logError('/api/voice/tts', engineError);
      }
    }

    // ── Repli : SAPI via le controleur ────────────────────────────────────
    // SAPI attend une echelle entiere de -10 a +10 : on convertit ici pour que
    // le frontend ignore completement la difference d API.
    const sapiRate = Math.max(-10, Math.min(10, Math.round((rateMultiplier - 1) * 10)));

    const start = await fetch(`${CONTROLLER_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, rate: sapiRate }),
    });

    // 202 : le controleur a lance la synthese dans un processus fils et rend la
    // main. C est indispensable : le controleur est mono-thread, et une
    // synthese bloquante empilait les requetes jusqu a 18 s de latence mesuree,
    // ce qui faisait echouer le chat en 502 des qu il avait de la charge.
    let jobId = null;
    if (start.status === 202) {
      const payload = await start.json().catch(() => null);
      jobId = payload?.jobId || null;
    } else if (start.ok) {
      // Cas nominal : la phrase etait deja en cache, le WAV est immediat.
      const wav = Buffer.from(await start.arrayBuffer());
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', String(wav.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.end(wav);
    } else {
      const detail = await start.text().catch(() => '');
      return err(res, 502, `TTS indisponible : ${detail.slice(0, 200)}`);
    }

    if (!jobId) return err(res, 502, 'TTS : le controleur n a pas rendu de job');

    // Interrogation du job avec BACKOFF : on demarre serre (60 ms) car une
    // synthese SAPI courte est souvent prete en ~600 ms, puis on allonge
    // progressivement jusqu'a 200 ms. Le plateau de 200 ms retire en moyenne
    // une fraction de seconde de latence audibe par phrase par rapport aux
    // 150 ms fixes d'avant, sans marteler le controleur sur une synthese longue.
    let waitMs = 60;
    for (let essai = 0; essai < 600; essai += 1) {
      await new Promise((r) => setTimeout(r, waitMs));
      if (waitMs < 200) waitMs = Math.min(200, Math.round(waitMs * 1.5));
      const poll = await fetch(`${CONTROLLER_URL}/tts/${jobId}`);
      if (poll.status === 202) continue;
      if (!poll.ok) {
        const detail = await poll.text().catch(() => '');
        return err(res, 502, `TTS en erreur : ${detail.slice(0, 200)}`);
      }
      const wav = Buffer.from(await poll.arrayBuffer());
      res.setHeader('Content-Type', 'audio/wav');
      res.setHeader('Content-Length', String(wav.length));
      res.setHeader('Cache-Control', 'no-store');
      return res.end(wav);
    }

    return err(res, 504, 'TTS : synthese terminee dans les delais');
  } catch (error) {
    logError('/api/voice/tts', error);
    err(res, 502, error.message);
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

// Diagnostic matériel complet : GPU, mémoire dédiée/unifiée, backends réellement
// prouvés (cuda/rocm/vulkan/cpu) et validation du binaire llama.cpp.
app.get('/api/hardware/diagnostic', async (req, res) => {
  try {
    const [runtimeConfig, hardwareProfile] = await Promise.all([readRuntimeConfig(), readHardwareProfile()]);
    if (!runtimeConfig && !hardwareProfile) {
      return err(res, 503, "Aucune détection matérielle disponible (runtime/hardware-profile.json absent)");
    }
    res.json({
      source: 'runtime-config',
      config_path: RUNTIME_CONFIG_PATH,
      diagnostic: buildHardwareDiagnostic(runtimeConfig, hardwareProfile),
      runtime_config: runtimeConfig,
      hardware_profile: hardwareProfile,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError('/api/hardware/diagnostic', error);
    err(res, 502, error.message);
  }
});

// Réanalyse matérielle sans réinstallation. Le conteneur lia-x ne peut pas
// exécuter PowerShell côté hôte : la demande est déléguée au contrôleur (service
// Windows), qui relance exactement le même détecteur que l'installateur.
app.post('/api/hardware/rescan', async (req, res) => {
  try {
    const result = await controllerRequest('/rescan-hardware', {
      method: 'POST',
      timeout: 180000,
    });
    const [runtimeConfig, hardwareProfile] = await Promise.all([readRuntimeConfig(), readHardwareProfile()]);
    // Le rescan vient d'écrire la configuration côté hôte (service Windows). Ce
    // résultat est plus frais que les fichiers montés en lecture seule dans le
    // conteneur, qui peuvent appartenir à un autre dossier runtime : on le
    // privilégie pour que l'interface reflète immédiatement la nouvelle détection.
    const finalConfig = result?.runtime_config || runtimeConfig || null;
    const finalProfile = result?.hardware_profile || hardwareProfile || null;
    res.json({
      ok: Boolean(result?.ok),
      exit_code: Number.isInteger(result?.exit_code) ? result.exit_code : null,
      detector: result?.detector || null,
      log_tail: Array.isArray(result?.log_tail) ? result.log_tail : [],
      diagnostic: buildHardwareDiagnostic(finalConfig, finalProfile),
      runtime_config: finalConfig,
      hardware_profile: finalProfile,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError('/api/hardware/rescan', error);
    err(res, 502, `Réanalyse matérielle impossible : ${error.message}`);
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
      // Version du PRODUIT, lue dans package.json. Auparavant ce champ
      // renvoyait « llama.cpp · Vulkan » : un descripteur de runtime dans un
      //.endpoint nommé « version », ce qui rendait toute sonde de santé
      // (comparaison de version, affichage « à jour ») incapable de conclure.
      name: 'LIA-X',
      version: LIA_X_VERSION,
      // Le runtime est désormais un champ À PART : ce n'est pas une version.
      runtime: {
        name: 'llama.cpp',
        // La version du binaire llama.cpp est écrite par detect-hardware.ps1 dans
        // host-runtime-config.json, PAS dans /status : la lire ici évite de
        // renvoyer un « build » systématiquement nul.
        build: (await readRuntimeConfig())?.binary_version || null,
        device: runtime?.backend_label || 'Runtime indisponible',
        model_dir: MODEL_STORAGE_DIR,
        url: `${getRuntimeBaseUrl(runtime)}/v1`,
        source: snapshot.source,
        detail: snapshot.detail || null,
      },
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
      models: [...loadedModels, ...buildPartialDownloadEntries(loadedModels)],
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
      models: [...loadedModels, ...buildPartialDownloadEntries(loadedModels)],
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
      models: [...loadedModels, ...buildPartialDownloadEntries(loadedModels)],
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
      // Drapeau --embedding reellement pose sur l'instance en cours.
      // `loaded: true` + `active: false` = le modele tourne mais SANS
      // --embedding : POST /v1/embeddings renverra 501.
      active: instance?.embedding === true,
      declared: isEmbeddingDeclaredName(model),
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
        // Etat reel du drapeau --embedding de l'instance (cf. proxyModelPayload).
        embedding_active: item.embedding === true,
      })),
      // Etat de l'instance d'embeddings configuree, en un coup d'oeil :
      // `model` = choix de l'utilisateur, `active` = le drapeau est reellement
      // pose sur l'instance en cours. Les deux peuvent diverger.
      embedding: await (async () => {
        const preference = await readEmbeddingModelPreference();
        if (!preference) {
          return { model: null, loaded: false, active: false };
        }
        const instance = await resolveEmbeddingModelInstance(preference);
        return {
          model: preference,
          loaded: Boolean(instance),
          active: instance?.embedding === true,
          port: instance?.port || null,
        };
      })(),
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
  const { url, name, ollama_name: ollamaName, token } = req.body || {};

  try {
    if (ollamaName) {
      if (!name) {
        return err(res, 400, 'name requis pour import Ollama');
      }
      const filename = computeTargetFilename(ollamaName, name);
      const modelKey = toModelId(filename);
      startDownloadJob(modelKey, null, { filename, source: 'ollama', url: String(ollamaName) });
      setImmediate(() => {
        importFromOllamaLibrary(ollamaName, filename).catch((error) => {
          console.error('[model-manager] import Ollama échoué :', error?.message || error);
        });
      });
      return res.status(202).json({ status: 'started', model: modelKey, filename, source: 'ollama' });
    }

    if (!url || !ensureGgufUrl(url)) {
      return err(res, 400, 'URL GGUF invalide');
    }

    const filename = computeTargetFilename(url, name);
    const modelKey = toModelId(filename);
    const source = /huggingface\.co|hf\.co/i.test(url) ? 'huggingface' : 'url';
    startDownloadJob(modelKey, null, { filename, source, url: String(url) });
    setImmediate(() => {
      // Téléchargement en tâche de fond : l'UI suit la progression réelle via
      // /api/models/downloads, même si l'onglet est fermé entre-temps.
      downloadToModelsDir(url, filename, { token, source }).catch((error) => {
        console.error('[model-manager] téléchargement échoué :', error?.message || error);
      });
    });
    return res.status(202).json({ status: 'started', model: modelKey, filename, source });
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

// Gère un téléchargement "en pause" (non still in DOWNLOAD_JOBS).
// Contrairement à l'annulation complète, la pause conserve le fichier .part et
// les octets déjà reçus afin qu'un futur appel à /api/models/download/resume
// reprenne le téléchargement là où il s'était arrêté (en-tête Range).
app.post('/api/models/download/pause', async (req, res) => {
  try {
    const modelKey = String(req.body?.model || req.body?.filename || '').trim();
    if (!modelKey) return err(res, 400, 'model requis');
    const job = DOWNLOAD_JOBS.get(modelKey);
    if (!job) return err(res, 404, 'téléchargement introuvable : ' + modelKey);
    // ATTENTION : le job interne ne porte PAS de champ « active » (calculé
    // uniquement dans la vue publique) — on teste donc ses drapeaux bruts.
    if (job.done || job.cancelled || job.error) {
      return err(res, 409, 'ce téléchargement est terminé');
    }
    if (job.paused) return res.json({ status: 'already_paused', model: modelKey });

    // Arrête le flux en cours sans perdre les octets déjà reçus.
    pauseDownloadJob(modelKey);
    const refreshed = DOWNLOAD_JOBS.get(modelKey);
    res.json({
      status: 'paused',
      model: modelKey,
      received_bytes: refreshed?.received_bytes ?? 0,
      total_bytes: refreshed?.total_bytes ?? 0,
      paused_at: refreshed?.paused_at ?? null,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

// Reprend un téléchargement précédemment mis en pause. Le téléchargement
// reprend automatiquement là où il s'est arrêté (Range sur les octets déjà
// reçus) — aucun re-téléchargement depuis le début.
app.post('/api/models/download/resume', async (req, res) => {
  try {
    const modelKey = String(req.body?.model || req.body?.filename || '').trim();
    if (!modelKey) return err(res, 400, 'model requis');
    const job = DOWNLOAD_JOBS.get(modelKey);
    if (!job) return err(res, 404, 'téléchargement introuvable : ' + modelKey);
    if (!job.paused) return err(res, 409, 'ce téléchargement n\'est pas en pause');
    if (job.done || job.error || job.cancelled) return err(res, 409, 'ce téléchargement est terminé');

    resumeDownloadJob(modelKey);
    const refreshed = DOWNLOAD_JOBS.get(modelKey);

    // Filet de sécurité : si la tâche de fond n'est plus active (arrêt du serveur,
    // erreur fatale, boucle terminée), on la relance ici. Le flux repart du
    // fichier .part existant (en-tête Range) — jamais depuis zéro.
    const needsRestart = Boolean(refreshed && refreshed.url && refreshed.filename && !refreshed._taskRunning);
    if (needsRestart) {
      refreshed._taskRunning = true;
      setImmediate(() => {
        downloadToModelsDir(refreshed.url, refreshed.filename, {
          modelKey,
          source: refreshed.source || 'url',
        }).catch((error) => {
          console.error('[model-manager] reprise du téléchargement échouée :', error?.message || error);
        });
      });
    }

    res.json({
      status: 'resumed',
      model: modelKey,
      received_bytes: refreshed?.received_bytes ?? 0,
      total_bytes: refreshed?.total_bytes ?? 0,
      restarted: needsRestart,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});
app.get('/api/models/downloads', async (req, res) => {
  try {
    const downloads = listAllDownloadJobs();
    res.json({
      downloads,
      active_count: downloads.filter((job) => job.active).length,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.post('/api/models/download/cancel', async (req, res) => {
  try {
    const modelKey = String(req.body?.model || req.body?.filename || '').trim();
    if (!modelKey) {
      return err(res, 400, 'model requis');
    }

    const found = DOWNLOAD_JOBS.get(modelKey);
    const cancelled = cancelDownloadJob(modelKey);
    if (found && !found.done && !found.error && !found.cancelled) {
      finishDownloadJob(modelKey, null, { cancelled: true });
    }
    res.json({ status: cancelled ? 'cancelling' : 'not_running', model: modelKey });
  } catch (error) {
    err(res, 502, error.message);
  }
});

// Efface un téléchargement de la liste et supprime le fichier .part associé.
// L'arrêt est ordonné : on marque d'abord le job comme annulé, puis on laisse
// pipeline()/fetch() fermer leurs descripteurs avant de supprimer le fichier. Sur
// Windows, un unlink immédiat peut sinon échouer avec EBUSY/EPERM.
app.delete('/api/models/download/:model', async (req, res) => {
  try {
    const modelKey = decodeURIComponent(req.params.model || '').trim();
    if (!modelKey) return err(res, 400, 'model requis');
    const job = DOWNLOAD_JOBS.get(modelKey);
    if (!job) return err(res, 404, 'téléchargement introuvable : ' + modelKey);

    const partPath = job.storage_path
      ? (job.storage_path.endsWith('.part') ? job.storage_path : `${job.storage_path}.part`)
      : null;

    stopDownloadTask(modelKey);
    const taskStopped = await waitForDownloadTaskToStop(modelKey);
    if (taskStopped) DOWNLOAD_JOBS.delete(modelKey);

    let partDeleted = !partPath;
    let deleteError = null;
    if (partPath) {
      for (let attempt = 1; attempt <= 5 && !partDeleted; attempt += 1) {
        try {
          await fs.promises.unlink(partPath);
          partDeleted = true;
        } catch (unlinkErr) {
          if (unlinkErr?.code === 'ENOENT') { partDeleted = true; break; }
          deleteError = unlinkErr;
          if (attempt < 5) await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
      }
    }
    if (deleteError) console.warn(`[model-manager] impossible de supprimer ${partPath} : ${deleteError.message}`);
    res.json({ status: partDeleted ? 'removed' : 'stopped', model: modelKey, part_deleted: partDeleted, task_stopped: taskStopped });
  } catch (error) {
    err(res, 502, error.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Modèles épinglés : résidence permanente en VRAM.
//
// Un modèle épinglé est démarré SANS --sleep-idle-seconds : llama-server ne
// le décharge jamais, il reste entièrement chargé et répond sans latence de
// rechargement. L'état est en base, il survit donc au redémarrage du
// contrôleur comme du conteneur.
//
// On identifie un modèle par son nom de fichier : c'est la seule clé stable
// entre le disque, le runtime state du contrôleur et cette table.
// ─────────────────────────────────────────────────────────────────────────────
async function listPinnedModels() {
  if (!db.isDbAvailable()) return new Set();
  try {
    const result = await db.query('SELECT filename FROM pinned_models');
    return new Set(result.rows.map((row) => row.filename));
  } catch (error) {
    console.warn('[pin] lecture impossible :', error.message);
    return new Set();
  }
}

app.get('/api/models/pinned', async (req, res) => {
  try {
    const pinned = await listPinnedModels();
    res.json({ pinned: Array.from(pinned) });
  } catch (error) {
    logError('/api/models/pinned', error);
    err(res, 500, error.message);
  }
});

app.post('/api/models/pin', async (req, res) => {
  try {
    const filename = String(req.body?.filename || '').trim();
    if (!filename) return err(res, 400, 'filename manquant');
    if (!db.isDbAvailable()) return err(res, 503, 'Base de données indisponible.');
    await db.query(
      'INSERT INTO pinned_models (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
      [filename],
    );
    res.json({ filename, pinned: true });
  } catch (error) {
    logError('/api/models/pin', error);
    err(res, 500, error.message);
  }
});

app.delete('/api/models/pin', async (req, res) => {
  try {
    const filename = String(req.body?.filename || req.query?.filename || '').trim();
    if (!filename) return err(res, 400, 'filename manquant');
    if (!db.isDbAvailable()) return err(res, 503, 'Base de données indisponible.');
    await db.query('DELETE FROM pinned_models WHERE filename = $1', [filename]);
    res.json({ filename, pinned: false });
  } catch (error) {
    logError('/api/models/pin', error);
    err(res, 500, error.message);
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
  const { url, name, token } = req.body || {};
  if (!url || !ensureGgufUrl(url)) {
    return err(res, 400, 'URL Hugging Face GGUF invalide');
  }

  if (!name) {
    return err(res, 400, 'name requis');
  }

  try {
    const source = /huggingface\.co|hf\.co/i.test(url) ? 'huggingface' : 'url';
    const file = await downloadToModelsDir(url, name, { token, source });
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

// Mémoire réellement consommée par les processus llama-server.exe de l'hôte
// (WorkingSet + mémoire GPU attribuée par le pilote, lues par le controller).
// C'est la source de vérité de la colonne VRAM de l'UI, exposée à part pour
// pouvoir la vérifier sans passer par le proxy OpenAI.
app.get('/api/runtime/process-memory', async (req, res) => {
  try {
    const snapshot = await getRuntimeSnapshot();
    const runtime = snapshot.runtime;
    const instances = buildLoadedModelList(runtime);
    res.json({
      object: 'list',
      backend: runtime?.backend ?? null,
      gpu: runtime?.gpu ?? null,
      measured_at: new Date().toISOString(),
      data: instances.map((instance) => ({
        model: instance.model,
        filename: instance.filename,
        pid: instance.pid,
        port: instance.port,
        running: instance.running,
        context_length: instance.context_length,
        // Mémoire GPU attribuée au processus llama-server.exe (compteurs Windows)
        gpu_memory_bytes: instance.gpu_memory_bytes,
        gpu_memory_dedicated_bytes: instance.gpu_memory_dedicated_bytes,
        gpu_memory_shared_bytes: instance.gpu_memory_shared_bytes,
        // Mémoire système du processus
        process_memory_bytes: instance.process_memory_bytes,
        peak_process_memory_bytes: instance.peak_process_memory_bytes,
        // Valeur affichée par l'UI et son origine
        size_vram: instance.size_vram,
        size_vram_source: instance.size_vram_source,
      })),
    });
  } catch (error) {
    err(res, 502, error.message);
  }
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

// `/api/models/*` est DÉJÀ traité plus haut (l. ~5652) : Express s'arrête au
// premier handler qui matche, la seconde déclaration n'était donc atteinte que
// par `/models/*`. On la retire de la liste pour supprimer l'ambiguïté et le
// risque de divergence entre deux copies de la même table de routage.
app.all('/models/*', async (req, res) => {
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

// ── Injection du token dans la SPA ────────────────────────────────────────
// index.html est servi en SAME ORIGINE : le token inséré ici n'est lisible que
// par la page LIA-X elle-même. Un site tiers ne peut pas le lire (le navigateur
// applique l'origine), et il n'en a pas besoin puisque ses requêtes
// cross-origin sont bloquées par l'absence de CORS.
app.get('*', async (req, res, next) => {
  if (!API_TOKEN_ENFORCED) {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    return;
  }
  try {
    const indexPath = path.join(__dirname, 'dist', 'index.html');
    const html = await fs.promises.readFile(indexPath, 'utf8');
    const injected = html.replace(
      /<head>/i,
      `<head><script>window.__LIA_TOKEN__=${JSON.stringify(API_TOKEN)};</script>`,
    );
    res.type('html').send(injected);
  } catch (error) {
    next(error);
  }
});

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[LIA-X] UI: http://0.0.0.0:${PORT} -> controller: ${CONTROLLER_URL}`);
});

// Reconnaissance vocale du mode dialogue. Isolee dans un try/catch : une
// erreur ici (modele absent, dependance manquante) ne doit pas empecher le
// chat et le reste de l application de fonctionner.
try {
  require('./src/voice/voiceServer.cjs').attachVoiceServer(httpServer);
} catch (error) {
  console.warn('[voice] serveur vocal indisponible :', error.message);
}

// ---------------------------------------------------------------------------
// Initialisation de la base de données
//
// Lancée APRÈS app.listen : le conteneur doit être joignable même si PostgreSQL
// ne démarre pas ou met du temps. Le chat reste utilisable sans historique.
// ---------------------------------------------------------------------------
(async () => {
  const ready = await waitForDatabase(Number(process.env.POSTGRES_WAIT_MS || 60000));
  if (!ready) {
    console.warn('[db] historique indisponible pour cette session (chat conservé en mémoire)');
    return;
  }
  const result = await applySchema();
  if (!result.applied) {
    console.warn('[db] schéma non appliqué :', result.reason);
  }
})();

// Le worker OCR est un pool de threads qui survit à l'arrêt du serveur : sans
// cette libération explicite, `docker stop` attend le timeout au lieu de couper
// tout de suite.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    await extractors.releaseOcrWorker().catch(() => {});
    process.exit(0);
  });
}
