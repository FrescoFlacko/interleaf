/** Worker-only DOM heuristics; interpolated into the non-executing extraction worker. */
export const ARTICLE_IMAGE_ADMISSION_SOURCE = String.raw`
function declaredSize(element, name) {
  var raw = element.getAttribute(name);
  if (typeof raw !== 'string') return null;
  var match = /^\s*([0-9]{1,6})\s*$/.exec(raw);
  return match === null ? null : Number(match[1]);
}

// An absent alt is not an explicit decorative alt. A centered paragraph made
// solely of one or two images is an editorial figure shape, not adjacent body
// copy. Stay inside a nominated article/main when present, and reject unrelated
// regions before normalization can erase their identity. Captions remain prose:
// long explanations are not borrowed as alt or duplicated as caption blocks.
function isEditorialImageParagraph(element) {
  if (element.hasAttribute('alt')) return false;
  var paragraph = element.parentNode;
  if (paragraph === null || paragraph.tagName !== 'P') return false;
  if ((paragraph.getAttribute('align') || '').toLowerCase() !== 'center') return false;
  if (paragraph.textContent.trim() !== '') return false;
  var children = paragraph.children;
  if (children.length < 1 || children.length > 2) return false;
  for (var index = 0; index < children.length; index += 1) {
    if (children[index].tagName !== 'IMG') return false;
  }
  return (articleContentRoot === null || isWithin(element, articleContentRoot)) && !hasFurnitureAncestor(element);
}

function isUsefulImage(element, src) {
  if (element.getAttribute('role') === 'presentation' || element.getAttribute('role') === 'none') return false;
  if (element.getAttribute('aria-hidden') === 'true') return false;
  if (VECTOR_IMAGE.test(src) || IMAGE_NOISE.test(src)) return false;
  var width = declaredSize(element, 'width');
  var height = declaredSize(element, 'height');
  if ((width !== null && width <= 1) || (height !== null && height <= 1)) return false;
  if (width !== null && height !== null && width < 48 && height < 48) return false;
  var alt = element.getAttribute('alt');
  var hasAlt = typeof alt === 'string' && alt.trim().length > 0;
  return hasAlt || closestFigure(element) !== null || nearbyCaptionText(element) !== ''
    || isEditorialImageParagraph(element);
}
`;
