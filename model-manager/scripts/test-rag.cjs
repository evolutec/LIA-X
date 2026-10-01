// Tests du découpage de files et de la mise en forme des vecteurs.
// Usage : node scripts/test-rag.cjs (contexte : Node, sans base requise).

const { chunkText, deriveTitle, normalizeText } = require('../src/rag/chunking.cjs');
const { toPgVector } = require('../src/rag/embeddings.cjs');
const extractors = require('../src/rag/extractors.cjs');
const limits = require('../src/rag/limits.cjs');

let failures = 0;
function check(label, condition, detail) {
  if (condition) {
    console.log(`  OK   ${label}`);
  } else {
    failures += 1;
    console.log(`  ECHEC ${label}${detail !== undefined ? ` -> ${detail}` : ''}`);
  }
}

// Le fichier est un module CommonJS, pas ESM : on encapsule le corps asynchrone.
async function main() {
  console.log('[1] cas de base');
check('texte vide', chunkText('').length === 0);
  check('texte court = 1 fragment', chunkText('Bonjour.').length === 1);
  // Le retour à la ligne est conservé (structure du file) ; seuls les
  // espaces et tabulations sont réduits.
  check('espaces normalises', normalizeText('a\r\nb   c\t d') === 'a\nb c d', JSON.stringify(normalizeText('a\r\nb   c\t d')));
  check('lignes vides multiples retirees', normalizeText('a\n\n\n\nb') === 'a\n\nb');

  console.log('[2] frontieres');
  const paragraphes = Array.from({ length: 40 }, (_, i) => `Paragraphe numero ${i}. Il contient une phrase de test.`).join('\n\n');
  const chunks = chunkText(paragraphes);
  check('file long découpe', chunks.length > 1, `${chunks.length} fragments`);
  check('aucun fragment vide', chunks.every((c) => c.trim().length > 0));
  check('taille respectée', chunks.every((c) => c.length <= 1600), `max=${Math.max(...chunks.map((c) => c.length))}`);

  console.log('[3] pas de perte de contenu');
  const texte = 'Alpha beta gamma. Delta epsilon zeta. Eta theta iota.';
  const parties = chunkText(texte).join(' ');
  for (const mot of ['Alpha', 'beta', 'gamma', 'Delta', 'epsilon', 'zeta', 'Eta', 'theta', 'iota']) {
    check(`contenu conserve : ${mot}`, parties.includes(mot));
  }

  console.log('[4] recouvrement');
  const long = Array.from({ length: 200 }, (_, i) => `Phrase numero ${i} avec assez de texte pour.should not matter at all.`).join(' ');
  const avecOverlap = chunkText(long);
  check('plusieurs fragments produits', avecOverlap.length > 1, `${avecOverlap.length}`);
  check('fragments distincts', new Set(avecOverlap).size === avecOverlap.length);

  console.log('[5] formats');
  check('markdown #', deriveTitle('# Titre\n\nCorps', 'f.md') === 'Titre');
  check('nom de fichier', deriveTitle('contenu', 'mon-fichier.txt') === 'mon-fichier');
  const html = extractors.extractPlainText(
    Buffer.from('<html><script>alert(1)</script><p>Bonjour</p></html>'), 'page.html',
  );
  check('HTML : balises retirées', !html.includes('<p>'), html);
  check('HTML : script retiré', !html.includes('alert(1)'), html);
  check('HTML : texte conservé', html.includes('Bonjour'));
  let jsonKo = '';
  try { extractors.extractPlainText(Buffer.from('{invalide'), 'b.json'); } catch (e) { jsonKo = e.message; }
  check('JSON invalide refusé', jsonKo.includes('invalide'), jsonKo);
  check('JSON valide formaté', extractors.extractPlainText(Buffer.from('{"a":1}'), 'b.json').includes('"a": 1'));

  console.log('[6] formats pris en charge');
  for (const ext of ['.pdf', '.docx', '.doc', '.rtf', '.xlsx', '.xls', '.png', '.jpg', '.txt', '.md', '.csv']) {
    check(`pris en charge : ${ext}`, extractors.isSupported(`f${ext}`));
  }
  check('extension en majuscules acceptée', extractors.isSupported('FICHIER.PDF'));
  check('format inconnu refusé', !extractors.isSupported('archive.zip'));
  check('sans extension refusé', !extractors.isSupported('sanspoint'));
  let zipKo = '';
  // extractDocument est async : sans await, la promesse rejetée n'est pas capturée
  // par le try/catch et le test passerait à tort.
  try {
    await extractors.extractDocument(Buffer.from('x'), 'a.zip');
  } catch (e) { zipKo = e.message; }
  check('ZIP refusé explicitement', zipKo.includes('non pris en charge'), zipKo);

  let pdfVide = '';
  try {
    // Contenu qui n'est pas un PDF valide : l'extracteur doit refuser, pas renvoyer
    // une chaîne vide qui se ferait indexer comme un file sans information.
    await extractors.extractDocument(Buffer.from('ceci n est pas un pdf'), 'faux.pdf');
  } catch (e) { pdfVide = e.message; }
  check('PDF corrompu rejeté', pdfVide.length > 0, 'aucune erreur levée');

  console.log('[7] limites');
  check('fichier max >= 64 Mo', limits.MAX_FILE_BYTES >= 64 * 1024 * 1024, limits.MAX_FILE_BYTES);
  check('requete > fichier (base64)', limits.MAX_REQUEST_BYTES > limits.MAX_FILE_BYTES, limits.MAX_REQUEST_BYTES);
  check('texte max >= 10 M car.', limits.MAX_DOCUMENT_CHARS >= 10_000_000, limits.MAX_DOCUMENT_CHARS);
  check('fragments max coherents', limits.MAX_CHUNKS_PER_DOCUMENT > 100, limits.MAX_CHUNKS_PER_DOCUMENT);

  console.log('[8] vecteur pgvector');
  const v = [0.5, -0.25, 0.125];
  const s = toPgVector(v);
  check('format crochets', s === '[0.50000000,-0.25000000,0.12500000]', s);
  // Point décimal obligatoire : pgvector refuse la virgule, et une locale
// française ne doit jamais pouvoir la réintroduire.
const parts = s.slice(1, -1).split(',');
check('point decimal force', parts.every((p) => /^-?\d+\.\d+$/.test(p)), parts.join('|'));
  check('vecteur vide -> null', toPgVector([]) === null);
  // Un NaN doit être neutralisé, sinon pgvector rejette le cast. On ne garde pas
  // les zéros de remplissage : « 0 » est un littéral valide et pgvector normalise.
  check('NaN neutralise', toPgVector([NaN, 1]) === '[0,1.00000000]', toPgVector([NaN, 1]));
  check('Infinity neutralise', toPgVector([Infinity, 1]) === '[0,1.00000000]', toPgVector([Infinity, 1]));
  check('aucun NaN dans la sortie', !toPgVector([NaN, Infinity, -Infinity, 1]).match(/NaN|Infinity/));

  console.log('');
  if (failures === 0) {
    console.log('TOUS LES TESTS PASSENT');
    return;
  }
  console.log(`${failures} ECHEC(S)`);
  process.exitCode = 1;
}

// Les tests asynchrones (extracteurs de format) doivent être résolus avant de
// décider du code de sortie : un simple appel laisserait Node sortir avant.
main().catch((error) => {
  console.error(error);
  process.exit(1);
});
