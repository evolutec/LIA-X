'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const app = express();
app.use(express.json({ limit: '10mb' }));

const CONTROLLER_URL = (process.env.LLAMA_HOST_CONTROL_URL || 'http://host.docker.internal:13579').replace(/\/$/, '');
const LLAMA_SERVER_BASE_URL = (process.env.LLAMA_SERVER_BASE_URL || 'http://host.docker.internal:12434').replace(/\/$/, '');
const MODEL_STORAGE_DIR = process.env.MODEL_STORAGE_DIR || path.join(__dirname, 'models');
const PORT = Number(process.env.MODEL_MANAGER_PORT || 3002);
const PROXY_MODEL_ID = process.env.PROXY_MODEL_ID || 'lia-local';
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
  return res.status(status).json({ detail: message });
}

async function controllerRequest(endpoint, options = {}) {
  const response = await fetch(`${CONTROLLER_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const detail = typeof payload === 'object' && payload?.detail ? payload.detail : payload || response.statusText;
    throw new Error(String(detail));
  }

  return payload;
}

async function getRuntimeStatus() {
  return controllerRequest('/status', { method: 'GET' });
}

async function ensureRuntimeReady(preferredModel) {
  let runtimeStatus = await getRuntimeStatus();
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
  if (!runtimeStatus?.running || !runtimeStatus?.active_model) {
    return [];
  }

  return [{
    id: PROXY_MODEL_ID,
    object: 'model',
    owned_by: 'lia',
    permission: [],
    active_model: runtimeStatus.active_model,
    backend: runtimeStatus.backend,
  }];
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

    const response = await fetch(`${LLAMA_SERVER_BASE_URL}${endpoint}`, {
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
    res.json({ ok: true, runtime: runtimeStatus });
  } catch (error) {
    res.status(502).json({ ok: false, detail: error.message });
  }
});

app.get('/api/version', async (req, res) => {
  try {
    const runtime = await getRuntimeStatus();
    res.json({
      version: runtime?.backend_label ? `llama.cpp · ${runtime.backend_label}` : 'llama.cpp',
      device: runtime?.backend_label || 'Runtime indisponible',
      model_dir: MODEL_STORAGE_DIR,
      runtime_url: `${LLAMA_SERVER_BASE_URL}/v1`,
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/models/available', async (req, res) => {
  try {
    const [runtime, models] = await Promise.all([getRuntimeStatus(), listLocalModels()]);
    const runningActiveModel = runtime?.running ? runtime.active_model : '';
    const files = models
      .filter((item) => item.name !== runningActiveModel)
      .map((item) => ({
        name: item.name,
        filename: item.filename,
        size: item.size,
        modified_at: item.modified_at,
      }));
    res.json({ files });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/models', async (req, res) => {
  try {
    const runtime = await getRuntimeStatus();
    if (!runtime?.running || !runtime?.active_model) {
      return res.json({ models: [] });
    }

    const model = await resolveModel(runtime.active_model);
    res.json({
      models: [{
        id: PROXY_MODEL_ID,
        model: runtime.active_model,
        size_vram: null,
        expires_at: runtime.started_at || null,
        filename: model.filename,
      }],
    });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/models/active', async (req, res) => {
  try {
    const runtime = await getRuntimeStatus();
    res.json({ active_model: runtime?.running ? (runtime.active_model || '') : '' });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.get('/api/models/status', async (req, res) => {
  try {
    const [runtime, models] = await Promise.all([getRuntimeStatus(), listLocalModels()]);
    res.json({
      total_models: models.length,
      running_models: runtime?.running ? 1 : 0,
      gpu: { device: runtime?.backend_label || 'Runtime indisponible' },
      models: runtime?.running && runtime?.active_model ? [{
        model: runtime.active_model,
        device: runtime.backend_label,
        approx_memory_bytes: 0,
      }] : [],
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
    await controllerRequest('/start', {
      method: 'POST',
      body: JSON.stringify(startRequest.payload),
    });
    res.json({
      model: startRequest.model.name,
      status: 'loaded',
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
    await controllerRequest('/start', {
      method: 'POST',
      body: JSON.stringify(startRequest.payload),
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
    const runtime = await getRuntimeStatus();
    await controllerRequest('/stop', { method: 'POST', body: JSON.stringify({}) });
    res.json({ model: runtime?.active_model || '', status: 'unloaded' });
  } catch (error) {
    err(res, 502, error.message);
  }
});

app.delete('/api/models/files/:filename', async (req, res) => {
  try {
    const model = await resolveModel(decodeURIComponent(req.params.filename));
    const runtime = await getRuntimeStatus();
    if (runtime?.active_model === model.name) {
      await controllerRequest('/stop', { method: 'POST', body: JSON.stringify({}) });
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

app.post('/api/cache/drop', async (req, res) => {
  res.status(501).json({ ok: false, error: 'Non applicable sur le runtime Windows llama.cpp.' });
});

app.get('/v1/models', async (req, res) => {
  try {
    const runtime = await ensureRuntimeReady();
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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Model Loader] UI: http://0.0.0.0:${PORT} -> controller: ${CONTROLLER_URL}`);
});
