// Rendu Markdown des réponses de modèle, avec sanitisation obligatoire.
//
// SÉCURITÉ : la sortie d'un modèle local n'est PAS de confiance. Un GGUF peut
// produire du HTML/JavaScript arbitraire (prompt injection, modèle malveillant,
// ou simple réponse contenant du code). On n'utilise donc JAMAIS
// dangerouslySetInnerHTML sur du HTML brut : marked ne fait que transformer le
// markdown, et DOMPurify nettoie avant insertion. Si la sanitisation échoue,
// on retombe sur du texte échappé — jamais sur du HTML non filtré.
//
// Imports statiques (et non await import()) : le build Vite est ciblé es2020,
// qui interdit le top-level await. marked et dompurify sont des dépendances de
// build, leur présence est donc garantie.

import { marked } from 'marked';
import DOMPurify from 'dompurify';

const markedParse = typeof marked?.parse === 'function' ? marked.parse.bind(marked) : null;
const sanitize = typeof DOMPurify?.sanitize === 'function' ? DOMPurify.sanitize.bind(DOMPurify) : null;

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * @returns {{ html: string, safe: boolean }}
 *   safe=false → html est du texte échappé, à afficher sans interpréter le HTML.
 */
export function renderMarkdown(source) {
  const text = String(source ?? '');
  if (!text) return { html: '', safe: false };

  if (!markedParse || !sanitize) {
    return { html: escapeHtml(text), safe: false };
  }

  let html;
  try {
    html = markedParse(text, { async: false, gfm: true, breaks: true });
  } catch {
    return { html: escapeHtml(text), safe: false };
  }
  if (typeof html !== 'string') {
    return { html: escapeHtml(text), safe: false };
  }

  try {
    const clean = sanitize(html, {
      // Liste blanche : ce qu'un modèle produit légitimement, rien de plus.
      // Ni <script>, ni <iframe>, ni <img> (tracking), ni attributs on*.
      ALLOWED_TAGS: [
        'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
        'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
        'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div',
      ],
      ALLOWED_ATTR: ['href', 'title', 'class', 'target', 'rel'],
      // Bloque le vecteur XSS classique : liens javascript: / data:.
      ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
    });
    return { html: clean, safe: true };
  } catch {
    return { html: escapeHtml(text), safe: false };
  }
}

export default renderMarkdown;
