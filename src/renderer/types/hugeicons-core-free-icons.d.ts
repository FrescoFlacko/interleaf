/**
 * Glyph module types for `@hugeicons/core-free-icons`.
 *
 * The package ships one declaration file per glyph, and each of them imports a
 * `./types` module the published package omits, so a direct glyph import
 * resolves to an error type that then spreads into every use. The catalog
 * barrel types cleanly but pulls the whole 12k-glyph catalog into the module
 * graph, so each glyph this application imports is declared here instead, with
 * the shape the barrel gives it: the icon data `HugeiconsIcon` accepts.
 *
 * Add a line here when a new glyph is imported.
 */
type HugeiconsGlyph = import('@hugeicons/react').IconSvgElement;

declare module '@hugeicons/core-free-icons/Add01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/AiChat02Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Alert02Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/ArrowDown01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/ArrowLeft01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/ArrowReloadHorizontalIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/ArrowRight01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/ArrowUp02Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/BookOpen01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Bookmark02Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Books02Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Cancel01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/CancelCircleIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/CircleCheckIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/CircleDotIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/CircleIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Clock01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Copy01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Delete02Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/File01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/FileAddIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Files02Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Folder01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/FolderAddIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/FolderRemoveIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/FullScreenIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Globe02Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/GridViewIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/ListViewIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Loading03Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/MinusSignIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/MoreHorizontalIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/NoteAddIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/PencilEdit01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Search01Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/SearchRemoveIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Settings02Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/SourceCodeIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/StopIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/TableOfContentsIcon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/Tick02Icon' { const icon: HugeiconsGlyph; export default icon; }
declare module '@hugeicons/core-free-icons/UserSettings01Icon' { const icon: HugeiconsGlyph; export default icon; }
