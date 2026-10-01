import { useCallback, useEffect, useRef, useState } from 'react';
import { useSettings } from '../Settings/settingsStore';
import useSpeechInput from './useSpeechInput';

/** Icône micro, pour rester cohérent avec le bouton d'envoi arrondi. */
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Z"
      />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        d="M5 11a7 7 0 0 0 14 0M12 18v3"
      />
    </svg>
  );
}

/**
 * Zone de saisie.
 *
 * Raccourcis : Entrée envoie, Maj+Entrée insère un saut de ligne (comme
 * LibreChat / Open WebUI). Le textarea s'auto-dimensionne pour éviter un
 * défilement interne à quelques lignes.
 *
 * Dictée : le micro n'apparaît que si le navigateur expose la Web Speech API
 * ET que la saisie vocale est activée dans les paramètres. Pendant la
 * reconnaissance, les mots reconnus sont affichés à part : ils ne sont versés
 * dans le texte qu'une fois définitifs, ce qui évite qu'une phrase provisoire
 * soit envoyée puis corrigée.
 */
function ChatComposer({ onSend, onStop, disabled, streaming, placeholder }) {
  const [value, setValue] = useState('');
  const [interim, setInterim] = useState('');
  const textareaRef = useRef(null);
  const { settings } = useSettings();

  /**
   * Append le texte reconnu à la saisie en cours, en respectant la ponctuation
   * pour ne pas coller deux mots.
   */
  const appendTranscript = useCallback((text, isFinal) => {
    const clean = String(text || '').trim();
    if (!isFinal) {
      setInterim(clean);
      return;
    }
    setInterim('');
    if (!clean) return;
    setValue((current) => {
      if (!current) return clean;
      const needsSpace = !/\s$/.test(current) && !/^[,.;:!?…]/.test(clean);
      return `${current}${needsSpace ? ' ' : ''}${clean}`;
    });
  }, []);

  const speech = useSpeechInput(appendTranscript);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
  }, [value]);

  useEffect(() => {
    if (!disabled && !streaming) {
      textareaRef.current?.focus();
    }
  }, [disabled, streaming]);

  function handleKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  }

  function submit() {
    const text = value.trim();
    if (!text || disabled || streaming) return;
    onSend(text);
    setValue('');
    setInterim('');
  }

  // On ne peut pas dicter pendant une génération ni sur une saisie désactivée :
  // le texte reconnu arriverait dans un composer déjà verrouillé.
  const canDictate = settings.voiceInput && speech.supported && !disabled && !streaming;
  const showMic = settings.voiceInput && speech.supported;
  const canSend = value.trim().length > 0 && !disabled && !streaming;

  function toggleDictation() {
    if (speech.listening) {
      speech.stop();
    } else {
      speech.start();
    }
  }

  return (
    <div className="chat-composer">
      <div className="chat-composer-row">
        <button
          type="button"
          className={`chat-mic${speech.listening ? ' is-listening' : ''}`}
          onClick={toggleDictation}
          disabled={!canDictate}
          aria-pressed={speech.listening}
          title={speech.listening ? 'Arrêter la dictée' : 'Dicter votre message'}
          aria-label={speech.listening ? 'Arrêter la dictée' : 'Dicter votre message'}
        >
          <MicIcon />
        </button>

        <textarea
          ref={textareaRef}
          className="chat-composer-input"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder || 'Écrivez votre message… (Entrée pour envoyer, Maj+Entrée pour un saut de ligne)'}
          rows={1}
          disabled={disabled}
          aria-label="Votre message"
        />

        {streaming ? (
          <button type="button" className="chat-composer-send is-stop" onClick={onStop}>
            Arrêter
          </button>
        ) : (
          <button type="button" className="chat-composer-send" onClick={submit} disabled={!canSend}>
            Envoyer
          </button>
        )}
      </div>

      {/* Aperçu transitoire : ce que le navigateur a reconnu mais pas encore
          validé. Affiché sous la saisie pour ne jamais déclencher l'envoi. */}
      {showMic && speech.listening && interim && (
        <p className="chat-composer-interim" aria-live="polite">{interim}</p>
      )}

      {showMic && speech.error && (
        <p className="chat-composer-error" role="alert">{speech.error}</p>
      )}
    </div>
  );
}

export default ChatComposer;

