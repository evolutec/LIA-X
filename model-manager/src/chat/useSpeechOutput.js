import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Synthese vocale : le WAV est produit par le CONTROLEUR (SAPI Windows) et
 * joue dans un element <audio>.
 *
 * Pourquoi ne pas utiliser speechSynthesis : cette API sort du systeme audio du
 * navigateur, qui ne dispose alors pas de la copie du son joue — le signal de
 * reference que l annuleur d echo doit soustraire du signal du micro. Le
 * navigateur entend donc le modele aussi bien qu un humain, le reconnaiseur le
 * transcrit, et le modele se repond a lui-meme.
 *
 * En passant par <audio>, ce signal existe enfin et l annulation d echo peut
 * fonctionner. C est la condition d un vrai mode duplex.
 *
 * Note : SAPI choisit la voix et le debit cote serveur. La hauteur (pitch) n a
 * pas d equivalent cote Windows : le reglage est ignore pour la lecture vocale.
 */

const MAX_CHUNK_LENGTH = 200;

/** Nettoie le Markdown pour qu il soit prononce naturellement. */
export function stripMarkdown(text) {
  if (!text) return '';
  return String(text)
    .replace(/```[\s\S]*?```/g, ' bloc de code ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s{0,3}[-*+]\s+/gm, '')
    .replace(/^\s{0,3}\d+[.)]\s+/gm, '')
    .replace(/(\*\*|__|~~|\*|_)/g, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Decoupe en enonces courts : les voix SAPI restent fluides sous 200 caracteres. */
function chunkText(text) {
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > MAX_CHUNK_LENGTH) {
    const window = remaining.slice(0, MAX_CHUNK_LENGTH);
    const cut = Math.max(
      window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
      window.lastIndexOf('; '), window.lastIndexOf(', '),
    );
    const end = cut > 40 ? cut + 1 : MAX_CHUNK_LENGTH;
    chunks.push(remaining.slice(0, end).trim());
    remaining = remaining.slice(end).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

export function getVoices() { return []; }
export function filterVoicesByLang(voices) { return voices; }

export default function useSpeechOutput({ rate = 1 } = {}) {
  const [speaking, setSpeaking] = useState(false);
  const [error, setError] = useState('');

  const audioRef = useRef(null);
  const urlRef = useRef(null);
  const chainRef = useRef(Promise.resolve());
  const rateRef = useRef(rate);
  rateRef.current = rate;

  const supported = typeof window !== 'undefined' && typeof window.Audio === 'function';

  const releaseAudio = useCallback(() => {
    const audio = audioRef.current;
    audioRef.current = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load?.();
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    }
  }, []);

  const cancel = useCallback(() => {
    releaseAudio();
    chainRef.current = Promise.resolve();
    setSpeaking(false);
  }, [releaseAudio]);

  /** Telecharge un WAV et le joue ; resout quand l enonce est fini. */
  const playChunk = useCallback((text) => {
    setError('');
    return fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, rate: rateRef.current }),
    })
      .then((response) => {
        if (!response.ok) {
          return response.text().then((detail) => {
            throw new Error(detail.slice(0, 200) || `TTS ${response.status}`);
          });
        }
        return response.blob();
      })
      .then((blob) => new Promise((resolve, reject) => {
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        const url = URL.createObjectURL(blob);
        urlRef.current = url;
        const audio = new window.Audio(url);
        audioRef.current = audio;
        audio.onended = () => { releaseAudio(); resolve(); };
        audio.onerror = () => { releaseAudio(); reject(new Error('lecture audio impossible')); };
        const played = audio.play();
        // Chrome refuse parfois de demarrer sans geste utilisateur : le reje
        // joue quand la promesse est rejetee plutot que de laisser muet.
        if (played && typeof played.catch === 'function') {
          played.catch(reject);
        }
      }));
  }, [releaseAudio]);

  const speak = useCallback((text) => {
    const clean = stripMarkdown(text);
    if (!clean) return false;

    cancel();
    const parts = chunkText(clean);
    if (!parts.length) return false;

    setSpeaking(true);
    // Les enonces s enchainent : chacun attend la fin du precedent, sinon ils se
    // superposent et l annulation d echo a plusieurs references a suivre.
    chainRef.current = chainRef.current
      .then(async () => {
        for (const part of parts) {
          // eslint-disable-next-line no-await-in-loop
          await playChunk(part);
        }
      })
      .catch((cause) => {
        setError(`Lecture impossible : ${cause?.message || cause}`);
      })
      .then(() => {
        setSpeaking(false);
      });

    return true;
  }, [cancel, playChunk]);

  /**
   * Ajoute un enonce a la file SANS interrompre la lecture en cours.
   *
   * C est la difference avec speak() qui corrige le decalage entre l affichage
   * et la voix. Pendant la generation, le texte arrive phrase par phrase ;
   * speak() appelle cancel() a chaque fois, donc chaque nouvelle phrase
   * interrompait la precedente et le son n arrivait toujours pas au rythme du
   * texte. Ici les enonces s enchainent, dans l ordre, sans se couper.
   *
   * cancel() reste le bon outil pour repartir de zero (nouvelle intervention).
   */
  const enqueue = useCallback((text) => {
    const clean = stripMarkdown(text);
    if (!clean) return false;

    const parts = chunkText(clean);
    if (!parts.length) return false;

    setError('');
    setSpeaking(true);
    chainRef.current = chainRef.current
      .then(async () => {
        for (const part of parts) {
          // eslint-disable-next-line no-await-in-loop
          await playChunk(part);
        }
      })
      .catch((cause) => {
        setError(`Lecture impossible : ${cause?.message || cause}`);
      })
      .then(() => {
        setSpeaking(false);
      });

    return true;
  }, [playChunk]);
  useEffect(() => () => releaseAudio(), [releaseAudio]);

  return { supported, speaking, error, speak, enqueue, cancel };
}
