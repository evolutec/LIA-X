import { useEffect, useRef, useState } from 'react';

// Modèles d'embeddings : ils tournent sur leur propre llama-server mais ne
// savent pas générer de texte. Les proposer dans le sélecteur de chat mènerait
// à une erreur « the current context does not logits computation ».
const EMBEDDING_CANDIDATES = [
  'nomic-embed-text',
  'nomic-embed',
  'bge-',
  'gte-',
  'e5-',
  'mxbai-embed',
  'all-minilm',
];

// Alias du proxy : ce n'est pas une instance de modèle mais un pointeur vers
// le modèle principal. Doit correspondre à PROXY_MODEL_ID dans server.js.
const PROXY_MODEL_ALIAS = 'lia-local';

/** Vrai si le modèle ne sert qu'aux embeddings. */
export function isEmbeddingModel(name) {
  const lower = String(name || '').toLowerCase();
  return EMBEDDING_CANDIDATES.some((candidate) => lower.includes(candidate));
}

/**
 * Sélecteur de modèle pour la conversation courante.
 *
 * Chaque conversation garde son propre modèle : le choix est mémorisé dans
 * l'objet conversation côté base (colonne `model`) et renvoyé avec l'historique.
 */
function ChatModelSelector({ models, value, activeModel, onChange, disabled }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Referme le menu si on clique ailleurs ou si on/appuie sur Échap.
  useEffect(() => {
    if (!open) return undefined;
    function onDocumentClick(event) {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false);
    }
    function onKeyDown(event) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocumentClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const chatModels = models.filter((model) => {
    const name = model.model || model.id;
    // `lia-local` est l'alias du proxy, pas une instance : le lister ferait
    // croire à un second modèle alors que c'est la même requête routée.
    if (name === PROXY_MODEL_ALIAS) return false;
    return model.running !== false && !isEmbeddingModel(name);
  });
  const selected = chatModels.find((model) => (model.model || model.id) === value);
  const label = selected
    ? (selected.model || selected.id)
    : (value || activeModel || 'Modèle par défaut');

  const noModels = chatModels.length === 0;

  return (
    <div className="chat-model-select" ref={ref}>
      <button
        type="button"
        className="chat-model-button"
        onClick={() => setOpen((state) => !state)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Modèle utilisé pour cette conversation"
      >
        <span className="chat-model-button-label">{label}</span>
        <span className="chat-model-caret" aria-hidden="true">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <ul className="chat-model-menu" role="listbox">
          {noModels && (
            <li className="chat-model-empty">Aucun modèle de chat chargé</li>
          )}
          {chatModels.map((model) => {
            const id = model.model || model.id;
            return (
              <li key={id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={id === value}
                  className={`chat-model-option${id === value ? ' is-selected' : ''}`}
                  onClick={() => {
                    onChange(id);
                    setOpen(false);
                  }}
                >
                  <span className="chat-model-option-name">{id}</span>
                  <span className="chat-model-option-meta">
                    {model.active ? 'principal' : `port ${model.port}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default ChatModelSelector;
