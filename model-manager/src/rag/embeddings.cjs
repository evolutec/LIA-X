// Génération d'embeddings pour le RAG.
//
// Les vecteurs sont produits par l'instance llama.cpp du modèle d'embeddings,
// via l'endpoint /v1/embeddings déjà exposé par le proxy. On parle à notre
// propre serveur (localhost:PORT) plutôt qu'à llama-server directement : le
// proxy gère l'autochargement, le drapeau --embedding et le routage.

const http = require('http');
const https = require('https');

// Taille de lot par défaut. Un document de plusieurs milliers de fragments est
// découpé en plusieurs requêtes : llama.cpp sature au-delà de quelques dizaines
// d'entrées simultanées.
const DEFAULT_MAX_INPUTS_PER_CALL = 8;
// Garde-fou : au-delà, la requête HTTP dépasse les délais par défaut du client.
// 8 minutes : un lot de 64 fragments sur CPU, avec le modèle qui doit être
// chargé, peut legitimement prendre plusieurs minutes.
const REQUEST_TIMEOUT_MS = 480000;

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const transport = port === 443 ? https : http;
    const request = transport.request(
      { host: '127.0.0.1', port, path, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`/v1/embeddings a répondu ${response.statusCode} : ${text.slice(0, 300)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch {
            reject(new Error('Réponse /v1/embeddings illisible'));
          }
        });
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => {
      request.destroy(new Error(`Timeout après ${REQUEST_TIMEOUT_MS} ms sur /v1/embeddings`));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

/**
 * Calcule les embeddings d'une liste de textes.
 * @returns {Promise<number[][]>} un vecteur par texte, dans le même ordre.
 */
async function embedTexts(texts, options = {}) {
  const cleaned = texts.map((text) => String(text ?? '').trim()).filter(Boolean);
  if (cleaned.length === 0) return [];

  const port = Number(options.port || process.env.MODEL_MANAGER_PORT || 3005);
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || DEFAULT_MAX_INPUTS_PER_CALL, 128));
  const vectors = [];

  for (let offset = 0; offset < cleaned.length; offset += batchSize) {
    const batch = cleaned.slice(offset, offset + batchSize);
    const body = { input: batch };
    if (options.model) body.model = options.model;

    // eslint-disable-next-line no-await-in-loop
    const data = await postJson(port, '/v1/embeddings', body);
    const items = Array.isArray(data?.data) ? data.data : [];

    if (items.length !== batch.length) {
      throw new Error(
        `Le modèle d’embeddings a renvoyé ${items.length} vecteur(s) pour ${batch.length} texte(s) :(index de batch ${offset})`,
      );
    }
    for (const item of items) {
      const vector = item?.embedding;
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('Vecteur d’embedding vide ou invalide');
      }
      // eslint-disable-next-line no-await-in-loop
      vectors.push(vector.map(Number));
    }
  }
  return vectors;
}

/** Embedding d'un texte unique. */
async function embedText(text, options = {}) {
  const vectors = await embedTexts([text], options);
  return vectors[0] || null;
}

/**
 * Formate un vecteur pour pgvector : [0.123,-0.456,...]
 *
 * Le séparateur décimal DOIT être un point : avec une locale française,
 * String(0.5) reste « 0.5 » en JS, mais on formate explicitement en
 * `toFixed` + slice pour éviter toute surprise de locale côté PostgreSQL.
 */
function toPgVector(vector) {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const parts = vector.map((value) => {
    const number = Number(value);
    // Number.isFinite exclut NaN comme Infinity : toFixed les rendrait
    // respectivement "NaN" et "Infinity", rejetés par le cast vector de pgvector.
    if (!Number.isFinite(number)) return '0';
    // 8 décimales suffisent pour une similarité cosinus tout en gardant
    // une chaîne raisonnable pour des vecteurs de 768 dimensions.
    return number.toFixed(8);
  });
  return `[${parts.join(',')}]`;
}

module.exports = { embedTexts, embedText, toPgVector };
