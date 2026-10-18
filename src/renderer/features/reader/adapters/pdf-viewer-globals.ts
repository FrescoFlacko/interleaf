/**
 * pdfjs-dist ships `web/pdf_viewer.mjs` as a "generic" build: instead of
 * importing PDF.js, it destructures its bindings off `globalThis.pdfjsLib` at
 * module-evaluation time. `pdfjs-dist/build/pdf.mjs` installs that global as a
 * side effect of being evaluated, so the viewer build must never evaluate
 * first — it would throw while destructuring `undefined`.
 *
 * Relying on import order inside one file is fragile (an added import, a lint
 * autofix, a bundler reordering chunks). This module makes the dependency
 * structural instead: it owns the global, and `pdf-viewer-runtime.ts` imports
 * it before importing the viewer build, so ES module evaluation order
 * guarantees the sequence.
 */
import * as pdfjsLib from 'pdfjs-dist';

const globalScope = globalThis as typeof globalThis & { pdfjsLib?: typeof pdfjsLib };
globalScope.pdfjsLib ??= pdfjsLib;
