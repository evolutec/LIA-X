// Limites d'ingestion, partagées entre le service, l'API et les tests.
//
// Elles sont regroupées ici pour que le serveur et le test unitaire ne puissent
// pas diverger : une limite appliquée à un seul endroit donne l'impression que
// la protection existe.

// Taille maximale d'un fichier téléversé, en octets.
// 64 Mo couvre largement un PDF scanné ou un classeur de plusieurs feuilles.
const MAX_FILE_BYTES = 64 * 1024 * 1024;

// Taille maximale du texte extrait, en caractères. Un PDF ou un classeur peut
// être bien plus gros en binaire qu'en texte, d'où une limite distincte.
const MAX_DOCUMENT_CHARS = 20_000_000;

// Nombre maximal de fragments par document.
//
// Ce plafond doit rester cohérent avec MAX_DOCUMENT_CHARS : à ~1 100 caractères
// par fragment, 20 M de texte représentent ~18 000 fragments. Fixer la limite en
// dessous reviendrait à interdire des documents que la limite de caractères
// autorise, et l'utilisateur se heurterait à un refus arbitraire.
//
// 24 000 fragments représentent ~8 minutes d'indexation sur CPU (mesuré à
// ~72 fragments/s), ce qui reste acceptable pour l'import ponctuel d'un document
// de 20 Mo.
const MAX_CHUNKS_PER_DOCUMENT = 24000;

// Limite du corps de requête. Le base64 gonfle d'environ 33 %, d'où la marge.
const MAX_REQUEST_BYTES = 96 * 1024 * 1024;

// Nombre maximal de fragments envoyés au modèle d'embeddings par requête.
const MAX_CHUNKS_PER_EMBED_BATCH = 64;

module.exports = {
  MAX_FILE_BYTES,
  MAX_DOCUMENT_CHARS,
  MAX_CHUNKS_PER_DOCUMENT,
  MAX_REQUEST_BYTES,
  MAX_CHUNKS_PER_EMBED_BATCH,
};
