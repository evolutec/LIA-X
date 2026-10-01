/**
 * Capture audio en PCM Float32, transmise au thread principal.
 *
 * pourquoi un AudioWorklet et pas un simple AnalyserNode : on a besoin des
 * echantillons, pas seulement de leur energie. Un AnalyserNode ne sort qu'un
 * spectre.
 *
 * pourquoi regrouper les trames : process() est appele toutes les 128 trames,
 * soit 8 ms en 16 kHz. Poster 125 messages par seconde saturerait le socket pour
 * rien. On regroupe donc ~50 ms (800 trames, 3,2 ko), ce qui reste assez reactif
 * pour la detection de fin de parole tout en restant econome.
 *
 * Le contexte est cree en 16 kHz cote page : Chrome sous-echantillonne alors
 * lui-meme le flux du micro, ce qui evite tout traitement de signal maison.
 */

const FRAMES_PER_CHUNK = 800;

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(FRAMES_PER_CHUNK);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;

    let offset = 0;
    while (offset < channel.length) {
      const space = FRAMES_PER_CHUNK - this.filled;
      const take = Math.min(space, channel.length - offset);
      this.buffer.set(channel.subarray(offset, offset + take), this.filled);
      this.filled += take;
      offset += take;

      if (this.filled === FRAMES_PER_CHUNK) {
        // Copie obligatoire : le buffer est reutilise a la trame suivante.
        const chunk = this.buffer.slice();
        this.port.postMessage(chunk.buffer, [chunk.buffer]);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
