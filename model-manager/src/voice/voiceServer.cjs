'use strict';

/**
 * Serveur de reconnaissance vocale pour le mode dialogue.
 *
 * Pourquoi un serveur, et pas SpeechRecognition dans le navigateur :
 * l annulation d echo du navigateur n a de reference que pour les chemins qu il
 * possede (un <audio>, une piste WebRTC). SpeechRecognition ouvre sa propre
 * capture, hors de notre controle : le micro capte alors la voix du modele avec
 * autant de clarte qu un humain (verifie : le mot-cle du TTS etait transcrit).
 * getUserMedia, lui, nous rend une piste deja soustraite (verifie : rapport
 * x0,2, soit sous le bruit de fond). On capture donc nous-memes, et on
 * transcrit ici.
 *
 * La detection de fin de tour est une VAD par ENERGIE, pas la transcription :
 * Whisper hallucine volontaire sur du non-parole (il sort "*sous-titres*" sur un
 * simple bip). Sans cette porte, chaque silence enverrait une phrase inventee au
 * modele.
 */

const path = require('path');

// Modele Whisper quantifie : ~40 Mo, assez pour la dictee en francais et
// largement plus rapide qu un modele de taille moyenne sur CPU.
const WHISPER_MODEL = process.env.VOICE_STT_MODEL || 'Xenova/whisper-tiny';

// Cache dans le volume monte /models : sinon le modele serait retelecharge a
// chaque recreation du conteneur.
const CACHE_DIR = process.env.VOICE_CACHE_DIR || path.join(process.env.MODEL_STORAGE_DIR || '/models', '.cache', 'transformers');

const SAMPLE_RATE = 16000;

// ── VAD ───────────────────────────────────────────────────────────────────────
// Seuil de parole, relatif au bruit de fond mesure. L audio arrivant deja
// assaini par l AEC, un facteur faible suffit et reste stable.
const SPEECH_FACTOR = 3.2;
const NOISE_FLOOR_MIN = 0.0025;
// Duree de silence qui clot un tour de parole.
const HANGOVER_MS = 700;
// Un tour plus court est du bruit, pas une phrase.
const MIN_UTTERANCE_MS = 350;

let pipelinePromise = null;

/** Charge Whisper une seule fois, a la demande. */
async function getAsr() {
  if (!pipelinePromise) {
    const { pipeline, env } = require('@huggingface/transformers');
    env.cacheDir = CACHE_DIR;
    pipelinePromise = pipeline('automatic-speech-recognition', WHISPER_MODEL, { dtype: 'q8' })
      .catch((error) => {
        // On oublie l echec : un nouvel essai plus tard doit pouvoir reussir.
        pipelinePromise = null;
        throw error;
      });
  }
  return pipelinePromise;
}

/** Etat de detection de parole pour une connexion. */
function createVad() {
  return {
    noiseFloor: NOISE_FLOOR_MIN,
    speaking: false,
    startedAt: 0,
    lastVoiceAt: 0,
    frames: [],
    busy: false,
  };
}

function rmsOf(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Accepte un morceau de PCM et renvoie la parole complete lorsqu elle se termine.
 * @returns {Promise<string|null>}
 */
async function pushAudio(vad, samples) {
  const rms = rmsOf(samples);
  const threshold = Math.max(vad.noiseFloor * SPEECH_FACTOR, NOISE_FLOOR_MIN * 2);

  if (rms < threshold) {
    // Suivi du bruit de fond, uniquement hors parole : la voix elle-meme ne
    // doit pas relever le plancher, sinon le seuil finirait par depasser le son.
    vad.noiseFloor = vad.noiseFloor * 0.98 + rms * 0.02;
  }

  const now = Date.now();
  const frameMs = (samples.length / SAMPLE_RATE) * 1000;

  if (rms >= threshold) {
    if (!vad.speaking) {
      vad.speaking = true;
      vad.startedAt = now;
      vad.frames = [];
    }
    vad.lastVoiceAt = now;
  }

  if (vad.speaking) {
    // On ne stocke que la parole : garderait aussi le silence alourdirait le
    // modele et diluerait la transcription.
    if (rms >= threshold) vad.frames.push(samples);
    if (now - vad.lastVoiceAt > HANGOVER_MS) {
      const durationMs = now - vad.startedAt;
      const frames = vad.frames;
      vad.speaking = false;
      vad.frames = [];
      if (durationMs < MIN_UTTERANCE_MS) return null;
      return transcribe(frames, durationMs);
    }
  }

  void frameMs;
  return null;
}

/** Concatene les echantillons de voix et les transcrit. */
async function transcribe(frames, durationMs) {
  let total = 0;
  for (const frame of frames) total += frame.length;
  if (!total) return null;

  const pcm = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    pcm.set(frame, offset);
    offset += frame.length;
  }

  const asr = await getAsr();
  const started = Date.now();
  const result = await asr(pcm, { language: 'french', task: 'transcribe' });
  const text = String(result?.text || '').trim();

  console.log(
    `[voice] ${(durationMs / 1000).toFixed(1)}s -> "${text}" (${Math.round((Date.now() - started))} ms)`,
  );

  // Whisper ponctue ses sorties et peut restituer le texte en majuscules ou
  // entre asterisques : on nettoie pour ne pas envoyer de parasite au modele.
  const cleaned = text
    .replace(/^[\s*_]+|[\s*_]+$/g, '')
    .replace(/\s*\*[^*]*\*\s*/g, ' ')
    .trim();

  return cleaned || null;
}

/**
 * Branche le serveur de reconnaissance vocale sur le serveur HTTP.
 *
 * Protocole, volontairement minimal :
 *   client -> binaire : trames de PCM Float32 mono a 16 kHz
 *   client -> JSON     : { type: 'ping' }
 *   serveur -> JSON    : { type: 'ready' | 'transcript' | 'error', ... }
 *
 * Le binaire evite l'overhead de base64 sur un flux continu : a 16 kHz en Float32
 * on parle de 256 ko/s, que base64 gonflerait de 33 %.
 */
function attachVoiceServer(httpServer) {
  const { WebSocketServer } = require('ws');
  const wss = new WebSocketServer({ server: httpServer, path: '/ws/voice' });

  wss.on('connection', (socket) => {
    console.log('[voice] client connecte');
    const vad = createVad();
    send(socket, { type: 'ready', sampleRate: SAMPLE_RATE });

    socket.on('message', async (data, isBinary) => {
      if (!isBinary) {
        try {
          const message = JSON.parse(data.toString());
          if (message?.type === 'ping') send(socket, { type: 'pong' });
          if (message?.type === 'reset') {
            vad.speaking = false;
            vad.frames = [];
          }
        } catch { /* message illisible : ignore */ }
        return;
      }

      // Copie obligatoire : le buffer de ws est reutilise apres le retour.
      const buffer = Buffer.from(data);
      const samples = new Float32Array(
        buffer.buffer,
        buffer.byteOffset,
        Math.floor(buffer.byteLength / 4),
      );

      // Une seule transcription a la fois par connexion : sans cela, deux tours
      // de parole rapproches lanceraient Whisper en parallele sur le meme core.
      if (vad.busy) return;
      vad.busy = true;
      try {
        const text = await pushAudio(vad, samples);
        if (text) send(socket, { type: 'transcript', text });
      } catch (error) {
        console.error('[voice] transcription impossible :', error.message);
        send(socket, { type: 'error', message: error.message });
      } finally {
        vad.busy = false;
      }
    });

    socket.on('close', () => {
      vad.speaking = false;
      vad.frames = [];
      console.log('[voice] client deconnecte');
    });
  });

  // On precharge Whisper en arriere-plan : sans cela, le premier tour de parole
  // apres un demarrage attended plusieurs secondes le chargement du modele.
  getAsr()
    .then(() => console.log(`[voice] modele STT pret (${WHISPER_MODEL})`))
    .catch((error) => console.warn('[voice] STT indisponible :', error.message));

  return wss;
}

function send(socket, payload) {
  if (socket.readyState === 1) socket.send(JSON.stringify(payload));
}

module.exports = { attachVoiceServer, getAsr };
