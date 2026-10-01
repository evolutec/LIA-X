// Découpage d'un document en fragments (chunks) indexables.
//
// Objectif : un fragment doit contenir assez de contexte pour être compris seul,
// tout en restant assez court pour que le modèle puisse le citer précisément.
// On découpe en priorité sur les frontières de paragraphe, puis de phrase, et
// seulement en dernier recours sur une taille fixe.

const TARGET_CHARS = 1100;   // taille visée d'un fragment
const MAX_CHARS = 1600;      // on ne dépasse jamais cette taille
const OVERLAP_CHARS = 180;   // recouvrement entre fragments consécutifs
const MIN_CHARS = 120;       // en dessous, on fusionne avec le suivant

/** Normalise les fins de ligne et les espaces multiples. */
function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Retire les répétitions d'une ligne d'en-tête de tableau Markdown. */
function dedupeTableSeparators(lines) {
  return lines.filter((line, index) => {
    if (!/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)) return true;
    // Une ligne de séparation ne doit pas suivre une autre ligne de séparation.
    const previous = lines[index - 1];
    return !(previous && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(previous));
  });
}

/** Découpe un bloc de lignes en phrases, sans casser les abréviations usuelles. */
function splitSentences(block) {
  return block
    .split(/(?<=[.!?…])\s+(?=[A-ZÀ-ÖØ-Þ0-9«"'(\[])/u)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Découpe un texte long en fragments.
 * @returns {string[]} fragments non vides
 */
function chunkText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  if (normalized.length <= MAX_CHARS) return [normalized];

  // 1. Découpage en paragraphes, puis en phrases.
  const paragraphs = dedupeTableSeparators(normalized.split('\n\n'));
  const sentences = [];
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    if (splitSentences(trimmed).length === 1) {
      sentences.push(trimmed);
    } else {
      sentences.push(...splitSentences(trimmed));
    }
  }

  // 2. Regroupement en fragments de taille cible.
  const chunks = [];
  let current = '';
  for (const sentence of sentences) {
    // Un paragraphe isolé de type tableau Markdown ou bloc de code est
    // conservé tel quel : le découper produirait des fragments incompréhensibles.
    if (current.length + sentence.length + 1 > TARGET_CHARS && current.length >= MIN_CHARS) {
      chunks.push(current.trim());
      // Recouvrement : on repart des derniers mots du fragment précédent pour
      // qu'une phrase coupée par la frontière reste indexable des deux côtés.
      const tail = current.slice(-OVERLAP_CHARS);
      const boundary = tail.lastIndexOf(' ');
      current = (boundary > 0 ? tail.slice(boundary + 1) : tail) + ' ' + sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  // 3. Un fragment.unique trop long est coupé proprement.
  return chunks.flatMap((chunk) => {
    if (chunk.length <= MAX_CHARS) return [chunk];
    const pieces = [];
    for (let index = 0; index < chunk.length; index += MAX_CHARS) {
      const piece = chunk.slice(index, index + MAX_CHARS);
      if (piece.trim()) pieces.push(piece.trim());
    }
    return pieces;
  });
}

/**

/** Titre deviné pour l'interface, à partir du nom de fichier ou du contenu. */
function deriveTitle(text, fileName) {
  const trimmed = String(text ?? '').trim();
  if (trimmed.startsWith('#')) {
    const heading = trimmed.split('\n').find((line) => line.startsWith('#'));
    if (heading) return heading.replace(/^#+\s*/, '').slice(0, 200);
  }
  if (fileName) return String(fileName).replace(/\.[^.]+$/, '').slice(0, 200);
  return trimmed.slice(0, 80) || 'Document';
}

module.exports = { chunkText, normalizeText, deriveTitle, TARGET_CHARS, MAX_CHARS };
