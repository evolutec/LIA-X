'use strict';

const express = require('express');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
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

// Circuit Breaker état global
const CIRCUIT_BREAKER = {
  open: false,
  failures: 0,
  lastFailure: 0,
  resetTimeout: 10000,
  maxFailures: 5
};

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

function pushLogEntry(origin, source, type, message) {
  const entry = {
    origin,
    source,
    type,
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

function logRequest(method, path, payload) {
  console.log('[model-manager] incoming', method, path, payload || 'no payload');
  pushLogEntry('server', path || 'server', 'info', `${method} ${path} ${payload ? JSON.stringify(payload) : ''}`);
}

function logError(path, error) {
  console.error('[model-manager] error', path, error?.stack || error);
  pushLogEntry('server', path || 'server', 'error', error?.stack || error || 'Unknown error');
}

app.use((req, res, next) => {
  logRequest(req.method, req.originalUrl, req.body);
  next();
});

const CONTROLLER_URL = (process.env.LLAMA_HOST_CONTROL_URL || 'http://host.docker.internal:13579').replace(/\/$/, '');
const CONTROLLER_HOST_LAUNCHER_URL = (process.env.CONTROLLER_HOST_LAUNCHER_URL || 'http://host.docker.internal:13580').replace(/\/$/, '');
const LLAMA_SERVER_BASE_URL = (process.env.LLAMA_SERVER_BASE_URL || 'http://host.docker.internal:12434').replace(/\/$/, '');
const MODEL_STORAGE_DIR = process.env.MODEL_STORAGE_DIR || path.join(__dirname, 'models');
const RUNTIME_STATE_PATH = process.env.RUNTIME_STATE_PATH || '/runtime/host-runtime-state.json';
const PORT = Number(process.env.MODEL_MANAGER_PORT || 3002);
const PROXY_MODEL_ID = process.env.PROXY_MODEL_ID || 'lia-local';
const DOCKER_INTERNAL = String(process.env.DOCKER_INTERNAL || 'false').toLowerCase() === 'true';
const CONTROLLER_START_TIMEOUT_MS = Number(process.env.CONTROLLER_START_TIMEOUT_MS || '120000');
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
    return {
      version,
      tensor_count: tensorCount,
      kv_count: kvCount,
      architecture,
      context_length: contextLength,
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

async function buildModelStartRequest(identifier) {
  const model = await resolveModel(identifier);
  const details = await getModelGgufDetails(model);
  const payload = {
    model: model.filename,
  };

  if (Number.isInteger(details.context_length) && details.context_length > 0) {
    payload.context = details.context_length;
  }

  return {
    model,
    details,
    payload,
  };
}

app.use(express.static(path.join(__dirname, 'dist')));

function err(res, status, message) {
  logError(res.req?.originalUrl || 'unknown', message);
  return res.status(status).json({ detail: message });
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

  // Compatibilité NodeJS < 18: AbortController manuel
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || 15000);
  
  try {
    const response = await fetch(`${CONTROLLER_URL}${endpoint}`, {
      ...options,
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

    logRequest('CONTROLLER-RAW-RESPONSE', endpoint, { status: response.status, text, payload });

    if (!response.ok) {
      const detail = typeof payload === 'object' && payload?.detail ? payload.detail : payload || response.statusText;
      CIRCUIT_BREAKER.failures += 1;
      CIRCUIT_BREAKER.lastFailure = Date.now();
      if (CIRCUIT_BREAKER.failures >= CIRCUIT_BREAKER.maxFailures) {
        CIRCUIT_BREAKER.open = true;
      }
      logError(endpoint, `Controller response ${response.status}: ${detail}`);
      pushLogEntry('controller', endpoint, 'error', `Controller response ${response.status}: ${detail}`);
      throw new Error(String(detail));
    }

    logRequest('CONTROLLER-RESPONSE', endpoint, { status: response.status, payload });
    pushLogEntry('controller', endpoint, 'info', `Controller response ${response.status}`);

    // Réinitialiser Circuit Breaker en cas de succès
    CIRCUIT_BREAKER.failures = 0;
    CIRCUIT_BREAKER.open = false;

    // Invalidate the cached runtime status after state-changing controller calls.
    if (['/start', '/stop', '/restart'].includes(endpoint)) {
      invalidateStatusCache();
    }

    return payload;
  
  } finally {
    clearTimeout(timeout);
  }
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

async function readRuntimeStateFallback() {
  try {
    const raw = await fs.promises.readFile(RUNTIME_STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.length > 0 ? parsed[0] : null;
    }

    return parsed;
  } catch {
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
  if (runtime?.active_model) {
    return runtime.active_model;
  }

  const instances = Array.isArray(runtime?.instances)
    ? runtime.instances
    : runtime?.instances
      ? [runtime.instances]
      : [];

  const activeFlaggedInstance = instances.find((instance) => Boolean(instance.active));
  if (activeFlaggedInstance) {
    return activeFlaggedInstance.model;
  }

  const runningInstance = instances.find((instance) => Boolean(instance.running));

  return runningInstance?.model || '';
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

function buildLoadedModelList(runtime) {
  const instances = Array.isArray(runtime?.instances)
    ? runtime.instances
    : runtime?.instances
      ? [runtime.instances]
      : [];
  const activeModel = resolveActiveModel(runtime);

  const loaded = instances
    .filter((instance) => isProjectInstance(instance))
    .map((instance) => ({
      id: instance.model || instance.proxy_id || `${PROXY_MODEL_ID}-${instance.port}`,
      model: instance.model,
      filename: instance.filename,
      port: instance.port,
      running: Boolean(instance.running),
      size_vram: instance.estimated_vram_bytes ?? null,
      expires_at: instance.started_at || null,
      active: activeModel ? instance.model === activeModel : Boolean(instance.active),
    }))
    .filter((item) => Boolean(item.model));

  if (loaded.length === 0 && activeModel) {
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
          return lines.map((line) => ({
            origin: 'container',
            source: source || String(containerIdentifier),
            type: entry.streamType === 2 ? 'stderr' : 'stdout',
            message: line,
          }));
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

async function getPerformanceMetrics() {
  const discoveredGpus = await probeGpuInfo();
  const runtime = await getRuntimeStatus().catch(() => null);
  const hardware = [
    ...getCpuSnapshot(),
    ...(discoveredGpus.length > 0 ? discoveredGpus : getRuntimeGpuFallback(runtime)),
  ];

  return {
    system: {
      platform: os.platform(),
      arch: os.arch(),
      uptime_seconds: Math.floor(os.uptime()),
      hostname: os.hostname(),
    },
    memory: {
      total_bytes: os.totalmem(),
      free_bytes: os.freemem(),
      used_bytes: os.totalmem() - os.freemem(),
    },
    hardware,
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

async function ensureRuntimeReady(preferredModel) {
  const runtimeStatus = await getRuntimeStatus();
  const activeModel = runtimeStatus?.active_model || runtimeStatus?.active_filename;

  if (preferredModel && preferredModel !== PROXY_MODEL_ID && preferredModel !== activeModel) {
    const startRequest = await buildModelStartRequest(preferredModel);
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
  const safeBase = String(name || filenameFromUrl(url)).trim();
  const targetFilename = safeBase.toLowerCase().endsWith('.gguf') ? safeBase : `${safeBase}.gguf`;
  const targetPath = path.join(MODEL_STORAGE_DIR, targetFilename);

  if (fs.existsSync(targetPath)) {
    throw new Error(`Le fichier existe déjà : ${targetFilename}`);
  }

  await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(targetPath));
  return {
    filename: targetFilename,
    model: toModelId(targetFilename),
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

  await pipeline(Readable.fromWeb(blobResponse.body), fs.createWriteStream(targetPath));
  return {
    filename: targetFilename,
    model: toModelId(targetFilename),
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
    }))
    .filter((entry, index, array) => array.findIndex((item) => item.id === entry.id) === index);
}

function translateToDockerHost(url) {
  if (!DOCKER_INTERNAL || typeof url !== 'string') {
    return url;
  }

  return url
    .replace(/^http:\/\/127\.0\.0\.1(:\d+)/i, 'http://host.docker.internal$1')
    .replace(/^http:\/\/localhost(:\d+)/i, 'http://host.docker.internal$1');
}

function getRuntimeBaseUrl(runtimeStatus) {
  if (!runtimeStatus || typeof runtimeStatus !== 'object') {
    return translateToDockerHost(LLAMA_SERVER_BASE_URL);
  }

  const instances = Array.isArray(runtimeStatus.instances)
    ? runtimeStatus.instances
    : runtimeStatus.instances
      ? [runtimeStatus.instances]
      : [];

  const activeInstance = instances.find((instance) => Boolean(instance.active) || Boolean(instance.running));
  if (activeInstance?.server_base_url) {
    return translateToDockerHost(String(activeInstance.server_base_url).replace(/\/v1\/?$/, '').replace(/\/$/, ''));
  }

  if (typeof runtimeStatus.server_port === 'number' && runtimeStatus.server_port > 0) {
    return translateToDockerHost(`http://127.0.0.1:${runtimeStatus.server_port}`);
  }

  return translateToDockerHost(LLAMA_SERVER_BASE_URL);
}

async function proxyOpenAiRequest(req, res, endpoint) {
  try {
    const preferredModel = typeof req.body?.model === 'string' && req.body.model !== PROXY_MODEL_ID
      ? req.body.model
      : undefined;
    const runtimeStatus = await ensureRuntimeReady(preferredModel);
    if (!runtimeStatus?.running || !runtimeStatus?.active_model) {
      return err(res, 503, 'Aucun modèle actif côté llama.cpp');
    }

    const payload = { ...(req.body || {}) };
    const upstreamModel = runtimeStatus.active_filename || runtimeStatus.active_model;
    if (!payload.model || payload.model === PROXY_MODEL_ID) {
      payload.model = upstreamModel;
    }

    const runtimeUrl = getRuntimeBaseUrl(runtimeStatus);
    const response = await fetch(`${runtimeUrl}${endpoint}`, {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      const lower = key.toLowerCase();
      if (!['content-length', 'transfer-encoding', 'connection'].includes(lower)) {
        res.setHeader(key, value);
      }
    });

    if (!response.body) {
      res.end(await response.text());
      return;
    }

    await pipeline(Readable.fromWeb(response.body), res);
  } catch (error) {
    if (!res.headersSent) {
      err(res, 502, error.message);
    } else {
      res.end();
    }
  }
}

app.get('/health', async (req, res) => {
  try {
    const runtimeStatus = await getRuntimeStatus();
    res.json({ ok: true, controller_ok: true, runtime: runtimeStatus });
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
    const runningActiveModel = resolveActiveModel(runtime);
    const models = await listLocalModels();
    const files = models
      .filter((item) => item.name !== runningActiveModel)
      .map((item) => ({
        name: item.name,
        filename: item.filename,
        size: item.size,
        modified_at: item.modified_at,
      }));
    res.json({ files, source: snapshot.source });
  } catch (error) {
    err(res, 502, error.message);
  }
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

app.get('/api/models/status', async (req, res) => {
  try {
    const [snapshot, models] = await Promise.all([getRuntimeSnapshot(), listLocalModels()]);
    const runtime = snapshot.runtime;
    const loadedModels = buildLoadedModelList(runtime);
    const runtimeLogs = extractLogEntries(runtime);
    const containerLogs = await collectContainerLogs();
    const logEntries = [...getRecentLogEntries(), ...runtimeLogs, ...containerLogs];

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

app.post('/api/models/load', async (req, res) => {
  try {
    const startRequest = await buildModelStartRequest(req.body?.model);
    const payload = { ...startRequest.payload, activate: false };
    console.log('[model-manager] /api/models/load', { model: startRequest.model.name, payload });
    await controllerRequest('/start', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeout: CONTROLLER_START_TIMEOUT_MS,
    });
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
    const startRequest = await buildModelStartRequest(req.body?.model);
    const payload = { ...startRequest.payload, activate: true };
    console.log('[model-manager] /api/models/select', { model: startRequest.model.name, payload });
    await controllerRequest('/start', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeout: CONTROLLER_START_TIMEOUT_MS,
    });
    res.json({
      active_model: startRequest.model.name,
      context_applied: startRequest.payload.context || null,
      architecture: startRequest.details.architecture || null,
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
    const runtime = await getRuntimeStatus();
    await controllerRequest('/stop', { method: 'POST', body: JSON.stringify({ model: modelName }) });
    res.json({ model: modelName, status: 'unloaded' });
  } catch (error) {
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
    res.json({ object: 'list', data: proxyModelPayload(runtime) });
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
  await proxyOpenAiRequest(req, res, '/v1/embeddings');
});

app.get('/models', async (req, res) => {
  try {
    const snapshot = await getRuntimeSnapshot();
    const runtime = snapshot.runtime;
    res.json({ object: 'list', data: proxyModelPayload(runtime) });
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
