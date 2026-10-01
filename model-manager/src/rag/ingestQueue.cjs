// File d'ingestion asynchrone.
//
// L'indexation d'un file de 20 Mo demande plusieurs minutes de calcul de
// vecteurs. Réalisée pendant la requête HTTP, elle bloquerait le navigateur et
// finirait par expirer. Ici, la route n'accepte que le fichier et répond
// immédiatement ; le travail part en tâche de fond et l'interface suit l'état en
// interrogeant le file.
//
// La file est volontairement séquentielle : le modèle d'embeddings est une
// instance unique et partagée, deux indexations simultanées se marcheraient
// dessus et doubleraient le temps total.

const ragRepository = require('./repository.cjs');
const { chunkText, normalizeText, deriveTitle } = require('./chunking.cjs');
const { extractDocument, isSupported } = require('./extractors.cjs');
const { embedTexts, toPgVector } = require('./embeddings.cjs');
const {
  MAX_FILE_BYTES, MAX_DOCUMENT_CHARS, MAX_CHUNKS_PER_DOCUMENT, MAX_CHUNKS_PER_EMBED_BATCH,
} = require('./limits.cjs');


const EXPECTED_DIMENSIONS = 768;

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} Mo`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ko`;
  return `${bytes} o`;
}

/** Travail en cours : null si la file est vide. */
let currentJob = null;

/** Chaîne de promesses : chaque travail attend l'achèvement du précédent. */
let queue = Promise.resolve();

/**
 * Inscrit un file et démarre son indexation en tâche de fond.
 *
 * Les vérifications immédiates (format, taille) sont faites ici pour renvoyer
 * une erreur utile tout de suite ; le reste part en arrière-plan.
 *
 * @returns {Promise<object>} file créé, en état 'pending'
 */
async function enqueueDocument({ folderId, content, contentBase64, fileName, title }) {
  let buffer = null;
  if (typeof contentBase64 === 'string' && contentBase64.length > 0) {
    if (!isSupported(fileName)) {
      throw new Error(`Format de fichier non pris en charge : ${fileName || 'nom manquant'}`);
    }
    buffer = Buffer.from(contentBase64.replace(/\s/g, ''), 'base64');
    if (buffer.length === 0) throw new Error('Fichier reçu vide ou illisible');
    if (buffer.length > MAX_FILE_BYTES) {
      throw new Error(
        `Fichier trop volumineux (${formatBytes(buffer.length)}, maximum ${formatBytes(MAX_FILE_BYTES)}).`,
      );
    }
  } else if (typeof content === 'string' && content.trim()) {
    if (content.length > MAX_DOCUMENT_CHARS) {
      throw new Error(`Texte trop volumineux (${content.length} caractères, maximum ${MAX_DOCUMENT_CHARS}).`);
    }
    buffer = Buffer.from(content, 'utf8');
  } else {
    throw new Error('File vide : aucun contenu reçu');
  }

  // File créé immédiatement : l'interface peut l'afficher et suivre la
  // progression dès sa réponse, sans attendre la fin du calcul.
  // La fonction est async : il faut bien attendre, sinon `created` serait une
  // promesse et `created.id` vaudrait undefined.
  const created = await ragRepository.createPendingDocument({
    folderId,
    title: title || fileName || 'Fichier',
    sourcePath: fileName || null,
    sizeBytes: buffer.length,
  });

  queue = queue.then(() => runJob({
    documentId: created.id, buffer, fileName, isBase64: Boolean(contentBase64),
  })).catch((error) => {
    // runJob journalise et marque déjà l'échec : on avale ici pour ne pas
    // casser les travaux suivants de la file.
    console.error('[rag] travail en échec, file maintenue :', error?.message);
  });

  return created;
}

// ---------------------------------------------------------------------------
// Traitement
// ---------------------------------------------------------------------------

/** Exécute l'indexation complète d'un file. Les erreurs sont tracées. */
async function runJob({ documentId, buffer, fileName, isBase64 }) {
  currentJob = { id: documentId, cancelRequested: false };
  try {
    await ragRepository.markDocumentRunning(documentId, new Date());

    const text = isBase64 ? await extractDocument(buffer, fileName) : buffer.toString('utf8');

    if (text.length > MAX_DOCUMENT_CHARS) {
      throw new Error(
        `Texte extrait trop volumineux (${text.length} caractères, maximum ${MAX_DOCUMENT_CHARS}). `
        + 'Découpez le file en plusieurs fichiers.',
      );
    }

    const chunks = chunkText(normalizeText(text));
    if (chunks.length === 0) throw new Error('Aucun texte exploitable après nettoyage');
    if (chunks.length > MAX_CHUNKS_PER_DOCUMENT) {
      throw new Error(`File découpé en ${chunks.length} fragments, maximum ${MAX_CHUNKS_PER_DOCUMENT}.`);
    }

    await ragRepository.setDocumentProgress(documentId, { totalChunks: chunks.length });
    const contentHash = require('crypto').createHash('sha256').update(text, 'utf8').digest('hex');

    // Un lot à la fois : vecteurs puis écriture, en publiant la progression à
    // chaque lot. Le seuil était de 500 fragments, mais les lots font 64 :
    // 64 % 500 valant presque toujours 64, la progression restait à zéro et
    // l'interface semblait figée alors que le travail avançait.
    for (let offset = 0; offset < chunks.length; offset += MAX_CHUNKS_PER_EMBED_BATCH) {
      if (currentJob?.cancelRequested) throw new Error('Indexation annulée par l’utilisateur');

      const end = Math.min(offset + MAX_CHUNKS_PER_EMBED_BATCH, chunks.length);
      const batchChunks = chunks.slice(offset, end);
      // eslint-disable-next-line no-await-in-loop
      const vectors = await embedTexts(batchChunks, { batchSize: MAX_CHUNKS_PER_EMBED_BATCH });
      checkDimensions(vectors);

      // eslint-disable-next-line no-await-in-loop
      await ragRepository.appendChunks({
        documentId, startOrdinal: offset, chunks: batchChunks, vectors: vectors.map(toPgVector),
      });

      // Progression publiée à chaque lot : une requête UPDATE de plus en
      // quelques secondes n'a rien de coûteux face à l'indexation elle-même.
      // eslint-disable-next-line no-await-in-loop
      await ragRepository.setDocumentProgress(documentId, { doneChunks: end });
    }

    await ragRepository.markDocumentReady({
      documentId, contentHash, title: deriveTitle(text, fileName), totalChunks: chunks.length,
    });
    console.log(`[rag] ${fileName || 'file'} indexé (${chunks.length} fragments, ${text.length} caractères)`);
  } catch (error) {
    const message = String(error?.message || error);
    console.error(`[rag] échec indexation ${fileName || documentId} :`, message);
    // Un échec ne doit pas laisser de fragments partiels : markDocumentFailed
    // supprime aussi les fragments déjà écrits.
    await ragRepository.markDocumentFailed(documentId, message).catch(() => {});
  } finally {
    currentJob = null;
  }
}

function checkDimensions(vectors) {
  const wrong = vectors.find((vector) => vector.length !== EXPECTED_DIMENSIONS);
  if (wrong) {
    throw new Error(
      `Le modèle d’embeddings a renvoyé des vecteurs de ${wrong.length} dimension(s), `
      + `alors que la base en attend ${EXPECTED_DIMENSIONS}.`,
    );
  }
}

/** Demande l'annulation du travail en cours. */
function cancelCurrent() {
  if (currentJob) currentJob.cancelRequested = true;
  return Boolean(currentJob);
}

/** État de la file, pour l'interface. */
function getQueueState() {
  return { running: Boolean(currentJob), currentDocumentId: currentJob?.id ?? null };
}

module.exports = { enqueueDocument, cancelCurrent, getQueueState, formatBytes, EXPECTED_DIMENSIONS };
