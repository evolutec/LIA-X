// Client RAG : dossiers, ingestion et recherche vectorielle.
// Même convention que historyClient : { ok, ... } ou { ok: false, error }.

const apiBase = import.meta.env.VITE_API_BASE_URL ?? '';

// L'ingestion d'un file de plusieurs dizaines de mégaoctets peut durer
// plus de dix minutes (indexation de ~24 000 fragments). fetch() n'a pas de
// délai par défaut, mais on en pose un explicite bien supérieur, et surtout on
// garde la main sur le signal d'annulation pour ne pas laisser un transfert
// orphelin si l'utilisateur ferme le panneau.
async function callApi(path, options = {}) {
  const { timeoutMs = 0, signal, ...fetchOptions } = options;
  const controller = timeoutMs ? new AbortController() : null;
  const timer = timeoutMs
    ? setTimeout(() => controller.abort(new Error('Délai dépassé')), timeoutMs)
    : null;

  try {
    const response = await fetch(`${apiBase}${path}`, {
      method: fetchOptions.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      signal: signal || controller?.signal,
      ...fetchOptions,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return { ok: false, status: response.status, error: payload?.detail || response.statusText };
    }
    // status est renvoyé même en cas de succès : l'ingestion s'appuie sur le
    // 202 pour distinguer « fichier déposé » de « indexation terminée ».
    return { ok: true, status: response.status, data: payload };
  } catch (error) {
    // Une annulation par l'utilisateur n'est pas une erreur à signaler comme
    // telle : le message brut « AbortError » serait trompeur.
    if (error.name === 'AbortError' && !signal?.aborted) {
      return { ok: false, status: 0, error: 'Délai dépassé : le file est trop volumineux ou l’indexation est trop longue.' };
    }
    return { ok: false, status: 0, error: error.message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function fetchRagStatus() {
  const result = await callApi('/api/rag/status');
  return { ok: result.ok, ...(result.data || {}), error: result.error };
}
export async function createFolder(name, description, parentId) {
  const result = await callApi('/api/rag/folders', {
    method: 'POST',
    body: JSON.stringify({ name, description, parentId: parentId || null }),
  });
  return { ok: result.ok, folder: result.data?.folder ?? null, error: result.error };
}

/**
 * Contenu d'un dossier : sous-dossiers, fichiers et fil d'Ariane.
 *
 * Sans `folderId`, la requête porte sur la racine (dossiers de premier niveau).
 * C'est l'état d'ouverture de l'explorateur.
 */
export async function fetchFolderContents(folderId) {
  const qs = folderId ? `?folder=${encodeURIComponent(folderId)}` : '';
  const result = await callApi(`/api/rag/folders/contents${qs}`);
  return {
    ok: result.ok,
    folders: result.data?.folders ?? [],
    files: result.data?.files ?? [],
    ancestors: result.data?.ancestors ?? [],
    error: result.error,
  };
}

/** Renomme et/ou déplace un dossier. */
export async function updateFolder(id, { name, parentId }) {
  const payload = {};
  // undefined = ne pas toucher au champ ; null = remet à la racine.
  if (name !== undefined) payload.name = name;
  if (parentId !== undefined) payload.parentId = parentId;
  const result = await callApi(`/api/rag/folders/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  return { ok: result.ok, folder: result.data?.folder ?? null, error: result.error };
}

/** Espaces de travail auxquels un dossier est rattaché (menu contextuel). */
export async function fetchFolderWorkspaces(folderId) {
  const result = await callApi(`/api/rag/folders/${encodeURIComponent(folderId)}/workspaces`);
  return { ok: result.ok, workspaces: result.data?.workspaces ?? [], error: result.error };
}

export async function deleteFolder(id) {
  const result = await callApi(`/api/rag/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { ok: result.ok, error: result.error };
}

export async function listDocuments(folderId) {
  const qs = folderId ? `?folder=${encodeURIComponent(folderId)}` : '';
  const result = await callApi(`/api/rag/files${qs}`);
  return { ok: result.ok, files: result.data?.files ?? [], error: result.error };
}

export async function deleteDocument(id) {
  const result = await callApi(`/api/rag/files/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { ok: result.ok, error: result.error };
}

/**
 * Lit un fichier en base64.
 *
 * On n'utilise pas `arrayBuffer().toString('base64')` directement : pour un
 * fichier de plusieurs dizaines de mégaoctets, cela crée deux copies en mémoire
 * (ArrayBuffer puis base64), ce qui peut faire tomber l'onglet. On lit donc par
 * morceaux de 512 Ko et on concatène.
 */
async function readFileAsBase64(file) {
  const CHUNK = 512 * 1024;
  // Au-delà de ~2 Go, string.fromCharCode.apply dépasse la taille maximale
  // d'arguments ; on retombe alors sur une construction par morceaux.
  const parts = [];

  if (file.size <= CHUNK) {
    const buffer = await file.arrayBuffer();
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    return btoa(binary);
  }

  let offset = 0;
  while (offset < file.size) {
    const slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
    // eslint-disable-next-line no-await-in-loop
    const buffer = await slice.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    parts.push(btoa(binary));
    offset += CHUNK;
  }
  return parts.join('');
}

/**
 * Ingestion d'un fichier.
 *
 * L'envoi ne fait que déposer le fichier dans la file du serveur : la réponse
 * est immédiate (202) et l'indexation continue en tâche de fond. Le délai est
 * donc court, mais il faut quand même absorber le temps d'encodage base64 d'un
 * fichier de plusieurs dizaines de mégaoctets.
 *
 * Le `accept` du champ fichier est alimenté par la liste des formats réellement
 * supportés, exposée par /api/rag/status.
 */
export async function ingestDocument({ folderId, content, fileName, title, file, signal }) {
  let payload;
  if (file) {
    payload = {
      folderId,
      fileName: fileName || file.name,
      contentBase64: await readFileAsBase64(file),
    };
  } else {
    payload = { folderId, content, fileName, title };
  }

  const result = await callApi('/api/rag/files', {
    method: 'POST',
    body: JSON.stringify(payload),
    timeoutMs: 10 * 60 * 1000,
    signal,
  });
  return {
    ok: result.ok,
    // 202 : le file est enregistré, l'indexation démarre. Le suivi se fait
    // par polling de listDocuments, pas par cette réponse.
    file: result.data?.file ?? null,
    queued: result.status === 202,
    error: result.error,
  };
}

/** Annule l'indexation en cours. */
export async function cancelIngest() {
  const result = await callApi('/api/rag/cancel', { method: 'POST' });
  return { ok: result.ok, cancelled: Boolean(result.data?.cancelled), error: result.error };
}

/**
 * Folders sélectionnées pour une conversation.
 *
 * La sélection est propre à chaque conversation : documenter un projet A ne doit
 * pas faire apparaître ses files dans les réponses du projet B.
 */
export async function fetchConversationFolders(conversationId) {
  const result = await callApi(`/api/conversations/${encodeURIComponent(conversationId)}/folders`);
  return { ok: result.ok, folderIds: result.data?.folderIds ?? [], error: result.error };
}

/** Remplace la sélection de dossiers d'une conversation. */
export async function saveConversationFolders(conversationId, folderIds) {
  const result = await callApi(`/api/conversations/${encodeURIComponent(conversationId)}/folders`, {
    method: 'PUT',
    body: JSON.stringify({ folderIds }),
  });
  return { ok: result.ok, folderIds: result.data?.folderIds ?? [], error: result.error };
}

// ---------------------------------------------------------------------------
// Espaces de travail
// ---------------------------------------------------------------------------

export async function fetchWorkspaces() {
  const result = await callApi('/api/workspaces');
  return { ok: result.ok, workspaces: result.data?.workspaces ?? [], error: result.error };
}

export async function createWorkspace(name, description) {
  const result = await callApi('/api/workspaces', {
    method: 'POST',
    body: JSON.stringify({ name, description }),
  });
  return { ok: result.ok, workspace: result.data?.workspace ?? null, error: result.error };
}

export async function deleteWorkspace(id) {
  const result = await callApi(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { ok: result.ok, error: result.error };
}

/** Détail d'un espace : ses dossiers et ses conversations. */
export async function fetchWorkspace(id) {
  const result = await callApi(`/api/workspaces/${encodeURIComponent(id)}`);
  return {
    ok: result.ok,
    workspace: result.data?.workspace ?? null,
    folders: result.data?.folders ?? [],
    conversations: result.data?.conversations ?? [],
    error: result.error,
  };
}

/** Rattache des dossiers à l'espace (les chats de l'espace en profitent). */
export async function saveWorkspaceFolders(workspaceId, folderIds) {
  const result = await callApi(`/api/workspaces/${encodeURIComponent(workspaceId)}/folders`, {
    method: 'PUT',
    body: JSON.stringify({ folderIds }),
  });
  return { ok: result.ok, folderIds: result.data?.folderIds ?? [], error: result.error };
}

/** Rattache une conversation à un espace (ou null pour la détacher). */
export async function setConversationWorkspace(conversationId, workspaceId) {
  const result = await callApi(`/api/conversations/${encodeURIComponent(conversationId)}/workspace`, {
    method: 'PUT',
    body: JSON.stringify({ workspaceId: workspaceId || null }),
  });
  return { ok: result.ok, error: result.error };
}

export async function searchPassages(query, { folderIds = [], limit = 4, minSimilarity = 0.3 } = {}) {
  const result = await callApi('/api/rag/search', {
    method: 'POST',
    body: JSON.stringify({ query, folderIds, limit, minSimilarity }),
  });
  return {
    ok: result.ok,
    passages: result.data?.passages ?? [],
    context: result.data?.context ?? '',
    error: result.error,
  };
}
