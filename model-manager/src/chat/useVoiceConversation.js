import { useCallback, useEffect, useRef, useState } from 'react';
import useSpeechOutput from './useSpeechOutput';
import { useSettings } from '../Settings/settingsStore';

/**
 * Mode "dialogue vocal" : transcription Chrome, porte d'entree anti-echo.
 *
 * Deux acquisition, chacune pour ce qu elle fait de mieux.
 *
 * 1. TRANSCRIPTION — SpeechRecognition, exactement comme le micro du composeur.
 *    C est la source de verite pour la qualite : elle est bien meilleure que
 *    Whisper-tiny sur du francais, et elle ne demande aucun modele local.
 *
 * 2. PORTE ANTI-ECHO — getUserMedia avec echoCancellation. On ne lit JAMAIS ce
 *    flux, on ne le transcrit pas : on ne mesure que son ENERGIE. Le navigateur
 *    a soustrait le TTS de ce flux (mesure : rapport x0,2, sous le bruit de
 *    fond), donc l energy ne depasse le seuil que sur de la VRAIE parole.
 *
 *    C est la que reside tout l interet. SpeechRecognition ouvre sa propre
 *    capture et n annule pas l echo : sans la porte, la voix du modele est
 *    retranscrite en boucle. Avec elle, on ignore toute transcription qui
 *    n est accompagnee d une energie reelle, et on interrompt la lecture des
 *    que l utilisateur prend la parole.
 */

// Seuil de parole du flux assaini par l AEC, calcule RELATIVEMENT au bruit de
// fond observe plutot que fixe.
//
// Un seuil absolu ne tient pas : l efficacite de l annulation d echo depend de
// la distance micro / haut-parleurs et du volume de lecture. Une valeur
// mesuree dans de bonnes conditions ne vaut pas pour toutes les situations, et
// un seuil trop bas laisse passer l echo residual, que le microphone presente
// alors comme une voix.
//
// On releve donc le plancher observe et on se cale au-dessus, avec un plancher
// minimal pour rester sensible dans une piece silencieuse.
const GATE_NOISE_FLOOR_MIN = 0.0015;
const GATE_NOISE_FACTOR = 6;
// Duree pendant laquelle une energie breve vaut encore preuve de parole.
const GATE_MEMORY_MS = 1800;
// Nombre de blocs CONSECUTIFS au-dessus du seuil avant d admettre que
// l utilisateur parle vraiment (1 bloc = 50 ms).
//
// Pourquoi ce debounce est indispensable : le seuil separe la parole du bruit,
// il ne garantit pas l absence de faux positifs. Une porte de Kennyson, un
// plancher de bruit qui monte, une syllabe explosive ou le debattement d une
// chaise suffisaient a faire DEPASSER le seuil une seule fois. Or chaque
// passage appelle speechRef.current.cancel() et onStopRef.current() : sans
// debounce, une seule fausse detection suffisait a couper la lecture en cours
// ET a interrompre la generation. C etait la cause directe du symptome
// « pas de sortie vocale » : chaque phrase prononcae etait tuee dans les
// quelques centaines de millisecondes qui suivent sa mise en file.
//
// 3 blocs = 150 ms, assez court pour que le barge-in reste imperceptible, assez
// long pour ecarter un pic isole.
const GATE_DEBOUNCE_BLOCKS = 3;


// ─────────────────────────────────────────────────────────────────────────────
// Anti-echo PAR LE TEXTE
//
// La porte energetique ne suffit pas, et la capture Montre pourquoi.
// SpeechRecognition n annule pas l echo : il capte la voix du modele. Chrome
// livre les resultats FINAUX avec un retard variable, souvent 1 a 3 s. A ce
// moment, la lecture est terminee, l energie est retombee, et la porte decide
// que la transcription ne correspond a aucune parole reelle : elle est
// normalement rejetee.
//
// Mais la porte n a qu une memoire de 1800 ms. Le texte transcrit arrive alors
// que le micro a encore enregistre la fin du TTS : la porte est encore
// ouverte, la transcription passe, et le modele se repond a lui-meme. Le
// symptome observe : « J espe que vous avez aime ! » et « qu en pensez-vous ? »
// — la DERNIERE phrase de chaque reponse —-envoyees comme messages utilisateur.
//
// Ce filtre compare donc la transcription au texte reellement prononce. Il ne
// repose sur aucun timing, donc sur la seule donnee qui est fiable : ce que
// nous venons de dire.
// ─────────────────────────────────────────────────────────────────────────────

/** Normalise pour une comparaison : minuscules, sans accents ni ponctuation. */
function normalizeForEcho(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Fenetre de texte prononce retenue pour la comparaison.
//
// 800 caracteres, et non 400 : Chrome peut livrer la transcription d une
// reponse avec pres d une seconde de retard, donc apres que le modele a deja
// commence la suivante. A 400, la fin de la reponse precedente etait deja hors
// memoire au moment du test : c est-a-dire precisement le cas de la capture
// (« J espe que vous avez aime ! »).
const ECHO_MEMORY_CHARS = 800;
// Dossier de mots consecutifs considers comme une preuve d echo. En dessous,
// une coincidence de deux mots n preuve rien ; au-dessus, la transcription ne
// peut pas venir du hasard.
const ECHO_NGRAM_WORDS = 4;

function makeEchoMatcher() {
  let spoken = '';
  return {
    /** Memorise ce qui vient d etre prononce. */
    record(text) {
      spoken = `${spoken} ${normalizeForEcho(text)}`.slice(-ECHO_MEMORY_CHARS);
    },
    /**
     * Vrai si `candidate` reproduit une suite de motsprononces recemment.
     * Une transcription d echo est litteralement le texte du modele ; une vraie
     * question de l utilisateur ne peut pas reproduire mot pour mot une
     * phrase qui vient d etre prononcee.
     */
    isEcho(candidate) {
      const words = normalizeForEcho(candidate).split(' ').filter(Boolean);
      if (words.length < ECHO_NGRAM_WORDS) return false;
      const haystack = spoken.split(' ');
      for (let i = 0; i + ECHO_NGRAM_WORDS <= words.length; i += 1) {
        const gram = words.slice(i, i + ECHO_NGRAM_WORDS).join(' ');
        for (let j = 0; j + ECHO_NGRAM_WORDS <= haystack.length; j += 1) {
          if (haystack.slice(j, j + ECHO_NGRAM_WORDS).join(' ') === gram) return true;
        }
      }
      return false;
    },
  };
}
function getRecognitionCtor() {
  if (typeof window === 'undefined') return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

export function isVoiceSupported() {
  return Boolean(
    typeof navigator !== 'undefined'
    && navigator.mediaDevices?.getUserMedia
    && ('AudioWorkletNode' in window)
    && getRecognitionCtor()
    && 'WebSocket' in window,
  );
}

/** Energie moyenne d un morceau de PCM. */
function rms(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function takeCompleteSentences(text, fromIndex) {
  const sentences = [];
  let cursor = fromIndex;
  let index = fromIndex;
  while (cursor < text.length) {
    const boundary = /[.!?…](\s|$)/.exec(text.slice(cursor));
    if (!boundary) break;
    const end = cursor + boundary.index + boundary[0].length;
    const sentence = text.slice(index, end).trim();
    if (sentence) sentences.push({ sentence, end });
    index = end;
    cursor = end;
  }
  return { sentences, cursor: index };
}

export default function useVoiceConversation({ onSend, onStop, streaming, text }) {
  const [active, setActive] = useState(false);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState('');

  const { settings } = useSettings();
  // Le debit est applique par le serveur (SAPI) : on le transmet ici, sinon le
  // mode dialogue ignorerait le reglage choisi dans les parametres.
  const speech = useSpeechOutput({ rate: settings.voiceOutputRate });
  const recognitionRef = useRef(null);
  const streamRef = useRef(null);
  const ctxRef = useRef(null);
  const spokenCursorRef = useRef(0);
  const realSpeechAtRef = useRef(0);
  // Plancher de bruit du flux, releve en continu pour calibrer le seuil.
  const noiseFloorRef = useRef(GATE_NOISE_FLOOR_MIN);
  // Nombre de blocs consecutifs au-dessus du seuil : anti-rebond de la porte.
  const speechRunRef = useRef(0);
  // Memoire du texte prononce, pour rejeter un echo transcrit.
  const echoRef = useRef(makeEchoMatcher());

  const speechRef = useRef(speech);
  const onSendRef = useRef(onSend);
  const onStopRef = useRef(onStop);
  speechRef.current = speech;
  onSendRef.current = onSend;
  onStopRef.current = onStop;

  const stopAll = useCallback(() => {
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) { try { recognition.stop(); } catch { /* deja arrete */ } }
    try { streamRef.current?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { ctxRef.current?.close(); } catch { /* deja ferme */ }
    streamRef.current = null;
    ctxRef.current = null;
    setListening(false);
  }, []);

  /** Demarre la porte anti-echo : elle mesure, elle ne transcrit pas. */
  const startGate = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    streamRef.current = stream;

    const ctx = new AudioContext({ sampleRate: 16000 });
    ctxRef.current = ctx;
    await ctx.audioWorklet.addModule('/voice-worklet.js');

    const source = ctx.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(ctx, 'pcm-capture');

    worklet.port.onmessage = (event) => {
      const level = rms(new Float32Array(event.data));
      const seuil = Math.max(noiseFloorRef.current * GATE_NOISE_FACTOR, GATE_NOISE_FLOOR_MIN);

      if (level < seuil) {
        // Releve du bruit de fond sur les niveaux FAIBLES seulement : si la
        // voix entraine le plancher, le seuil la suivrait et la porte ne
        // detecterait plus rien.
        noiseFloorRef.current = noiseFloorRef.current * 0.98 + level * 0.02;
        // Un bloc faible annule la serie en cours : seule une energie SOUTENUE
        // compte comme prise de parole.
        speechRunRef.current = 0;
        return;
      }

      // Energie au-dessus du seuil : on compte. Ce n est qu a partir du
      // troisieme bloc consecutif que l on admet une vraie prise de parole.
      speechRunRef.current += 1;
      if (speechRunRef.current < GATE_DEBOUNCE_BLOCKS) return;

      // Preuve de parole reelle : l echo du TTS a ete soustrait, il ne peut pas
      // faire monter l energie au-dessus du seuil.
      const now = Date.now();
      realSpeechAtRef.current = now;

      // Barge-in : l utilisateur prend la parole, on libere le canal audio.
      if (speechRef.current.speaking) {
        speechRef.current.cancel();
        onStopRef.current?.();
      }
    };

    const silent = ctx.createGain();
    silent.gain.value = 0;
    source.connect(worklet);
    worklet.connect(silent);
    silent.connect(ctx.destination);
    if (ctx.state === 'suspended') await ctx.resume();
  }, []);

  const startRecognition = useCallback(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor || recognitionRef.current) return;

    const recognition = new Ctor();
    recognition.lang = (typeof navigator !== 'undefined' && navigator.language) || 'fr-FR';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let finalText = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal) finalText += result[0]?.transcript || '';
      }
      const cleaned = finalText.trim();
      if (!cleaned) return;

      // ANTI-ECHO PAR LE TEXTE : le filtre qui robustement empeche le modele de
      // se repondre. On le place AVANT la porte energetique : la porte peut
      // hesiter sur le retard de Chrome, la comparaison de texte, non.
      if (echoRef.current.isEcho(cleaned)) return;

      // PORTE ANTI-ECHO : on ne garde la transcription que si la porte a vu de
      // la vraie parole autour. Sans elle, la voix du modele reviendrait ici en
      // boucle, car SpeechRecognition n annule pas l echo.
      if (Date.now() - realSpeechAtRef.current > GATE_MEMORY_MS) return;

      realSpeechAtRef.current = 0;
      if (speechRef.current.speaking) {
        speechRef.current.cancel();
        onStopRef.current?.();
      }
      onSendRef.current(cleaned);
    };

    recognition.onerror = (event) => {
      if (event?.error === 'no-speech' || event?.error === 'aborted') return;
      setError(event?.error === 'not-allowed'
        ? 'Acces au micro refuse. Autorisez-le dans la barre du navigateur.'
        : `Reconnaissance interrompue (${event?.error}).`);
    };
    recognition.onend = () => { recognitionRef.current = null; };

    recognitionRef.current = recognition;
    try { recognition.start(); } catch { recognitionRef.current = null; }
  }, []);

  const start = useCallback(async () => {
    setError('');
    realSpeechAtRef.current = 0;
    speechRunRef.current = 0;
    // On repart d une conversation vierge : le texte prononce precedent n a
    // plus rien a faire dans le filtre anti-echo.
    echoRef.current = makeEchoMatcher();
    try {
      await startGate();
      startRecognition();
      setListening(true);
    } catch (failure) {
      stopAll();
      setError(
        failure?.name === 'NotAllowedError'
          ? 'Acces au micro refuse. Autorisez-le dans la barre du navigateur.'
          : `Mode vocal indisponible : ${failure?.message || failure}`,
      );
    }
  }, [startGate, startRecognition, stopAll]);

  const toggle = useCallback(() => {
    if (active) {
      setActive(false);
      stopAll();
      speechRef.current.cancel();
      setError('');
      return;
    }
    setActive(true);
    spokenCursorRef.current = 0;
    start();
  }, [active, start, stopAll]);

  useEffect(() => () => stopAll(), [stopAll]);

  // Chrome arrete la reconnaissance continue : on la relance tant que le mode
  // est actif.
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => {
      if (!recognitionRef.current) startRecognition();
    }, 700);
    return () => clearInterval(timer);
  }, [active, startRecognition]);

  useEffect(() => {
    if (!active || !text) return;
    if (text.length < spokenCursorRef.current) {
      spokenCursorRef.current = 0;
      speechRef.current.cancel();
    }
    if (streaming) {
      const { sentences, cursor } = takeCompleteSentences(text, spokenCursorRef.current);
      if (!sentences.length) return;
      spokenCursorRef.current = cursor;
      sentences.forEach(({ sentence }) => {
        // On note ce qui va etre prononce AVANT de le jouer : c est ce texte
        // que le filtre anti-echo comparera aux transcriptions.
        echoRef.current.record(sentence);
        speechRef.current.enqueue(sentence);
      });
      return;
    }
    const rest = text.slice(spokenCursorRef.current).trim();
    if (rest) {
      spokenCursorRef.current = text.length;
      echoRef.current.record(rest);
      speechRef.current.enqueue(rest);
    }
  }, [active, text, streaming]);

  // L erreur de synthese vit dans useSpeechOutput ; sans ce pont elle restait
  // invisible. C est ce qui rendait le mode dialogue « muet » sans le moindre
  // message a l ecran : impossible de distinguer une panne du controleur d un
  // silence normal.
  useEffect(() => {
    if (speech.error) setError(speech.error);
  }, [speech.error]);

  return {
    supported: isVoiceSupported(),
    active,
    listening,
    toggle,
    error,
    streaming,
  };
}
