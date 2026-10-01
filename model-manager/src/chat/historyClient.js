// Client de l'historique des conversations (API PostgreSQL).
//
// Toutes les fonctions renvoient `{ ok, data }` ou `{ ok: false, error }` :
// l'UI doit pouvoir distinguer un échec réseau d'un 503 « base indisponible »
// et continuer à fonctionner en mémoire.

const apiBase = import.meta.env.VITE_API_BASE_URL ?? '';

async function callApi(path, options = {}) {
  try {
    const response = await fetch(`${apiBase}${path}`, {
      method: options.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      ...options,
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: payload?.detail || response.statusText || 'Erreur inconnue',
      };
    }
    return { ok: true, data: payload };
  } catch (error) {
    return { ok: false, status: 0, error: error.message };
  }
}

/** État de la persistance, pour afficher ou non le bandeau d'avertissement. */
export async function fetchDbHealth() {
  const result = await callApi('/api/db/health');
  return { available: Boolean(result.ok && result.data?.available), error: result.ok ? null : result.error };
}

export async function listConversations() {
  const result = await callApi('/api/conversations');
  return { ok: result.ok, conversations: result.ok ? (result.data?.conversations ?? []) : [], error: result.error };
}

export async function createConversation({ title, model }) {
  const result = await callApi('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ title, model }),
  });
  return { ok: result.ok, conversation: result.data?.conversation ?? null, error: result.error };
}

export async function fetchConversation(id) {
  const result = await callApi(`/api/conversations/${encodeURIComponent(id)}`);
  return { ok: result.ok, conversation: result.data?.conversation ?? null, error: result.error };
}

export async function renameConversation(id, title, model) {
  const body = {};
  if (title !== undefined) body.title = title;
  if (model !== undefined) body.model = model;
  const result = await callApi(`/api/conversations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return { ok: result.ok, conversation: result.data?.conversation ?? null, error: result.error };
}

export async function deleteConversation(id) {
  const result = await callApi(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { ok: result.ok, error: result.error };
}

export async function saveMessage(conversationId, message) {
  const result = await callApi(`/api/conversations/${encodeURIComponent(conversationId)}/messages`, {
    method: 'POST',
    body: JSON.stringify(message),
  });
  return { ok: result.ok, message: result.data?.message ?? null, error: result.error };
}

export async function deleteMessage(id) {
  const result = await callApi(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { ok: result.ok, error: result.error };
}
