// Client de conversation : appels OpenAI-compatible à /v1/chat/completions.
//
// Le proxy model-manager (server.js) expose déjà /v1/chat/completions avec
// support SSE, autochargement du modèle et routage multi-instances. Ce module
// ne fait QUE du streaming et de la gestion d'erreur : aucune logique serveur.

const apiBase = import.meta.env.VITE_API_BASE_URL ?? '';

/** Modèle virtuel : server.js le remplace par le modèle réellement actif. */
export const PROXY_MODEL_ID = 'lia-local';

/**
 * Consomme une réponse SSE OpenAI et appelle onDelta à chaque fragment de texte.
 *
 * @param {string} endpoint  chemin (ex. '/v1/chat/completions')
 * @param {object} payload   corps de la requête OpenAI
 * @param {object} handlers  { onDelta, onDone, onError }
 * @param {AbortSignal} [signal]
 */
export async function streamChat(endpoint, payload, handlers = {}, signal) {
  const { onDelta, onReasoning, onDone, onError } = handlers;
  const url = `${apiBase}${endpoint}`;

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ ...payload, stream: true }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') {
      onDone?.({ aborted: true });
      return { aborted: true };
    }
    onError?.(new Error(`Connexion impossible au runtime : ${error.message}`));
    return { error };
  }

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || parsed?.detail || parsed?.message || detail;
      } catch {
        if (text) detail = text.slice(0, 400);
      }
    } catch { /* corps illisible : on garde le statut */ }
    const error = new Error(detail);
    onError?.(error);
    return { error };
  }

  // --- Décodage du flux SSE ---
  if (!response.body) {
    onError?.(new Error('Réponse sans corps (streaming non supporté)'));
    return { error: new Error('no-body') };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoningText = '';
  let finishReason = null;
  let usage = null;

  const handleEvent = (rawEvent) => {
    // Chaque événement SSE : un ou plusieurs "data: ..." séparés par ligne vide.
    const dataLines = rawEvent
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart());
    if (dataLines.length === 0) return;

    const payloadText = dataLines.join('\n');
    // llama.cpp termine le flux par "data: [DONE]".
    if (payloadText === '[DONE]') return;

    let parsed;
    try {
      parsed = JSON.parse(payloadText);
    } catch {
      return; // fragment tronqué ou ligne de keep-alive : on ignore
    }

    if (parsed.error) {
      onError?.(new Error(parsed.error.message || JSON.stringify(parsed.error)));
      return;
    }

    const choice = parsed.choices?.[0];
    // delta.content (réponse) ou text (completions legacy).
    const delta = choice?.delta?.content ?? choice?.text ?? choice?.message?.content;
    if (typeof delta === 'string' && delta.length > 0) {
      content += delta;
      onDelta?.(delta, content);
    }
    // Les modèles à raisonnement (Qwen3, DeepSeek-R1, …) émettent un flux
    // `reasoning_content` séparé AVANT `content`. On l'accumule à part : le
    // caller peut l'afficher dans un panneau « raisonnement » sans le
    // mélanger à la réponse finale.
    const reasoning = choice?.delta?.reasoning_content ?? choice?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      reasoningText += reasoning;
      onReasoning?.(reasoning, reasoningText);
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    if (parsed.usage) usage = parsed.usage;
  };

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // On ne traite que les événements complets (séparés par une ligne vide).
      let separatorIndex = buffer.search(/\r?\n\r?\n/);
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        const match = buffer.slice(separatorIndex).match(/^\r?\n\r?\n/);
        buffer = buffer.slice(separatorIndex + match[0].length);
        handleEvent(rawEvent);
        separatorIndex = buffer.search(/\r?\n\r?\n/);
      }
    }
    // Flush : un dernier événement sans séparateur final est fréquent.
    buffer += decoder.decode();
    if (buffer.trim()) handleEvent(buffer);
  } catch (error) {
    if (error?.name === 'AbortError') {
      onDone?.({ aborted: true, content });
      return { aborted: true, content };
    }
    onError?.(new Error(`Flux interrompu : ${error.message}`));
    return { error, content };
  } finally {
    try { reader.releaseLock(); } catch { /* déjà relâché */ }
  }

  onDone?.({ aborted: false, content, reasoning: reasoningText, finishReason, usage });
  return { content, reasoning: reasoningText, finishReason, usage };
}

/**
 * Instances de modèles chargées.
 *
 * On interroge /api/models et non /v1/models : la première est plus riche
 * (port, pid, VRAM, modèle principal) et décrit réellement les instances
 * llama-server en cours, ce qu'il faut pour proposer un choix à l'utilisateur.
 */
export async function listModels() {
  const response = await fetch(`${apiBase}/api/models`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Modèles indisponibles (${response.status})`);
  const data = await response.json();
  return Array.isArray(data?.models) ? data.models : [];
}

/** État du runtime : modèle actif, chargement en cours, VRAM. */
export async function getRuntimeState() {
  const response = await fetch(`${apiBase}/health`, { cache: 'no-store' });
  if (!response.ok) throw new Error(`Runtime indisponible (${response.status})`);
  return response.json();
}

export default streamChat;
