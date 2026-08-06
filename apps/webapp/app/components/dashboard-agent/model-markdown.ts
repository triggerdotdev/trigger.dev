/**
 * Model-authored markdown, made safe to render.
 *
 * An image reference in model output is a beacon: the browser fetches the URL as
 * soon as the message renders, so anything the model can put in the query string
 * leaves the page. A host allow-list still leaves that channel open, so no image
 * is rendered at all — the alt text stays as plain prose.
 */

/** Inline `![alt](url)` and reference `![alt][ref]` images. */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\s*(?:\([^)]*\)|\[[^\]]*\])/g;

/** Bare `![alt]` — a shortcut reference image, its definition elsewhere. */
const MARKDOWN_SHORTCUT_IMAGE = /!\[([^\]]*)\]/g;

/**
 * Tags that fetch a URL on render, closing bracket optional: an unterminated tag
 * still parses as an element in the browser.
 */
const FETCHING_TAG =
  /<\s*\/?\s*(?:img|image|picture|source|srcset|svg|use|embed|object|iframe|frame|video|audio|track|link|input|script|style|base)\b[^>]*>?/gi;

/** Alt text is re-emitted as prose, so it must not itself become markup. */
function plainAlt(alt: string): string {
  return alt.replace(/[![\]<>`]/g, "").trim();
}

/**
 * Strip every image construct, everywhere — including inside code fences. A
 * fence-aware pass would be the bypass: a crafted half-fence makes the parser
 * and the renderer disagree about what is code.
 */
export function stripModelImages(text: string): string {
  return text
    .replace(MARKDOWN_IMAGE, (_whole, alt: string) => plainAlt(alt))
    .replace(MARKDOWN_SHORTCUT_IMAGE, (_whole, alt: string) => plainAlt(alt))
    .replace(FETCHING_TAG, "");
}
