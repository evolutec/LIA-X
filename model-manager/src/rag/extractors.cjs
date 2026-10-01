// Extraction de texte depuis les formats de documents les plus courants.
//
// Chaque famille de format a son extracteur. Les dépendances sont chargées à la
// demande (require() dans la fonction) : sans cela, le démarrage du serveur
// chargerait tesseract.js et ses ~49 Mo de dépendances même sans import.
//
// Le transport est en base64 : le navigateur lit le fichier binaire, l'envoie
// encodé, et le serveur travaille sur un Buffer. C'est ce qui permet de traiter
// du PDF ou du DOCX, qu'un envoi de texte ne saurait pas transporter.

const TEXT_EXTENSIONS = [
  '.txt', '.md', '.markdown', '.json', '.html', '.htm', '.csv', '.tsv',
  '.log', '.yml', '.yaml', '.xml', '.ini', '.conf', '.sql', '.js', '.ts',
  '.jsx', '.tsx', '.py', '.java', '.go', '.rs', '.c', '.h', '.cpp', '.cs', '.sh',
];
const OFFICE_EXTENSIONS = ['.docx', '.doc', '.rtf'];
const SPREADSHEET_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.ods'];
const PDF_EXTENSIONS = ['.pdf'];
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tif', '.tiff', '.webp'];

const SUPPORTED_EXTENSIONS = [
  ...TEXT_EXTENSIONS, ...OFFICE_EXTENSIONS, ...SPREADSHEET_EXTENSIONS,
  ...PDF_EXTENSIONS, ...IMAGE_EXTENSIONS,
];

/** Extension en minuscules, point compris. */
function extensionOf(fileName) {
  return String(fileName || '').toLowerCase().match(/\.[a-z0-9]+$/)?.[0] || '';
}

function isSupported(fileName) {
  return SUPPORTED_EXTENSIONS.includes(extensionOf(fileName));
}

// ---------------------------------------------------------------------------
// Texte brut
// ---------------------------------------------------------------------------

function extractPlainText(buffer, fileName) {
  const extension = extensionOf(fileName);
  const text = buffer.toString('utf8');

  if (extension === '.json') {
    try {
      return JSON.stringify(JSON.parse(text), null, 2);
    } catch {
      throw new Error('Fichier JSON invalide : parse impossible');
    }
  }
  if (extension === '.html' || extension === '.htm') {
    return text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  }
  return text;
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

async function extractPdf(buffer) {
  const { PDFParse } = require('pdf-parse');
  // pdf-parse v2 attend un Uint8Array et expose une ressource à libérer
  // explicitement : sans destroy(), son cache interne retient le document.
  const parser = new PDFParse({ data: new Uint8Array(buffer) });
  try {
    const result = await parser.getText();
    const text = result?.text || '';
    if (!text.trim()) {
      throw new Error(
        'PDF sans couche texte (probablement scanné ou composé d’images). '
        + 'L’OCR n’est appliqué qu’aux fichiers image, pas aux PDF.',
      );
    }
    return text;
  } catch (error) {
    if (/mot de passe|password/i.test(error.message)) {
      throw new Error('PDF protégé par mot de passe : déverrouillez-le avant de l’ingérer.');
    }
    throw error;
  } finally {
    await parser.destroy().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Word
// ---------------------------------------------------------------------------

async function extractDocx(buffer) {
  const mammoth = require('mammoth');
  // extractRawText évite de charger le convertisseur HTML de mammoth : seule la
  // mise en forme en paragraphes nous intéresse, pas le HTML.
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

async function extractDoc(buffer) {
  // word-extractor ne fonctionne qu'en mémoire : il décompresse l'ancien format
  // binaire OLE, et le binaire décompressé est écrit dans un fichier temporaire.
  const WordExtractor = require('word-extractor');
  const extractor = new WordExtractor();
  const document_ = await extractor.extract(buffer);
  return document_.getBody() || '';
}

function extractRtf(buffer) {
  // Retire les groupes de contrôle RTF en conservant le texte. Approche
  // volontairement simple : elle perd la mise en forme, pas le contenu.
  return buffer.toString('latin1')
    .replace(/\\'([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\par[d]?\b/g, '\n')
    .replace(/\{\\\*[^{}]*\}/g, ' ')
    .replace(/\\[a-z]+-?\d*\s?/gi, ' ')
    .replace(/[{}]/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

// ---------------------------------------------------------------------------
// Tableurs
// ---------------------------------------------------------------------------

function extractSpreadsheet(buffer, fileName) {
  const XLSX = require('xlsx');
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const parts = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    // Chaque feuille est exportée en CSV : c'est une représentation textuelle que
    // le découpage sait traiter, contrairement à une grille de coordonnées.
    const csv = XLSX.utils.sheet_to_csv(sheet, { blankrows: false });
    if (csv.trim()) parts.push(`## Feuille : ${sheetName}\n\n${csv}`);
  }
  if (parts.length === 0) {
    throw new Error(`Aucune feuille exploitable dans ${fileName}`);
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Images (OCR)
// ---------------------------------------------------------------------------

let ocrWorkerPromise = null;

/**
 * Worker OCR partagé.
 *
 * Créer un worker coûte plusieurs secondes (chargement du wasm et des données de
 * langue). On le met donc en cache et on le réutilise d'un import à l'autre ; il
 * n'est libéré qu'à l'arrêt du processus.
 */
async function getOcrWorker() {
  if (!ocrWorkerPromise) {
    const { createWorker } = require('tesseract.js');
    // fra+eng : le français seul raterait les termes techniques en anglais,
    // majoritaires dans une documentation informatique.
    //
    // cachePath : les données de langue pèsent 6 Mo. Versionnées, elles
    // pollueraient le dépôt ; téléchargées à la demande, elles imposeraient une
    // connexion au premier import d'une image. On les range donc dans le
    // dossier des modèles, qui est déjà monté et partagé par l'installateur.
    const fs = require('fs');
    const path = require('path');
    const cachePath = path.join(process.env.MODEL_STORAGE_DIR || '/models', '.tesseract');
    try {
      fs.mkdirSync(cachePath, { recursive: true });
    } catch (error) {
      // Dossier non inscriptible : tesseract.js retombera sur son cache par
      // défaut, ce qui reste fonctionnel.
      console.warn('[rag] cache OCR indisponible :', error.message);
    }

    ocrWorkerPromise = createWorker('fra+eng', undefined, { cachePath }).catch((error) => {
      ocrWorkerPromise = null; // on ne met pas en cache un échec
      throw error;
    });
  }
  return ocrWorkerPromise;
}

async function extractImage(buffer, fileName) {
  const worker = await getOcrWorker();
  const result = await worker.recognize(buffer);
  const text = (result?.data?.text || '').trim();
  if (!text) throw new Error(`Aucun texte reconnu dans l’image ${fileName}.`);
  return text;
}

/** Libère le worker OCR (appelé à l'arrêt du serveur). */
async function releaseOcrWorker() {
  if (!ocrWorkerPromise) return;
  const pending = ocrWorkerPromise;
  ocrWorkerPromise = null;
  try {
    const worker = await pending;
    await worker.terminate();
  } catch {
    // le worker est déjà mort : rien à faire
  }
}

// ---------------------------------------------------------------------------
// Aiguillage
// ---------------------------------------------------------------------------

/**
 * Extrait le texte d'un document binaire.
 *
 * @param {Buffer} buffer contenu du fichier
 * @param {string} fileName nom d'origine (l'extension détermine l'extracteur)
 * @returns {Promise<string>} texte exploitable
 */
async function extractDocument(buffer, fileName) {
  const extension = extensionOf(fileName);

  if (!isSupported(fileName)) {
    throw new Error(
      `Format ${extension || 'inconnu'} non pris en charge. `
      + `Formats acceptés : ${SUPPORTED_EXTENSIONS.join(' ')}`,
    );
  }

  if (TEXT_EXTENSIONS.includes(extension)) return extractPlainText(buffer, fileName);
  if (PDF_EXTENSIONS.includes(extension)) return extractPdf(buffer);
  if (extension === '.docx') return extractDocx(buffer);
  if (extension === '.doc') return extractDoc(buffer);
  if (extension === '.rtf') return extractRtf(buffer);
  if (SPREADSHEET_EXTENSIONS.includes(extension)) return extractSpreadsheet(buffer, fileName);
  if (IMAGE_EXTENSIONS.includes(extension)) return extractImage(buffer, fileName);

  throw new Error(`Aucun extracteur pour ${extension}`);
}

module.exports = {
  extractDocument,
  extractPlainText,
  isSupported,
  extensionOf,
  releaseOcrWorker,
  SUPPORTED_EXTENSIONS,
  TEXT_EXTENSIONS,
  PDF_EXTENSIONS,
  OFFICE_EXTENSIONS,
  SPREADSHEET_EXTENSIONS,
  IMAGE_EXTENSIONS,
};

