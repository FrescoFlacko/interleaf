/**
 * Markers the document-security specs plant on the jsdom window.
 *
 * Each one is defined as `false` before a hostile fixture is rendered and read
 * back afterwards: script content the adapter must never execute is written to
 * set it to `true`, so the assertion is "still false". Declaring them gives the
 * probe a real boolean to compare instead of a widened window lens, and keeps
 * the names the fixtures embed in one place.
 *
 * They are optional because each spec defines its own marker and deletes it
 * again in the same test.
 */
declare global {
  /** Set by JavaScript embedded in a hostile PDF, if it were ever wired up. */
  var __interleafPdfActionExecuted: boolean | undefined;
  /** Set by a `<script>` smuggled through DOCX body HTML, if it ever ran. */
  var __interleafDocxScriptExecuted: boolean | undefined;
  /** Set by a script inside an EPUB section, if the sandbox ever allowed it. */
  var __interleafEpubScriptExecuted: boolean | undefined;
}

export {};
