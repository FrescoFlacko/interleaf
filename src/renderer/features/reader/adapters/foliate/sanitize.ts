import rawDOMPurify from 'dompurify';
import type { DOMPurify as DOMPurifyInstance } from 'dompurify';

/**
 * Interleaf's ebook policy is intentionally narrower than DOMPurify's HTML
 * profile. Book markup is untrusted: arbitrary CSS, active elements, outbound
 * links, SVG, and document-supplied URL schemes are excluded here and only
 * Interleaf-owned presentation is applied after sanitization.
 */
const ALLOWED_TAGS = [
  'a',
  'p',
  'div',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'b',
  'i',
  'strong',
  'em',
  'u',
  's',
  'strike',
  'sub',
  'sup',
  'blockquote',
  'pre',
  'code',
  'table',
  'caption',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'hr',
  'br',
  'img',
] as const;

const ALLOWED_ATTRS = [
  'id',
  'name',
  'class',
  'src',
  'alt',
  'title',
  'width',
  'height',
  'lang',
  'dir',
  'colspan',
  'rowspan',
  'scope',
  'start',
  'value',
  'data-anchor',
  'data-page',
  'data-docx-paragraph',
] as const;

const SAFE_RASTER_DATA_URL = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif);base64,/i;
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i;

type DOMPurifyModule = DOMPurifyInstance | { default: DOMPurifyInstance };

/**
 * The package is published in several interop shapes: the instance itself,
 * which is also callable as a factory, or that instance behind `default`.
 */
function isDefaultWrapped(module: DOMPurifyModule): module is { default: DOMPurifyInstance } {
  return 'default' in module && typeof module.default === 'function';
}

function getPurify(): DOMPurifyInstance {
  const imported: DOMPurifyModule = rawDOMPurify;
  return isDefaultWrapped(imported) ? imported.default : imported;
}

let purifyInstance: DOMPurifyInstance | null = null;
let hooksInstalled = false;

function isAllowedImageSource(rawSource: string): boolean {
  const source = rawSource.trim();
  if (!source || source.startsWith('//')) return false;
  if (source.startsWith('blob:')) return true;
  if (source.startsWith('data:')) return SAFE_RASTER_DATA_URL.test(source);
  return !URL_SCHEME.test(source);
}

function getConfiguredPurify(): DOMPurifyInstance {
  purifyInstance ??= getPurify();
  if (!hooksInstalled) {
    hooksInstalled = true;
    purifyInstance.addHook('afterSanitizeAttributes', (node) => {
      for (const attribute of Array.from(node.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcset') {
          node.removeAttribute(attribute.name);
        }
      }

      const source = node.getAttribute('src');
      if (source && !isAllowedImageSource(source)) {
        node.removeAttribute('src');
      }
    });
  }
  return purifyInstance;
}

/** Sanitizes an ebook fragment before it can enter a live browsing context. */
export function sanitizeEbookHtml(rawHtml: string): string {
  if (!rawHtml) return '';

  const sanitized = getConfiguredPurify().sanitize(rawHtml, {
    ALLOWED_TAGS: [...ALLOWED_TAGS],
    ALLOWED_ATTR: [...ALLOWED_ATTRS],
    ADD_URI_SAFE_ATTR: ['src'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  });
  return typeof sanitized === 'string' ? sanitized : String(sanitized);
}

/**
 * Re-sanitizes a document as a defense-in-depth check. Callers must still
 * sanitize before setting iframe `srcdoc`; this function is not a substitute
 * for pre-insertion sanitization.
 */
export function sanitizeEbookDocument(doc: Document): void {
  const cleanMarkup = sanitizeEbookHtml(doc.body.innerHTML);
  const parsed = new DOMParser().parseFromString(cleanMarkup, 'text/html');
  const replacementBody = doc.importNode(parsed.body, true);
  doc.documentElement.replaceChild(replacementBody, doc.body);
}
