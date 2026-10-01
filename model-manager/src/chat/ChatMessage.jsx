import { useMemo, useState } from 'react';
import { renderMarkdown } from './markdown';
import { useSettings } from '../Settings/settingsStore';
import useSpeechOutput from './useSpeechOutput';

/** Icone haut-parleur, dans le meme esprit que l icone micro du composeur. */
function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
      <path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4Z" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        d="M16.5 9.5a3.5 3.5 0 0 1 0 5M19 7a7 7 0 0 1 0 10"
      />
    </svg>
  );
}

/**
 * Un message de la conversation.
 *
 * Le contenu de l assistant est rendu en Markdown via dangerouslySetInnerHTML,
 * mais uniquement apres passage par DOMPurify (voir markdown.js). safe=false
 * signifie que le HTML a ete neutralise : on affiche alors le texte brut via
 * {children}, React echappant tout automatiquement.
 */
function ChatMessage({ message, onRetry, onDelete }) {
  const { role, content, reasoning, streaming, error, model } = message;
  const [copied, setCopied] = useState(false);
  const [showReasoning, setShowReasoning] = useState(false);
  const isUser = role === 'user';
  const { settings } = useSettings();

  // Le moteur vocal du navigateur est global : speak() interrompt la lecture
  // precedente avant d en lancer une nouvelle. Chaque message garde son propre
  // etat d affichage, et l annulation au demontage evite qu un message continue
  // de parler apres avoir quitte la conversation.
  const speech = useSpeechOutput({
    lang: settings.voiceOutputLang,
    rate: settings.voiceOutputRate,
    pitch: settings.voiceOutputPitch,
  });

  const rendered = useMemo(() => {
    if (isUser) return { html: null, safe: false };
    return renderMarkdown(content);
  }, [content, isUser]);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Presse-papiers refuse : on reste silencieux, l utilisateur peut
      // toujours selectionner le texte manuellement.
    }
  }

  function toggleSpeak() {
    if (speech.speaking) {
      speech.cancel();
    } else {
      speech.speak(content);
    }
  }

  // Le bouton n apparait que si la sortie vocale est activee dans les
  // parametres, que le navigateur sait synthetiser, et qu il y a quelque chose
  // a lire. Pendant la generation, on l om : le texte est encore incomplet.
  const canSpeak = !isUser
    && settings.voiceOutput
    && speech.supported
    && Boolean(content)
    && !streaming
    && !error;

  return (
    <article className={'chat-message chat-message-' + role + (error ? ' is-error' : '')}>
      <header className="chat-message-header">
        <span className="chat-message-author">{isUser ? 'Vous' : (model || 'Assistant')}</span>
        {streaming && <span className="chat-message-streaming">generation...</span>}
        <span className="chat-message-actions">
          {!isUser && reasoning && (
            <button
              type="button"
              onClick={() => setShowReasoning((value) => !value)}
              title="Afficher le raisonnement du modele"
            >
              {showReasoning ? 'Masquer le raisonnement' : 'Raisonnement'}
            </button>
          )}
          {canSpeak && (
            <button
              type="button"
              className="chat-message-speak"
              onClick={toggleSpeak}
              title={speech.speaking ? 'Arreter la lecture' : 'Ecouter la reponse'}
              aria-label={speech.speaking ? 'Arreter la lecture' : 'Ecouter la reponse'}
            >
              {speech.speaking ? '■ Arreter' : (<SpeakerIcon />)}
              {speech.speaking ? '' : ' Ecouter'}
            </button>
          )}
          {!isUser && content && (
            <button type="button" onClick={handleCopy} title="Copier la reponse">
              {copied ? '✓ Copié' : 'Copier'}
            </button>
          )}
          {onRetry && !isUser && !streaming && !error && (
            <button type="button" onClick={onRetry} title="Regenerer la reponse">
              Regenerer
            </button>
          )}
          {onDelete && (
            <button type="button" onClick={onDelete} title="Supprimer ce message" aria-label="Supprimer le message">
              ✕
            </button>
          )}
        </span>
        {/* La synthese vocale echoue silencieusement quand le systeme n a aucune
            voix installee : on l affiche, sinon l utilisateur clique et rien ne
            se passe, sans explication. */}
        {canSpeak && speech.error && (
          <p className="chat-message-speak-error" role="status">{speech.error}</p>
        )}
      </header>

      <div className="chat-message-body">
        {!isUser && reasoning && showReasoning && (
          <div className="chat-reasoning">
            <p className="chat-reasoning-title">Raisonnement du modele</p>
            <p className="chat-reasoning-text">{reasoning}</p>
          </div>
        )}

        {error ? (
          <p className="chat-message-error" role="alert">{error}</p>
        ) : isUser ? (
          <p className="chat-text">{content}</p>
        ) : !content ? (
          streaming ? (
            <p className="chat-message-pending">Reponse en cours...</p>
          ) : (
            <p className="chat-message-pending">(generation interrompue)</p>
          )
        ) : rendered.safe ? (
          <div
            className="chat-markdown"
            dangerouslySetInnerHTML={{ __html: rendered.html }}
          />
        ) : (
          <p className="chat-text">{content}</p>
        )}
        {streaming && content && <span className="chat-caret" aria-hidden="true" />}
      </div>
    </article>
  );
}

export default ChatMessage;
