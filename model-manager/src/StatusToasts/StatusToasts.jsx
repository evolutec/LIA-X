import { useCallback, useEffect, useRef, useState } from 'react';
import './StatusToasts.css';

/** Durée d'affichage d'un message non critique. */
const TOAST_DURATION_MS = 4000;

/**
 * Messages système discrets.
 *
 * Ces messages Confirment des actions (« Synchronisation terminée »,
 * « Modèle chargé ») qui poluaient l'écran avec une bannière occupant toute la
 * largeur. Un toast compact, en bas à droite, se fade et disparaît.
 *
 * Les ERREURS restent affichées plus longtemps : un échec qui s'efface en quatre
 * secondes serait facile à manquer, alors qu'il demande une action.
 */
export default function StatusToasts({ message, onDismiss }) {
  if (!message) return null;

  const isError = /échec|erreur|impossible|indisponible|introuvable/i.test(message.text || '');

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      <ToastItem
        key={message.id}
        text={message.text}
        isError={isError}
        onDismiss={onDismiss}
      />
    </div>
  );
}

function ToastItem({ text, isError, onDismiss }) {
  const [leaving, setLeaving] = useState(false);
  const timerRef = useRef(null);
  // Survol ou focus : on suspend la disparition le temps que l'utilisateur lit.
  const holdRef = useRef(false);

  const schedule = useCallback(() => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setLeaving(true), isError ? 9000 : TOAST_DURATION_MS);
  }, [isError]);

  useEffect(() => {
    schedule();
    return () => { if (timerRef.current) window.clearTimeout(timerRef.current); };
  }, [schedule]);

  function dismiss() {
    setLeaving(true);
  }

  function hold() {
    holdRef.current = true;
    if (timerRef.current) window.clearTimeout(timerRef.current);
  }

  function release() {
    holdRef.current = false;
    schedule();
  }

  return (
    <div
      className={`toast${isError ? ' toast-error' : ''}${leaving ? ' is-leaving' : ''}`}
      onMouseEnter={hold}
      onMouseLeave={release}
      onFocus={hold}
      onBlur={release}
      title={text}
    >
      <span className="toast-dot" aria-hidden="true" />
      <span className="toast-text">{text}</span>
      <button type="button" className="toast-close" onClick={dismiss} aria-label="Masquer le message">
        ✕
      </button>
    </div>
  );
}

/**
 * Hook de gestion des messages système.
 *
 * Remplace l'affichage par bannière : un seul message visible à la fois, le
 * nouveau remplaçant le précédent. Empiler plusieurs confirmations simultanées
 * (une synchronisation + un chargement) produirait exactement l'encombrement
 * que l'on cherche à éviter.
 */
export function useStatusToast() {
  const [message, setMessage] = useState(null);
  const counterRef = useRef(0);

  const push = useCallback((text) => {
    if (!text) return;
    counterRef.current += 1;
    setMessage({ id: counterRef.current, text: String(text) });
  }, []);

  const dismiss = useCallback(() => setMessage(null), []);

  return { message, push, dismiss };
}
