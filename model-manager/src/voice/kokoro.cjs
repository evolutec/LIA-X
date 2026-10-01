'use strict';

/**
 * Synthese vocale neuronale locale (Kokoro-82M) via ONNX Runtime.
 *
 * POURQUOI, ET POURQUOI ICI
 * ------------------------
 * SAPI est le seul TTS disponible sur cette machine : trois voix seulement
 * (Hortense, Julie, Paul), aucune voix neuronale Windows installee. Leur rendu
 * est hache, et aucune option de SAPI n'y change quoi que ce soit.
 *
 * Kokoro (82 M parametres, Apache-2.0) est un modele StyleTTS 2 decodeur :
 * texte -> phonemes -> mel -> forme d'onde, en UN SEUL passage, sans boucle
 * autoregressive. Ce n'est donc pas un LLM : il n'a ni contexte a conserver
 * entre les appels, ni besoin de rester resident en VRAM, et il n'entre pas en
 * concurrence avec les instances llama sur le GPU.
 *
 * Il s'execute ici, dans le conteneur, et non via le controleur Windows :
 *   - ONNX Runtime est DEJA present (v1.20.1, tire par @huggingface/transformers
 *     qui sert Whisper pour la reconnaissance vocale) : rien a installer ;
 *   - le controleur etant mono-thread, y faire tourner une synthese
 *     resimplementerait le blocage de 30 s corrige plus tot.
 *
 * Le WAV produit entre par la chaine existante (trimWavSilence puis <audio>),
 * donc l'annulation d echo et le filtrage anti-echo restent inchanges : ils
 * operent sur le signal, pas sur sa source.
 *
 * PERFORMANCES MESUREES sur cette machine (Arc 140V, 8 coeurs)
 * -----------------------------------------------------------
 *   model.onnx (fp32) + 4 threads : RTF 0,46 a 0,55
 *   model_q8f16.onnx + 4 threads  : RTF 1,14
 *   model_quantized (int8) + 4    : RTF 1,25
 *
 * Le quantifie est plus LENT que le fp32, contre-intuitif mais mesure : sur un
 * reseau de cette taille, la desquantification coute plus qu'elle ne fait
 * gagner. D'ou le choix du fp32 (310 Mo) malgre sa taille. Un RTF inferieur a
 * 1 signifie que la synthese devance la lecture : avec le prefetch deja en
 * place (l enonce N+1 est demande pendant la lecture de N), la voix ne decale
 * plus sur le texte.
 */

const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

// Racine des modeles : meme convention que le reste du serveur (MODEL_STORAGE_DIR).
const MODEL_DIR = process.env.MODEL_STORAGE_DIR || '/models';
const KOKORO_DIR = path.join(MODEL_DIR, '.cache', 'kokoro');

const MODEL_FILE = path.join(KOKORO_DIR, 'model.onnx');
const VOICE_FILE = path.join(KOKORO_DIR, 'ff_siwis.bin');
const VOCAB_FILE = path.join(__dirname, 'kokoro-vocab.json');

// Frequence de sortie du modele (kokoro_onnx/config.py : SAMPLE_RATE = 24000).
const SAMPLE_RATE = 24000;
// Au-dela, la qualite se degrade nettement (avertissement de l auteur du modele).
const MAX_PHONEMES = 510;
// 4 threads : mesure. Au-dela, la contention avec llama degrade tout (RTF 1,07
// a 8 threads contre 0,81 a 4 sur le meme texte).
const INFERENCE_THREADS = 4;

// 0 est le jeton de REMPLISSEMENT (PAD), pose au debut ET a la fin de la
// sequence. Il n existe aucun BOS ni EOS : la reference officielle
// (onnx-community/Kokoro-82M-v1.0-ONNX) fait exactement tokens = [[0, *tokens, 0]].
// Poser un identifiant de phoneme aux deux bouts donnait une prosodie
// deposee : le modele prononcait ces deux phonemes comme du texte, ce qui
// hachait l articulation - symptome d une voix qui s etouffe.
const TOKEN_PAD = 0;

// Nombre d entrees de style dans un .bin de voix (voir loadStyle).
const STYLE_ENTRIES = 510;

let sessionPromise = null;
let styleBuffer = null;
const styleCache = new Map();
let vocabCache = null;
let ortModule = null;

function getOrt() {
  if (!ortModule) {
    // eslint-disable-next-line global-require
    ortModule = require('onnxruntime-node');
  }
  return ortModule;
}
/** Phonemes fr-fr via espeak-ng. Variante IPA 3, celle attendue par Kokoro. */
function phonemize(text) {
  return new Promise((resolve, reject) => {
    execFile(
      'espeak-ng',
      ['-v', 'fr-fr', '--ipa=3', '-q', text],
      { encoding: 'utf8', maxBuffer: 1 << 24 },
      (error, stdout) => (error ? reject(new Error(`espeak-ng : ${error.message}`)) : resolve(stdout)),
    );
  });
}

function loadVocab() {
  if (vocabCache) return vocabCache;
  vocabCache = JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8')).vocab;
  return vocabCache;
}

/**
 * Phonemes -> identifiants de tokens.
 *
 * Tout symbole hors vocabulaire est IGNORE, et non signale en erreur : c est
 * exactement le comportement de kokoro-onnx, et la raison pour laquelle un
 * caractere non prevu (emoji, symbole) ne fait pas echouer la synthese.
 */
function phonemesToIds(phonemes) {
  const vocab = loadVocab();
  const ids = [];
  for (const symbol of phonemes) {
    if (symbol === '\n' || symbol === '\r') continue;
    // Les espaces SONT conserves : ils portent le rythme de l enonce et
    // l espace fait partie du vocabulaire (id 16). Les supprimer_launchait
    // des mots colles, sans aucune pause entre eux.
    const id = vocab[symbol];
    // Symbole hors vocabulaire : ignore, comme le fait la reference. C est
    // ce qui permet de laisser passer un emoji ou un symbole.
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * Vecteur de style = la voix ET le timbre du rendu.
 *
 * Le .bin contient 510 entrees. Elles ne sont PAS 510 voix : ce sont 510
 * declinaisons de la meme voix, une par duree d enonce. La reference
 * officielle choisit l indice par la longueur des jetons :
 *     ref_s = voices[len(tokens)]
 *
 * C est la cle du probleme de diction. Utiliser toujours l indice 0
 * imposait a une phrase longue le timbre d un enonce minuscule : le
 * modele debordait, les syllabes se chevauchaient et l articulation
 * parait s etouffer. Mesure sur la meme phrase : RMS 0,070 avec l indice
 * fixe contre 0,105 avec l indice officiel, et le profil d energie
 * passe d une serie de trous a une suite continue.
 *
 * @param {number} length nombre de jetons de l enonce.
 * @returns {Float32Array} les 256 flottants du style.
 */
function loadStyle(length = 0) {
  if (!styleBuffer) {
    const buffer = fs.readFileSync(VOICE_FILE);
    // voices-v1.0.bin : 510 entrees x 256 float32.
    styleBuffer = new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
  }
  const entries = Math.floor(styleBuffer.length / 256);
  const wanted = Math.max(0, Math.min(length, entries - 1));
  // Mise en cache par duree : un enonce de 60 jetons relu dix fois dans une
  // meme reponse ne doit pas etre relu depuis le disque dix fois.
  const key = String(wanted);
  if (styleCache.has(key)) return styleCache.get(key);
  const slice = styleBuffer.slice(wanted * 256, wanted * 256 + 256);
  styleCache.set(key, slice);
  if (styleCache.size > 64) styleCache.delete(styleCache.keys().next().value);
  return slice;
}

/** Charge la session ONNX une seule fois, puis la conserve en memoire. */
async function getSession() {
  if (sessionPromise) return sessionPromise;
  sessionPromise = getOrt().InferenceSession.create(MODEL_FILE, {
    graphOptimizationLevel: 'all',
    intraOpNumThreads: INFERENCE_THREADS,
    interOpNumThreads: 1,
  }).catch((error) => {
    // Un echec ne doit pas definitivement casser la synthese : le nouvel essai
    // doit pouvoir reussir (modele GW le fichier, memoire liberee...).
    sessionPromise = null;
    throw error;
  });
  return sessionPromise;
}

/** Fabrique un WAV PCM 16 bits mono a partir des echantillons du modele. */
function encodeWav(samples) {
  const count = samples.length;
  const buffer = Buffer.alloc(44 + count * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + count * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);          // PCM
  buffer.writeUInt16LE(1, 22);          // mono
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    buffer.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2);
  }
  return buffer;
}

/** Le moteur est-il utilisable ? Verifie les fichiers avant de promettre. */
function isAvailable() {
  return fs.existsSync(MODEL_FILE) && fs.existsSync(VOICE_FILE) && fs.existsSync(VOCAB_FILE);
}

/**
 * Synthetise un texte et renvoie un WAV.
 *
 * @param {string} text
 * @param {number} speed multiplicateur de debit (1 = normal).
 * @returns {Promise<Buffer>}
 */
async function synthesize(text, speed = 1) {
  if (!isAvailable()) throw new Error('modele Kokoro absent du cache');
  const session = await getSession();
  const phonemes = await phonemize(text);
  const core = phonemesToIds(phonemes);
  if (core.length < 3) throw new Error('aucun phoneme exploitable dans ce texte');
  if (core.length + 2 > MAX_PHONEMES) {
    throw new Error(`texte trop long (${core.length} phonemes, maximum ${MAX_PHONEMES})`);
  }

  // 0 = PAD, au debut et a la fin. C est la forme attendue par le modele.
  const ids = [TOKEN_PAD, ...core, TOKEN_PAD];
  // Le style se choisit sur la longueur de l enonce, pas a l avril.
  const style = loadStyle(core.length);

  const ort = getOrt();
  const result = await session.run({
    input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new ort.Tensor('float32', style, [1, 256]),
    speed: new ort.Tensor('float32', Float32Array.from([speed || 1]), [1]),
  });
  return encodeWav(result.waveform.data);
}

module.exports = { synthesize, isAvailable, phonemesToIds, SAMPLE_RATE, KOKORO_DIR, STYLE_ENTRIES };
