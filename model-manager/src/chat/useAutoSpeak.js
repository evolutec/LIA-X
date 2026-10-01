import { useEffect, useRef } from 'react';
import { useSettings } from '../Settings/settingsStore';
import useSpeechOutput from './useSpeechOutput';

/**
 * Lecture automatique de la dernière réponse terminée.
 *
 * Volontairement sans état de rendu : le suivi des messages déjà lus vit dans
 * une ref, sinon chaque lecture provoquerait un rendu, qui déclencherait à son
 * tour l'effet, qui parlerait à nouveau.
 *
 * On ne parle qu'une fois par message et seulement une fois la génération
 * terminée : lire le texte au fil du flux donnerait une diction hachée, et
 * reparler à chaque fragment ferait repartir la synthèse en boucle.
 *
 * @param {Array} messages Messages de la conversation, du plus ancien au plus récent.
 */
export default function useAutoSpeak(messages) {
  const { settings } = useSettings();
  const spokenIdsRef = useRef(new Set());

  const speech = useSpeechOutput({
    lang: settings.voiceOutputLang,
    rate: settings.voiceOutputRate,
    pitch: settings.voiceOutputPitch,
  });

  // Dernier message de l'assistant exploitable : texte présent, pas en cours de
  // génération, sans erreur.
  const target = [...messages]
    .reverse()
    .find((message) => (
      message.role === 'assistant'
      && message.content
      && !message.streaming
      && !message.error
    ));

  const enabled = settings.voiceOutput && settings.voiceOutputAuto && speech.supported;

  useEffect(() => {
    if (!enabled || !target?.id) return;

    const spoken = spokenIdsRef.current;
    if (spoken.has(target.id)) return;
    spoken.add(target.id);

    // Le suivi est borné : sur une longue conversation, garder tous les identifiants
    // ferait croître le Set indéfiniment pour un navigateur.
    if (spoken.size > 200) {
      const oldest = spoken.values().next().value;
      spoken.delete(oldest);
    }

    speech.speak(target.content);
    // speech.speak est stable (mémoïsé sur [supported, cancel]) : inutile de le
    // lister, et le lister ferait dépendre l'effet d'une identité qui change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, target?.id]);

  // Désactiver la lecture automatique ne doit pas laisser le son en cours.
  //
  // La dépendance est `enabled` et rien d'autre : `speech` est un nouvel objet
  // à chaque rendu, donc le lister ferait appeler cancel() en boucle et
  // interromprait la lecture à la première actualisation de la page (tick de
  // l'indicateur de réveil, défilement, mise à jour d'état...). La fonction
  // elle-même est mémorisée en ref.
  const cancelRef = useRef(speech.cancel);
  cancelRef.current = speech.cancel;

  useEffect(() => {
    if (!enabled) cancelRef.current();
  }, [enabled]);

  return speech;
}
