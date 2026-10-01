import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Dictée via la Web Speech API (SpeechRecognition).
 *
 * Contraintes réelles du navigateur, à connaître :
 * - Chrome et Edge l'implémentent (préfixées `webkitSpeechRecognition`),
 *   Firefox ne l'expose pas du tout. `supported` permet à l'appelant de
 *   masquer le micro plutôt que d'afficher un bouton inerte.
 * - Chrome n'envoie pas l'audio localement : la reconnaissance passe par les
 *   serveurs Google. Sur Firefox, la capture est locale. Le réglage est donc
 *   présenté comme dépendant du navigateur, et l'utilisateur garde la main.
 * - La reconnaissance est VOLATILE : on ne conserve aucune instance entre deux
 *   activations, et on coupe explicitement au démontage, sinon le micro reste
 *   ouvert en arrière-plan.
 */

/** Messages d'erreur de l'API, traduits et sans jargon technique. */
const ERROR_MESSAGES = {
  'not-allowed': 'Accès au micro refusé. Autorisez le micro pour ce site dans la barre du navigateur.',
  'service-not-allowed': 'Service de reconnaissance refusé par le navigateur.',
  'no-speech': 'Aucune parole détectée.',
  'audio-capture': 'Aucun micro accessible.',
  network: 'La reconnaissance vocale a échoué : réseau inaccessible.',
  aborted: '',
};

function getRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * @param {(text: string, isFinal: boolean) => void} onTranscript
 *        Rappelé à chaque fragment reconnu.
 * @returns {{supported: boolean, listening: boolean, error: string, start: Function, stop: Function}}
 */
export default function useSpeechInput(onTranscript) {
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');
  const recognitionRef = useRef(null);
  // La référence est mise à jour à chaque rendu : le gestionnaire d'événements
  // créé au démarrage ne doit pas capturer une ancienne version de la closure.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const supported = getRecognitionCtor() !== null;

  const stop = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (!recognition) return;
    try {
      recognition.stop();
    } catch {
      // stop() lève si la reconnaissance est déjà arrêtée : sans conséquence.
    }
    setListening(false);
  }, []);

  const start = useCallback(() => {
    const Recognition = getRecognitionCtor();
    if (!Recognition || recognitionRef.current) return;

    const recognition = new Recognition();
    recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'fr-FR';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      // Les résultats sont cumulatifs : on ne garde que ceux de la session en
      // cours, sinon chaque événement renverrait toute la phrase depuis le début.
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript || '';
        if (result.isFinal) {
          onTranscriptRef.current(transcript, true);
        } else {
          interim += transcript;
        }
      }
      if (interim) onTranscriptRef.current(interim, false);
    };

    recognition.onerror = (event) => {
      setError(ERROR_MESSAGES[event.error] ?? `Erreur de reconnaissance (${event.error}).`);
      setListening(false);
      recognitionRef.current = null;
    };

    recognition.onend = () => {
      setListening(false);
      recognitionRef.current = null;
    };

    recognitionRef.current = recognition;
    setError('');
    try {
      recognition.start();
      setListening(true);
    } catch (event) {
      // start() lève si une reconnaissance est déjà active.
      recognitionRef.current = null;
      setError('La dictée est déjà active.');
    }
  }, []);

  useEffect(() => stop, [stop]);

  return { supported, listening, error, start, stop };
}
