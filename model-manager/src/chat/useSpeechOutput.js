import { useCallback, useEffect, useRef, useState } from 'react';
import { trimWavSilence } from './wavTrim';

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

/** Telecharge le WAV d un enonce. Separe du playing pour permettre le prefetch. */
  const fetchChunk = useCallback(async (text) => {
    const response = await fetch('/api/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, rate: rateRef.current }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail.slice(0, 200) || `TTS ${response.status}`);
    }
    const buffer = await response.arrayBuffer();
    // Rognage des silences : SAPI encadre chaque phrase de ~880 ms de blanc
    // (110 ms de tete, 772 ms de queue). Comme les enonces s enchainent, ces
    // blancs s additionnaient et chaque point de la reponse couteait pres de
    // deux secondes de muet : c etait la diction robotique signalee.
    const cleaned = trimWavSilence(buffer);
    // Un WAV sans en-tete ne peut pas etre relu : on retombe alors sur
    // l original plutot que de faire echouer la lecture.
    return cleaned.byteLength > 44 ? cleaned : buffer;
  }, []);

  /** Joue un WAV deja telecharge ; resout quand l enonce est fini. */
  const playChunk = useCallback((buffer) => new Promise((resolve, reject) => {
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    const url = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
    urlRef.current = url;
    const audio = new window.Audio(url);
    audioRef.current = audio;
    // L AEC a besoin de la copie EXACTE du son joue : qu elle soit decalee
    // d un rognage, et c est l echo de la voix du modele qui reste dans le
    // flux du micro. D ou le rognage fait en amont, dans fetchChunk.
    audio.onended = () => { releaseAudio(); resolve(); };
    audio.onerror = () => { releaseAudio(); reject(new Error('lecture audio impossible')); };
    const played = audio.play();
    // Chrome refuse parfois de demarrer sans geste utilisateur : le reje
    // joue quand la promesse est rejetee plutot que de laisser muet.
    if (played && typeof played.catch === 'function') {
      played.catch(reject);
    }
  }), [releaseAudio]);

  /**
   * Joue une suite d enonces en PIPELINE.
   *
   * Le decalage entre la voix et le texte venait d ici : chaque enonce etait
   * attendu en entier avant que le suivant ne soit meme demande. La synthese
   * SAPI coutant 0,6 a 3 s, la voix arrivait donc toujours plusieurs phrases en
   * retard, d autant plus que le cache du controleur n etait jamais alimente et
   * que chaque phrase relancait une synthese complete.
   *
   * On demande donc l enonce N+1 PENDANT la lecture de N : la seule latence qui
   * subsiste est celle de la premiere phrase.
   */
  const runParts = useCallback((parts) => {
    let pending = fetchChunk(parts[0]);
    return (async () => {
      for (let i = 0; i < parts.length; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        const blob = await pending;
        if (i + 1 < parts.length) pending = fetchChunk(parts[i + 1]);
        // eslint-disable-next-line no-await-in-loop
        await playChunk(blob);
      }
    })();
  }, [fetchChunk, playChunk]);

  /** Ajoute une suite d enonces a la file de lecture. */
  const queue = useCallback((text) => {
    const clean = stripMarkdown(text);
    if (!clean) return false;

    const parts = chunkText(clean);
    if (!parts.length) return false;

    setError('');
    setSpeaking(true);
    // Les enonces s enchainent : chacun attend la fin du precedent, sinon ils se
    // superposent et l annulation d echo a plusieurs references a suivre.
    chainRef.current = chainRef.current
      .then(() => runParts(parts))
      .catch((cause) => {
        setError(`Lecture impossible : ${cause?.message || cause}`);
      })
      .then(() => {
        setSpeaking(false);
      });

    return true;
  }, [runParts]);

  const speak = useCallback((text) => {
    // speak() sert a repartir de zero : il coupe la lecture en cours avant
    // d enqueuer. C est ce qui le distingue de enqueue(), et la seule raison
    // pour laquelle cancel() reste appele ici.
    cancel();
    return queue(text);
  }, [cancel, queue]);

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
  const enqueue = useCallback((text) => queue(text), [queue]);
  useEffect(() => () => releaseAudio(), [releaseAudio]);

  return { supported, speaking, error, speak, enqueue, cancel };
}