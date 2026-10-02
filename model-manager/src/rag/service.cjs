// Service RAG : ingestion, recherche et construction du contexte injecté.
//
// Le modèle d'embeddings est local (llama.cpp). Une ingestion longue bloque
// l'instance d'embeddings, mais pas le chat : les deux tournent sur des ports
// distincts. C'est pourquoi l'ingestion est toujours jouée avant l'appel du
// modèle de chat, jamais pendant.

const crypto = require('crypto');
const { chunkText, normalizeText, deriveTitle } = require('./chunking.cjs');
const { extractDocument, isSupported } = require('./extractors.cjs');
const { embedTexts, toPgVector } = require('./embeddings.cjs');
const ragRepository = require('./repository.cjs');
const {
  MAX_FILE_BYTES,
  MAX_DOCUMENT_CHARS,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_CHUNKS_PER_EMBED_BATCH,
} = require('./limits.cjs');

/**
 * Aligne la base sur la dimension RÉELLEMENT produite par le modèle
 * d'embeddings sélectionné, au lieu de la supposer égale à 768.
 *
 * Pourquoi c'était nécessaire : la détection par métadonnées GGUF a rendu
 * sélectionnables des modèles autres que nomic (qwen3-embedding-0.6b,
 * embeddinggemma-300m…), dont la dimension diffère. Avec une constante 768,
 * ingérer un document avec l'un d'eux échouait sur une erreur demandant de
 * modifier le schéma SQL à la main — un défaut que le produit ne peut pas
 * demander à l'utilisateur.
 *
 * pgvector fige la dimension dans le type de la colonne : elle est donc lue
 * depuis PostgreSQL, puis alignée si besoin (cf. repository.cjs).
 *
 * @returns {Promise<{dimensions:number|null, migrated:boolean, purged:number}>}
 */
// Cache mémoire de la dimension de la colonne. La lire en base à chaque
// recherche coûtait une requête pg_attribute PAR MESSAGE (search() est le
// chemin chaud), pour une valeur qui ne change que lorsque NOUS la changeons.
let cachedEmbeddingDimension;
let cachedEmbeddingDimensionAt = 0;
const DIMENSION_CACHE_TTL_MS = 60000;

async function currentEmbeddingDimension() {
  const now = Date.now();
  if (cachedEmbeddingDimension !== undefined
    && (now - cachedEmbeddingDimensionAt) < DIMENSION_CACHE_TTL_MS) {
    return cachedEmbeddingDimension;
  }
  const dim = await ragRepository.getEmbeddingDimension();
  cachedEmbeddingDimension = dim;
  cachedEmbeddingDimensionAt = now;
  return dim;
}

/**
 * @param {number[][]} vectors  vecteurs nouvellement produits
 * @param {object}  [options]
 * @param {boolean} [options.allowMigrate=true]  false sur les chemins de
 *        LECTURE : une recherche ne doit jamais exécuter de DDL ni purger la
 *        table. Elle se contente de vérifier et d'expliquer.
 */
async function ensureVectorDimensions(vectors, options = {}) {
  const allowMigrate = options.allowMigrate !== false;
  const actual = vectors[0]?.length ?? null;
  if (!Number.isInteger(actual) || actual <= 0) {
    throw new Error('Le modèle d’embeddings a renvoyé un vecteur vide : dimension indéterminée.');
  }

  const expected = await currentEmbeddingDimension();
  if (expected === actual) {
    return { dimensions: actual, migrated: false, purged: 0 };
  }

  // Chemin de lecture : on refuse, on ne migre pas. Un ALTER TABLE + DELETE
  // déclenché par une recherche ouvrirait une transaction DDL au pire moment
  // et purgerait l'index sous les pieds de l'utilisateur.
  if (!allowMigrate) {
    throw new Error(
      `Le modèle d’embeddings produit des vecteurs de ${actual} dimension(s) `
      + `mais la base en attend ${expected ?? 'inconnue'}. `
      + 'Ré-ingérez un document pour réaligner la base automatiquement, '
      + 'ou changez de modèle d’embeddings.',
    );
  }

  const result = await ragRepository.migrateEmbeddingDimension(actual);
  // La migration vient de changer la colonne : le cache doit sauter.
  cachedEmbeddingDimension = undefined;
  cachedEmbeddingDimensionAt = 0;
  if (!result.changed) {
    throw new Error(
      `Le modèle d’embeddings produit des vecteurs de ${actual} dimension(s) `
      + `mais la base en attend ${expected ?? 'inconnue'} : ${result.reason || 'alignement impossible'}.`,
    );
  }

  // Les fragments de l'ancienne dimension ont été purgés : les fichiers
  // concernés doivent être réindexés, on le dit explicitement plutôt que de
  // laisser une recherche silencieusement vide.
  return { dimensions: actual, migrated: true, purged: result.purged };
}

// Fenêtre de contexte injectée dans le prompt, en caractères.
const DEFAULT_MAX_CONTEXT_CHARS = 6000;

function hashContent(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Ingère un fichier dans un dossier.
 *
 * Accepte deux transports : `content` (texte brut, pour un collage direct) ou
 * `contentBase64` (fichier binaire encodé, pour un téléversement). Le second
 * passe par les extracteurs de format ; le premier est traité directement.
 *
 * @returns {Promise<object>} résumé de l'ingestion
 */
async function ingestDocument({ folderId, content, contentBase64, fileName, title }) {
  const hasBase64 = typeof contentBase64 === 'string' && contentBase64.length > 0;
  const hasText = typeof content === 'string' && content.trim().length > 0;

  if (!hasBase64 && !hasText) {
    throw new Error('File vide : aucun contenu reçu');
  }

  let text;
  if (hasBase64) {
    if (!isSupported(fileName)) {
      throw new Error(`Format de fichier non pris en charge : ${fileName || 'nom manquant'}`);
    }
    // Le base64 gonfle le fichier d'environ 33 % : on borne la charge utile,
    // pas la chaîne reçue, et on tolère les espaces de fin de ligne.
    const buffer = Buffer.from(contentBase64.replace(/\s/g, ''), 'base64');
    if (buffer.length === 0) {
      throw new Error('Fichier reçu vide ou illisible');
    }
    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error(
        `Fichier trop volumineux (${formatBytes(buffer.length)}, maximum ${formatBytes(MAX_FILE_BYTES)}).`,
      );
    }
    text = await extractDocument(buffer, fileName);
  } else {
    if (content.length > MAX_DOCUMENT_CHARS) {
      throw new Error(
        `Texte trop volumineux (${content.length} caractères, maximum ${MAX_DOCUMENT_CHARS}).`,
      );
    }
    text = content;
  }

  if (text.length > MAX_DOCUMENT_CHARS) {
    throw new Error(
      `Texte extrait trop volumineux (${text.length} caractères, maximum ${MAX_DOCUMENT_CHARS}). `
      + 'Découpez le file en plusieurs fichiers.',
    );
  }

  const folder = await ragRepository.getFolder(folderId);
  if (!folder) throw new Error('Folder introuvable');

  const chunks = chunkText(normalizeText(text));

  if (chunks.length === 0) {
    throw new Error('Aucun texte exploitable après nettoyage');
  }
  if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
    throw new Error(
      `File découpé en ${chunks.length} fragments, maximum ${MAX_CHUNKS_PER_DOCUMENT}.`,
    );
  }

  // Embeddings par lots : un file de plusieurs milliers de fragments doit
  // être découpé en requêtes, sinon le modèle sature et la requête expire.
  const vectors = await embedTexts(chunks, { batchSize: MAX_CHUNKS_PER_EMBED_BATCH });
  await ensureVectorDimensions(vectors);

  // Taille réelle du fichier source, pour la colonne « Taille » de
  // l'explorateur. `buffer` n'existe que sur le chemin base64 : sur le chemin
  // texte brut, la taille se déduit de la chaîne reçue. Le client ne fournit
  // pas de taille fiable, et c'est le texte réellement indexé qui est mesuré.
  const sizeBytes = hasBase64
    ? Buffer.from(contentBase64.replace(/\s/g, ''), 'base64').length
    : Buffer.byteLength(content, 'utf8');

  const file = await ragRepository.insertDocument({
    folderId,
    title: title || deriveTitle(text, fileName),
    sourcePath: fileName || null,
    contentHash: hashContent(text),
    sizeBytes,
    chunks,
    vectors: vectors.map(toPgVector),
  });

  return {
    file: { ...file, chunk_count: chunks.length },
    folderName: folder.name,
    chunkCount: chunks.length,
    characters: text.length,
  };
}

/** Taille lisible pour les messages d'erreur destinés à l'utilisateur. */
function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} Mo`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${bytes} o`;
}

/**
 * Recherche les fragments pertinents pour une question.
 * @returns {Promise<Array>} passages avec score de similarité
 */
async function search(query, { folderIds = [], limit = 5, minSimilarity = 0.3 } = {}) {
  const text = String(query || '').trim();
  if (!text) return [];

  const vector = await embedText_(text);
  if (!vector) return [];
  // Chemin de LECTURE : aucune migration ici. Si la dimension a changé, il
  // faut ré-ingérer — une recherche ne purge pas la base.
  await ensureVectorDimensions([vector], { allowMigrate: false });

  return ragRepository.searchChunks(toPgVector(vector), {
    folderIds,
    limit,
    minSimilarity,
  });
}

async function embedText_(text) {
  const [vector] = await embedTexts([text]);
  return vector;
}

/**
 * Construit le bloc de contexte injecté dans le prompt système.
 *
 * Format volontairement explicite et numéroté : le modèle doit pouvoir citer
 * une source (« selon [2] ») et l'utilisateur retrouver le passage.
 */
function buildContextBlock(passages, { maxChars = DEFAULT_MAX_CONTEXT_CHARS } = {}) {
  if (!Array.isArray(passages) || passages.length === 0) return '';

  const header = 'Files de référence (extraits trouvés par recherche vectorielle) :';
  const parts = [];
  let used = 0;

  for (const passage of passages) {
    const reference = `[${passage.title || 'Sans titre'}]`;
    // On tronque chaque passage pour qu'un fragment surdimensionné ne mange pas
    // à lui seul toute la fenêtre de contexte.
    const body = passage.content.length > 1200
      ? `${passage.content.slice(0, 1200)}…`
      : passage.content;
    const block = `\n[${parts.length + 1}] ${reference}\n${body}`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length;
  }

  if (parts.length === 0) return '';
  return `${header}${parts.join('')}`;
}

/**
 * Prompt système injecté avant l'historique quand le RAG est actif.
 */
function buildSystemPrompt(question) {
  return [
    'Tu es l’assistant de LIA-X, un assistant local fonctionnant entièrement hors ligne.',
    '',
    'Des extraits de files de référence te sont fournis ci-dessous. Utilise-les pour '
    + 'répondre précisément quand ils sont pertinents.',
    'Règles :',
    '- Cite la source entre crochets, par exemple [1], quand tu t’appuies sur un extrait.',
    '- Si les extraits ne permettent pas de répondre, dis-le clairement et réponds '
    + 'avec tes connaissances générales sans inventer de source.',
    '- Ne reconstruis jamais une information absente des extraits.',
    '',
    `Question de l’utilisateur : ${question}`,
  ].join('\n');
}

module.exports = {
  ingestDocument,
  search,
  buildContextBlock,
  buildSystemPrompt,
  hashContent,
  formatBytes,
  ensureVectorDimensions,
  DEFAULT_MAX_CONTEXT_CHARS,
  MAX_FILE_BYTES,
  MAX_DOCUMENT_CHARS,
  MAX_CHUNKS_PER_DOCUMENT,
};
