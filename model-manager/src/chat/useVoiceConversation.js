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

const GATE_SPEECH_THRESHOLD = 0.006;
// Duree pendant laquelle une energie breve vaut encore preuve de parole.
const GATE_MEMORY_MS = 1800;

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
      if (level < GATE_SPEECH_THRESHOLD) return;

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
      sentences.forEach(({ sentence }) => speechRef.current.enqueue(sentence));
      return;
    }
    const rest = text.slice(spokenCursorRef.current).trim();
    if (rest) {
      spokenCursorRef.current = text.length;
      speechRef.current.enqueue(rest);
    }
  }, [active, text, streaming]);

  return {
    supported: isVoiceSupported(),
    active,
    listening,
    toggle,
    error,
    streaming,
  };
}
