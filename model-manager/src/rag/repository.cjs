// Repository RAG : ingestion des files et recherche par similarité.
//
// Toutes les valeurs passent par des paramètres $1..$n. Le vecteur de la
// requête est injecté comme littéral pgvector APRÈS validation stricte par
// toPgVector(), jamais par concaténation directe.

const { query, getPool } = require('../db/pool.cjs');

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

async function listFolders() {
  const result = await query(
    `SELECT c.id, c.name, c.description, c.parent_id, c.created_at,
            COALESCE(d.doc_count, 0) AS document_count,
            COALESCE(d.total_bytes, 0) AS total_bytes,
            COALESCE(k.chunk_count, 0) AS chunk_count
       FROM folders c
       LEFT JOIN (
         SELECT folder_id, COUNT(*) AS doc_count, SUM(size_bytes) AS total_bytes
           FROM files GROUP BY folder_id
       ) d ON d.folder_id = c.id
       LEFT JOIN (
         SELECT dc.folder_id, COUNT(*) AS chunk_count
           FROM chunks ch
           JOIN files dc ON dc.id = ch.file_id
          GROUP BY dc.folder_id
       ) k ON k.folder_id = c.id
      ORDER BY lower(c.name) ASC`,
  );
  return result.rows;
}

/**
 * Contenu d'un dossier : ses sous-dossiers et ses fichiers.
 *
 * `folderId` absent ou vide désigne la racine (liste des dossiers de premier
 * niveau). La racine n'a pas de dossier propre, donc aucun fichier à lister :
 * la clause WHERE distingue les deux cas sans seconde requête.
 */
async function listFolderContents(folderId) {
  const hasFolder = typeof folderId === 'string' && folderId.length > 0;
  const key = hasFolder ? folderId : null;

  const folders = await query(
    `SELECT c.id, c.name, c.description, c.parent_id, c.created_at,
            COALESCE(d.doc_count, 0) AS document_count,
            COALESCE(d.total_bytes, 0) AS total_bytes,
            COALESCE(k.chunk_count, 0) AS chunk_count
       FROM folders c
       LEFT JOIN (
         SELECT folder_id, COUNT(*) AS doc_count, SUM(size_bytes) AS total_bytes
           FROM files GROUP BY folder_id
       ) d ON d.folder_id = c.id
       LEFT JOIN (
         SELECT dc.folder_id, COUNT(*) AS chunk_count
           FROM chunks ch
           JOIN files dc ON dc.id = ch.file_id
          GROUP BY dc.folder_id
       ) k ON k.folder_id = c.id
      WHERE c.parent_id IS NOT DISTINCT FROM $1::uuid
      ORDER BY lower(c.name) ASC`,
    [key],
  );

  const files = hasFolder
    ? await query(
      `SELECT d.id, d.folder_id, d.source_path, d.title, d.content_hash,
              d.size_bytes, d.created_at, d.updated_at,
              d.ingest_status, d.total_chunks, d.done_chunks, d.error_detail,
              d.started_at, d.finished_at,
              (SELECT COUNT(*) FROM chunks ch WHERE ch.file_id = d.id) AS chunk_count
         FROM files d
        WHERE d.folder_id = $1::uuid
        ORDER BY lower(COALESCE(d.title, d.source_path, '')) ASC`,
      [folderId],
    )
    : { rows: [] };

  return { folders: folders.rows, files: files.rows };
}

/**
 * Fil d'Ariane : du dossier demandé jusqu'à la racine, puis inversé.
 *
 * Une requête récursive est nécessaire : la profondeur n'est pas bornée, et une
 * boucle JavaScript ferait autant d'allers-retours que la profondeur. La borne
 * depth < 64 protège d'une boucle infinie si des données corrompues faisaient
 * référence à elles-mêmes.
 */
async function listFolderAncestors(folderId) {
  const result = await query(
    `WITH RECURSIVE ancestry(id, name, parent_id, depth) AS (
       SELECT id, name, parent_id, 0 FROM folders WHERE id = $1::uuid
       UNION ALL
       SELECT f.id, f.name, f.parent_id, a.depth + 1
         FROM folders f
         JOIN ancestry a ON a.parent_id = f.id
        WHERE a.depth < 64
     )
     SELECT id, name, parent_id, depth FROM ancestry ORDER BY depth DESC`,
    [folderId],
  );
  return result.rows;
}

/**
 * Vrai si `candidateParentId` est le dossier lui-même ou l'un de ses
 * descendants : y déplacer le dossier créerait un cycle, et l'explorateur
 * afficherait une arborescence infinie.
 */
async function wouldCreateCycle(folderId, candidateParentId) {
  if (!candidateParentId) return false;
  if (candidateParentId === folderId) return true;
  const result = await query(
    `WITH RECURSIVE descendants(id) AS (
       SELECT id FROM folders WHERE parent_id = $1::uuid
       UNION ALL
       SELECT f.id FROM folders f JOIN descendants d ON f.parent_id = d.id
      WHERE d.id IS DISTINCT FROM $1::uuid
     )
     SELECT 1 FROM descendants WHERE id = $2::uuid LIMIT 1`,
    [folderId, candidateParentId],
  );
  return result.rowCount > 0;
}

/**
 * Un dossier ne porte un nom que s'il est unique parmi ses frères.
 *
 * La comparaison ignore la casse : « Notes » et « notes » sont le même nom
 * pour un humain, et les deux dans la même colonne seraient ambigus.
 */
async function isDuplicateName({ name, parentId, excludeId }) {
  const result = await query(
    `SELECT 1 FROM folders
      WHERE lower(name) = lower($1)
        AND parent_id IS NOT DISTINCT FROM $2::uuid
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      LIMIT 1`,
    [name, parentId || null, excludeId || null],
  );
  return result.rowCount > 0;
}

async function createFolder({ name, description, parentId }) {
  const result = await query(
    'INSERT INTO folders (name, description, parent_id) VALUES ($1, $2, $3) RETURNING *',
    [name, description || null, parentId || null],
  );
  return result.rows[0];
}

async function getFolder(id) {
  const result = await query('SELECT * FROM folders WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function renameFolder(id, name) {
  const result = await query(
    'UPDATE folders SET name = $2 WHERE id = $1 RETURNING *',
    [id, name],
  );
  return result.rows[0] || null;
}

/** Déplace un dossier. `parentId` à null le remonte à la racine. */
async function moveFolder(id, parentId) {
  const result = await query(
    'UPDATE folders SET parent_id = $2 WHERE id = $1 RETURNING *',
    [id, parentId || null],
  );
  return result.rows[0] || null;
}

async function deleteFolder(id) {
  // files, chunks et sous-dossiers partent en cascade.
  const result = await query('DELETE FROM folders WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

/**
 * Espaces de travail auxquels un dossier est rattaché.
 *
 * C'est l'inverse de getWorkspaceFolders : le menu contextuel part du dossier
 * et doit savoir à quels espaces il appartient déjà, pour cocher les bonnes
 * cases. Sans cela, chaque ouverture afficherait tout décoché, et un clic
 * sur « rattacher » remplacerait la sélection au lieu de l'ajouter.
 */
async function listFolderWorkspaces(folderId) {
  const result = await query(
    `SELECT w.id, w.name
       FROM workspace_folders wf
       JOIN workspaces w ON w.id = wf.workspace_id
      WHERE wf.folder_id = $1::uuid
      ORDER BY lower(w.name) ASC`,
    [folderId],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async function listDocuments(folderId) {
  const result = await query(
    `SELECT d.id, d.folder_id, d.source_path, d.title, d.content_hash, d.created_at,
            d.ingest_status, d.total_chunks, d.done_chunks, d.error_detail,
            d.started_at, d.finished_at,
            (SELECT COUNT(*) FROM chunks ch WHERE ch.file_id = d.id) AS chunk_count
       FROM files d
      WHERE ($1::uuid IS NULL OR d.folder_id = $1::uuid)
      ORDER BY d.created_at DESC`,
    [folderId || null],
  );
  return result.rows;
}

async function getDocument(id) {
  const result = await query('SELECT * FROM files WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function deleteDocument(id) {
  const result = await query('DELETE FROM files WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

// ---------------------------------------------------------------------------
// Ingestion
// ---------------------------------------------------------------------------

/**
 * Enregistre un file découpé en fragments, avec leurs vecteurs.
 *
 * L'opération est atomique : si l'insertion d'un fragment échoue, le file
 * n'est pas créé non plus. Un import partiel laisserait des fragments que la
 * recherche remonterait sans leur file d'origine.
 *
 * @param {object} params
 * @param {string[]} params.chunks
 * @param {string[]} params.vectors littéraux pgvector, même ordre que chunks
 */
/**
 * Construit un INSERT multi-lignes pour un lot de fragments.
 *
 * Un INSERT par fragment sur un fichier de 20 000 fragments représente 20 000
 * allers-retours réseau vers PostgreSQL : plusieurs minutes pour rien. Un INSERT
 * groupé réduit l'indexation à quelques centaines d'aller-retours.
 *
 * Les valeurs restent des paramètres $1..$n, jamais de concaténation.
 */
function insertChunkBatch(client, documentId, chunks, vectors, startIndex) {
  // params[0] est le documentId, commun à toutes les lignes et référencé par $1.
  const params = [documentId];
  const rows = [];

  for (let index = 0; index < chunks.length; index += 1) {
    const ordinal = startIndex + index;
    // params contient déjà documentId (1) puis 4 valeurs par ligne précédente.
    // Le premier index libre est donc params.length + 1 en numérotation
    // PostgreSQL : la ligne 1 utilise $2..$6 et la ligne 2 $7..$11, sans
    // jamais réutiliser un paramètre. Un simple params.length ferait
    // chevaucher les lignes et enverrait un vecteur dans file_id.
    const base = params.length + 1;
    // metadata : position et longueur, pour l'interface et le débogage.
    const metadata = { ordinal, chars: chunks[index].length };
    params.push(ordinal, chunks[index], JSON.stringify(metadata), vectors[index]);
    // On réinjecte le documentId en tête de chaque ligne : chaque VALUES
    // dispose ainsi de son propre $1..$6 et l'indexation reste indépendante.
    rows.push(`($1, $${base}, $${base + 1}, $${base + 2}::jsonb, $${base + 3}::vector)`);
  }

  return client.query(
    `INSERT INTO chunks (file_id, ordinal, content, metadata, embedding)
     VALUES ${rows.join(', ')}`,
    params,
  );
}

// Nombre de fragments insérés par requête. 500 reste sous la limite de
// paramètres de PostgreSQL (65 535) tout en gardant des requêtes raisonnable.
const INSERT_BATCH_SIZE = 500;

async function insertDocument({ folderId, title, sourcePath, contentHash, sizeBytes, chunks, vectors }) {
  if (chunks.length !== vectors.length) {
    throw new Error(`${chunks.length} fragment(s) mais ${vectors.length} vecteur(s) : nombres incohérents`);
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');

    const documentResult = await client.query(
      `INSERT INTO files (folder_id, source_path, title, content_hash, size_bytes, updated_at)
       VALUES ($1, $2, $3, $4, $5, now()) RETURNING *`,
      [folderId, sourcePath || null, title, contentHash || null, sizeBytes || 0],
    );
    const file = documentResult.rows[0];

    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_SIZE) {
      const end = Math.min(offset + INSERT_BATCH_SIZE, chunks.length);
      // eslint-disable-next-line no-await-in-loop
      await insertChunkBatch(
        client, file.id,
        chunks.slice(offset, end), vectors.slice(offset, end),
        offset,
      );
    }

    await client.query('COMMIT');
    return file;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Recherche vectorielle
// ---------------------------------------------------------------------------

/**
 * Recherche les fragments les plus proches d'un vecteur.
 *
 * Opérateur `<=>` de pgvector (distance cosinus), cohérent avec l'index HNSW
 * déclaré en `vector_cosine_ops` : utiliser l'opérateur produit scalaire alors
 * que l'index est cosinus ferait tomber PostgreSQL sur un balayage séquentiel,
 * silencieux et bien plus lent.
 *
 * Le seuil `minSimilarity` est appliqué APRÈS coupage : un index HNSW est
 * approximatif et peut remonter des voisins un peu trop lointains, on filtre
 * donc aussi en mémoire pour ne pas injecter de contexte hors sujet.
 */
async function searchChunks(queryVector, { folderIds = [], limit = 5, minSimilarity = 0.3 } = {}) {
  const safeLimit = Math.max(1, Math.min(Number(limit) || 5, 50));
  const threshold = Number.isFinite(Number(minSimilarity)) ? Number(minSimilarity) : 0.3;
  const hasFilter = Array.isArray(folderIds) && folderIds.length > 0;

  const result = await query(
    `SELECT ch.id,
            ch.file_id,
            ch.ordinal,
            ch.content,
            ch.metadata,
            d.title,
            d.source_path,
            col.name AS folder_name,
            1 - (ch.embedding <=> $1::vector) AS similarity
       FROM chunks ch
       JOIN files d ON d.id = ch.file_id
       JOIN folders col ON col.id = d.folder_id
      WHERE ch.embedding IS NOT NULL
        AND d.ingest_status = 'ready'
        AND ($2::boolean = false OR d.folder_id = ANY($3::uuid[]))
      ORDER BY ch.embedding <=> $1::vector
      LIMIT $4`,
    [queryVector, hasFilter, hasFilter ? folderIds : null, safeLimit * 3],
  );

  return result.rows
    .filter((row) => Number(row.similarity) >= threshold)
    .slice(0, safeLimit)
    .map((row) => ({
      chunkId: row.id,
      documentId: row.file_id,
      ordinal: row.ordinal,
      content: row.content,
      title: row.title,
      sourcePath: row.source_path,
      folderName: row.folder_name,
      similarity: Number(row.similarity),
    }));
}

async function countChunks(folderId) {
  const result = await query(
    `SELECT COUNT(*)::int AS total
       FROM chunks ch
       JOIN files d ON d.id = ch.file_id
      WHERE ($1::uuid IS NULL OR d.folder_id = $1::uuid)`,
    [folderId || null],
  );
  return result.rows[0]?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Ingestion asynchrone
//
// Le file est créé immédiatement en état 'pending', puis ses fragments sont
// ajoutés par lots depuis la file d'ingestion. Cette organisation permet à
// l'interface d'afficher la progression et à un échec de ne laisser aucun
// fragment partiel : markDocumentFailed supprime ce qui a été écrit.
// ---------------------------------------------------------------------------

/** Crée la ligne file avant le début du calcul des vecteurs. */
async function createPendingDocument({ folderId, title, sourcePath, sizeBytes }) {
  const result = await query(
    `INSERT INTO files (folder_id, source_path, title, ingest_status, started_at, size_bytes, updated_at)
     VALUES ($1, $2, $3, 'pending', now(), $4, now()) RETURNING *`,
    [folderId, sourcePath || null, title, sizeBytes || 0],
  );
  return result.rows[0];
}

async function markDocumentRunning(documentId, startedAt = new Date()) {
  const result = await query(
    `UPDATE files SET ingest_status = 'running', started_at = $2
      WHERE id = $1 RETURNING *`,
    [documentId, startedAt],
  );
  return result.rows[0] || null;
}

/** Publie l'avancement : total connu une fois le découpage fait, puis progression. */
async function setDocumentProgress(documentId, { totalChunks, doneChunks }) {
  if (totalChunks !== undefined && doneChunks !== undefined) {
    return query(
      'UPDATE files SET total_chunks = $2, done_chunks = $3 WHERE id = $1',
      [documentId, totalChunks, doneChunks],
    ).then(() => null);
  }
  if (totalChunks !== undefined) {
    return query(
      'UPDATE files SET total_chunks = $2 WHERE id = $1',
      [documentId, totalChunks],
    ).then(() => null);
  }
  return query(
    'UPDATE files SET done_chunks = $2 WHERE id = $1',
    [documentId, doneChunks],
  ).then(() => null);
}

/**
 * Ajoute un lot de fragments à un file déjà créé.
 * `startOrdinal` garantit la continuité de l'ordinal avec les lots précédents.
 */
async function appendChunks({ documentId, startOrdinal, chunks, vectors }) {
  if (chunks.length !== vectors.length) {
    throw new Error(`${chunks.length} fragment(s) mais ${vectors.length} vecteur(s) : nombres incohérents`);
  }
  if (chunks.length === 0) return;

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await insertChunkBatch(client, documentId, chunks, vectors, startOrdinal);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function markDocumentReady({ documentId, contentHash, title, totalChunks }) {
  const result = await query(
    `UPDATE files
        SET ingest_status = 'ready', content_hash = $2, title = $3,
            total_chunks = $4, done_chunks = $4, finished_at = now(), error_detail = NULL
      WHERE id = $1 RETURNING *`,
    [documentId, contentHash || null, title, totalChunks],
  );
  return result.rows[0] || null;
}

/**
 * Marque un file en échec ET supprime les fragments déjà écrits.
 *
 * Sans cette suppression, une indexation interrompue laisserait des fragments
 * partiels que la recherche remonterait comme s'ils provenaient d'un file
 * complet.
 */
async function markDocumentFailed(documentId, detail) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM chunks WHERE file_id = $1', [documentId]);
    const result = await client.query(
      `UPDATE files
          SET ingest_status = 'error', error_detail = $2, finished_at = now(), done_chunks = 0
        WHERE id = $1 RETURNING *`,
      [documentId, String(detail).slice(0, 2000)],
    );
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Recherche les fichiers dont l'indexation n'est pas terminée.
 * Au démarrage du conteneur, ces lignes sont des travaux interrompus : elles
 * sont marquées en échec plutôt que laissées « en cours » indéfiniment.
 */
async function listUnfinishedDocuments() {
  const result = await query(
    `SELECT id, title, source_path, ingest_status, total_chunks, done_chunks, started_at
       FROM files WHERE ingest_status IN ('pending', 'running')
      ORDER BY started_at ASC`,
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Sélection de dossiers par conversation
// ---------------------------------------------------------------------------

/** Folders cochées pour une conversation (liste vide si aucune). */
async function getConversationFolders(conversationId) {
  const result = await query(
    `SELECT cc.folder_id
       FROM conversation_folders cc
       JOIN folders c ON c.id = cc.folder_id
      WHERE cc.conversation_id = $1
      ORDER BY c.name ASC`,
    [conversationId],
  );
  return result.rows.map((row) => row.folder_id);
}

/**
 * Remplace la sélection d'une conversation.
 *
 * On passe par une transaction : effacer puis réinsérer laisserait, en cas
 * d'échec entre les deux, une conversation sans aucun dossier.
 */
async function setConversationFolders(conversationId, folderIds) {
  const ids = Array.isArray(folderIds)
    ? [...new Set(folderIds.filter((id) => typeof id === 'string'))]
    : [];

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM conversation_folders WHERE conversation_id = $1', [conversationId]);
    for (const folderId of ids) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO conversation_folders (conversation_id, folder_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [conversationId, folderId],
      );
    }
    await client.query('COMMIT');
    return ids;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Espaces de travail
//
// Un espace regroupe des conversations et pointe vers des dossiers de
// files. C'est le niveau où l'on rattache les files : une fois le lien
// fait, tous les chats de l'espace en bénéficient, sans répétition.
// ---------------------------------------------------------------------------

async function listWorkspaces() {
  const result = await query(
    `SELECT w.id, w.name, w.description, w.created_at,
            COALESCE(c.conversation_count, 0) AS conversation_count,
            COALESCE(d.document_count, 0) AS document_count,
            COALESCE(k.chunk_count, 0) AS chunk_count
       FROM workspaces w
       LEFT JOIN (
         SELECT workspace_id, COUNT(*) AS conversation_count
           FROM conversations WHERE workspace_id IS NOT NULL GROUP BY workspace_id
       ) c ON c.workspace_id = w.id
       LEFT JOIN (
         SELECT wc.workspace_id, COUNT(DISTINCT d.id) AS document_count
           FROM workspace_folders wc
           JOIN files d ON d.folder_id = wc.folder_id
          GROUP BY wc.workspace_id
       ) d ON d.workspace_id = w.id
       LEFT JOIN (
         SELECT wc.workspace_id, COUNT(*) AS chunk_count
           FROM workspace_folders wc
           JOIN files d ON d.folder_id = wc.folder_id
           JOIN chunks ch ON ch.file_id = d.id
          GROUP BY wc.workspace_id
       ) k ON k.workspace_id = w.id
      ORDER BY w.name ASC`,
  );
  return result.rows;
}

async function createWorkspace({ name, description }) {
  const result = await query(
    'INSERT INTO workspaces (name, description) VALUES ($1, $2) RETURNING *',
    [name, description || null],
  );
  return result.rows[0];
}

async function getWorkspace(id) {
  const result = await query('SELECT * FROM workspaces WHERE id = $1', [id]);
  return result.rows[0] || null;
}

async function deleteWorkspace(id) {
  // Les conversations liées survivent (ON DELETE SET NULL) ; seule la jonction
  // avec les dossiers disparaît (ON DELETE CASCADE).
  const result = await query('DELETE FROM workspaces WHERE id = $1 RETURNING id', [id]);
  return result.rowCount > 0;
}

/**
 * Folders rattachées à un espace.
 *
 * Le nombre de fragments est calculé ici plutôt que lu sur `dossiers` :
 * cette table ne stocke que le nom et la description, `chunk_count` est agrégé
 * dans listFolders. Le viser directement ferait échouer la requête.
 */
async function getWorkspaceFolders(workspaceId) {
  const result = await query(
    `SELECT c.id, c.name, c.description,
            (SELECT COUNT(*) FROM files d
               JOIN chunks ch ON ch.file_id = d.id
              WHERE d.folder_id = c.id) AS chunk_count
       FROM workspace_folders wc
       JOIN folders c ON c.id = wc.folder_id
      WHERE wc.workspace_id = $1
      ORDER BY c.name ASC`,
    [workspaceId],
  );
  return result.rows;
}

/**
 * Dimension ACTUELLE de la colonne chunks.embedding.
 *
 * pgvector fige la dimension dans le type de la colonne (vector(N)) : elle
 * n'est pas déductible du code, seulement de PostgreSQL. C'est pourquoi elle est
 * lue ici plutôt que codée en dur dans service.cjs.
 * @returns {Promise<number|null>} null si la table n'existe pas encore
 */
async function getEmbeddingDimension() {
  const result = await query(
    `SELECT a.atttypmod AS dims
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
      WHERE c.relname = 'chunks'
        AND a.attname = 'embedding'
        AND a.attnum > 0
        AND NOT a.attisdropped`,
  );
  const dims = result.rows[0]?.dims;
  return Number.isInteger(Number(dims)) ? Number(dims) : null;
}

/**
 * Aligne la colonne chunks.embedding sur la dimension réellement produite par le
 * modèle d'embeddings choisi.
 *
 * Changer de modèle (nomic 768 → qwen3-embedding-0.6b 1024, etc.) impose un
 * ALTER TYPE. Deux contraintes pgvector :
 *  1. l'index HNSW est lié à la dimension : il doit être SUPPRIMÉ avant
 *     l'ALTER, puis recréé après ;
 *  2. les lignes existantes contiennent des vecteurs de l'ancienne dimension :
 *     PostgreSQL refuse l'ALTER tant qu'elles sont là (aucun transtypage
 *     vectoriel n'est possible). Elles sont donc purgées — de toute façon
 *     inexploitables, les similarités n'étant plus calculables.
 *
 * L'opération est transactionnelle : en cas d'échec, la base reste utilisable
 * avec l'ancienne dimension et l'ingestion repartira au prochain appel.
 *
 * @returns {Promise<{changed:boolean, previous:number|null, purged:number, reason?:string}>}
 */
async function migrateEmbeddingDimension(targetDim) {
  const dimension = Number(targetDim);
  if (!Number.isInteger(dimension) || dimension <= 0) {
    return { changed: false, previous: null, purged: 0, reason: `dimension invalide: ${targetDim}` };
  }
  // Garde-fou pgvector : un index HNSW ne peut pas dépasser 2000 dimensions.
  if (dimension > 2000) {
    return {
      changed: false,
      previous: null,
      purged: 0,
      reason: `dimension ${dimension} > 2000, au-delà de la limite de l'index HNSW de pgvector`,
    };
  }

  const previous = await getEmbeddingDimension();
  if (previous === dimension) {
    return { changed: false, previous, purged: 0 };
  }

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // La dimension vient de la longueur d'un vecteur réellement produit par le
    // modèle : c'est un entier, jamais une saisie utilisateur.
    const purged = await client.query(
      'DELETE FROM chunks WHERE embedding IS NOT NULL',
    );
    await client.query('DROP INDEX IF EXISTS chunks_embedding_hnsw_idx');
    await client.query(
      `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(${dimension})`,
    );
    await client.query(
      'CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx ON chunks USING hnsw (embedding vector_cosine_ops)',
    );
    await client.query('COMMIT');
    console.log(
      `[rag] dimension d'embeddings alignée : ${previous ?? '?'} -> ${dimension} `
      + `(${purged.rowCount} fragment(s) purgé(s), réindexation requise)`,
    );
    return { changed: true, previous, purged: purged.rowCount };
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('[rag] échec alignement dimension :', error.message);
    return { changed: false, previous, purged: 0, reason: error.message };
  } finally {
    client.release();
  }
}

async function setWorkspaceFolders(workspaceId, folderIds) {
  const ids = Array.isArray(folderIds)
    ? [...new Set(folderIds.filter((id) => typeof id === 'string'))]
    : [];

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM workspace_folders WHERE workspace_id = $1', [workspaceId]);
    for (const folderId of ids) {
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO workspace_folders (workspace_id, folder_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [workspaceId, folderId],
      );
    }
    await client.query('COMMIT');
    return ids;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Rattache une conversation à un espace (null la laisse sans espace). */
async function setConversationWorkspace(conversationId, workspaceId) {
  const result = await query(
    'UPDATE conversations SET workspace_id = $2 WHERE id = $1 RETURNING *',
    [conversationId, workspaceId || null],
  );
  return result.rows[0] || null;
}

/** Conversations d'un espace, les plus récentes d'abord. */
async function listConversationsByWorkspace(workspaceId) {
  const result = await query(
    `SELECT c.id, c.title, c.model, c.created_at, c.updated_at,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
       FROM conversations c
      WHERE c.workspace_id = $1::uuid
      ORDER BY COALESCE(c.updated_at, c.created_at) DESC`,
    [workspaceId],
  );
  return result.rows;
}

module.exports = {
  listFolders,
  listFolderContents,
  listFolderAncestors,
  wouldCreateCycle,
  isDuplicateName,
  createFolder,
  getFolder,
  renameFolder,
  moveFolder,
  deleteFolder,
  listFolderWorkspaces,
  listDocuments,
  getDocument,
  deleteDocument,
  insertDocument,
  appendChunks,
  createPendingDocument,
  markDocumentRunning,
  setDocumentProgress,
  markDocumentReady,
  markDocumentFailed,
  listUnfinishedDocuments,
  getConversationFolders,
  setConversationFolders,
  listWorkspaces,
  createWorkspace,
  getWorkspace,
  deleteWorkspace,
  getWorkspaceFolders,
  setWorkspaceFolders,
  setConversationWorkspace,
  listConversationsByWorkspace,
  searchChunks,
  countChunks,
  getEmbeddingDimension,
  migrateEmbeddingDimension,
};
