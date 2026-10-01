/**
 * Nettoyage du WAV produit par la synthese vocale (SAPI) avant lecture.
 *
 * POURQUOI
 * --------
 * SAPI encadre chaque phrase de silences : ~110 ms au debut et ~772 ms a la
 * fin (mesures sur cette machine, voix Hortense/Paul). Comme le mode dialogue
 * fait lire les enonces LES UNS APRES LES AUTRES, chaque jointure ajoutait
 * ~883 ms de blanc. S y ajoutait la pause de fin de phrase que SAPI inscrit
 * DANS le signal (~888 ms apres un point), soit pres de 1,8 seconde de silence
 * pour une seule ponctuation : exactement la diction hachee, robotique, que le
 * mode dialogue produisait.
 *
 * Ce module retire les deux. Il travaille cote CLIENT pour une raison
 * concrete : l equivalente en PowerShell coute 2,0 s de balayage pur sur un WAV
 * de 280 Ko (mesure), ce qu on aurait ajoute a CHAQUE phrase. En JavaScript,
 * le meme traitement coute quelques millisecondes, une fois le WAV deja
 * telecharge.
 *
 * Il ne touche qu aux zones entierement silencieuses et conserve une marge
 * courte : le signal de parole n est jamais altere, seule la mort phonique
 * disparait.
 */

// Marge conservee en debut et en fin d enonce, pour ne pas coller le son au
// precedent ni le rogner. Sous ~25 ms, la jonction devient audible (clic) et
// la diction parait againee.
const KEEP_EDGE_MS = 35;
// Duree au-dela de laquelle un silence interne est considere comme une pause
// a resserrer. En dessous, c est une pause de respiration : on la garde.
const PAUSE_MIN_MS = 220;
// Duree a laquelle on ramene une pause interne. Une pause naturelle se mesure
// entre 120 et 250 ms ; 888 ms, c est une ponctuation de machine.
const PAUSE_TARGET_MS = 120;

/** Localise les chunks RIFF/format/data. Renvoie null si le WAV est inattendu. */
function parseWav(view) {
  if (view.byteLength < 44) return null;
  const tag = (o) => String.fromCharCode(
    view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3),
  );
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;

  let fmt = null;
  let dataOffset = -1;
  let dataLength = 0;
  let offset = 12;
  while (offset + 8 <= view.byteLength) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === 'fmt ') {
      fmt = {
        audioFormat: view.getUint16(offset + 8, true),
        channels: view.getUint16(offset + 10, true),
        sampleRate: view.getUint32(offset + 12, true),
        bitsPerSample: view.getUint16(offset + 22, true),
      };
    } else if (id === 'data') {
      dataOffset = offset + 8;
      dataLength = Math.min(size, view.byteLength - dataOffset);
      if (fmt) break;
    }
    offset += 8 + size + (size % 2);
  }
  if (!fmt || dataOffset < 0) return null;
  // PCM 16 bits mono : ce que produit SAPI. Tout autre format passe tel quel,
  // on ne devine pas.
  if (fmt.audioFormat !== 1 || fmt.bitsPerSample !== 16 || fmt.channels !== 1) return null;
  if (!fmt.sampleRate) return null;
  return { fmt, dataOffset, dataLength };
}

/** Seuil de silence : relatif au pic, avec un plancher absolu. */
function computeThreshold(samples) {
  let peak = 0;
  // Pic sur un echantillon : le detail n a pas d importance ici, seule
  // l echelle du signal compte.
  for (let i = 0; i < samples.length; i += 8) {
    const value = Math.abs(samples[i]);
    if (value > peak) peak = value;
  }
  return Math.max(300, peak * 0.02);
}
/**
 * Resserre les silences et rogne les bords d un WAV PCM 16 bits mono.
 *
 * @param {ArrayBuffer} buffer WAV brut.
 * @returns {ArrayBuffer} WAV nettoye, ou l entree si elle n est pas exploitable.
 */
export function trimWavSilence(buffer) {
  const view = new DataView(buffer);
  const parsed = parseWav(view);
  if (!parsed) return buffer;

  const { fmt, dataOffset, dataLength } = parsed;
  const count = Math.floor(dataLength / 2);
  if (count < 64) return buffer;

  const samples = new Int16Array(buffer, dataOffset, count);
  const threshold = computeThreshold(samples);
  const toSamples = (ms) => Math.round((ms * fmt.sampleRate) / 1000);

  // 1. Bordures
  let first = 0;
  while (first < count && Math.abs(samples[first]) <= threshold) first += 1;
  let last = count - 1;
  while (last > first && Math.abs(samples[last]) <= threshold) last -= 1;

  // Phrase entierement silencieuse : ne rien casser, on la laisse telle quelle.
  if (last <= first) return buffer;

  const edge = toSamples(KEEP_EDGE_MS);
  const start = Math.max(0, first - edge);
  const end = Math.min(count - 1, last + edge);

  // 2. Pauses internes : on garde la liste des echantillons a conserver, en
  // raccourcissant les silences trop longs.
  const pauseMin = toSamples(PAUSE_MIN_MS);
  const pauseTarget = toSamples(PAUSE_TARGET_MS);
  const kept = [];
  let cursor = start;
  let i = start;
  while (i <= end) {
    if (Math.abs(samples[i]) > threshold) { i += 1; continue; }
    const runStart = i;
    while (i <= end && Math.abs(samples[i]) <= threshold) i += 1;
    const runLength = i - runStart;
    if (runLength > pauseMin) {
      // On garde pauseTarget de silence, puis on saute le surplus.
      for (let k = cursor; k < runStart + pauseTarget; k += 1) kept.push(samples[k]);
      cursor = runStart + runLength;
    }
  }
  for (let k = cursor; k <= end; k += 1) kept.push(samples[k]);

  const keptCount = kept.length;
  if (keptCount === count && start === 0 && end === count - 1) return buffer;

  // 3. Reassemblage. On recopie le WAV jusqu au debut du data, puis les
  // echantillons, puis ce qui suivait ; les deux entetes de taille (RIFF et
  // data) sont reprises.
  const newDataBytes = keptCount * 2;
  const tailStart = dataOffset + dataLength;
  const tailLength = view.byteLength - tailStart;
  const out = new ArrayBuffer(dataOffset + newDataBytes + tailLength);
  const outView = new DataView(out);
  new Uint8Array(out, 0, dataOffset).set(new Uint8Array(buffer, 0, dataOffset));
  new Int16Array(out, dataOffset, keptCount).set(kept);
  if (tailLength > 0) {
    new Uint8Array(out, dataOffset + newDataBytes).set(new Uint8Array(buffer, tailStart, tailLength));
  }
  outView.setUint32(4, out.byteLength - 8, true);
  outView.setUint32(dataOffset - 4, newDataBytes, true);

  return out;
}

export default trimWavSilence;