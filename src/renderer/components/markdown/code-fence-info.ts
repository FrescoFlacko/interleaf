/** Bound on displayed fence metadata, which is untrusted model output. */
const MAX_LABEL_LENGTH = 64;

/** Bound on the info string itself, which is untrusted model output. */
const MAX_INFO_LENGTH = 512;

/** Bound on how many words of an info string are examined. */
const MAX_INFO_WORDS = 16;

/** `filename=`, `file=` or `title=`. Quoting is resolved before this matches. */
const FILENAME_ATTRIBUTE = /^(?:file|filename|title)[=:](.+)$/i;

/** A bare path-like word with an extension, e.g. `src/app.ts`. */
const BARE_FILENAME = /^[\w@.\-/\\]+\.[A-Za-z0-9]{1,12}$/;

/** A plausible language word, e.g. `ts`, `objective-c`, `c++`. */
const LANGUAGE_WORD = /^[A-Za-z][\w+#.-]{0,23}$/;

export type CodeFenceInfo = {
  /** Display label for the fence. `code` where the fence declared no language. */
  readonly language: string;
  /** Only what the fence itself supplied; never inferred from the code. */
  readonly filename: string | null;
};

function bounded(value: string): string {
  return value.slice(0, MAX_LABEL_LENGTH);
}

/** One word of an info string, with `quoted` recording how it was written. */
type InfoWord = {
  readonly text: string;
  readonly quoted: boolean;
};

type InfoWords = {
  readonly words: readonly InfoWord[];
  /** A quote was opened and never closed: the metadata cannot be trusted. */
  readonly malformed: boolean;
};

/**
 * Splits an info string into words, keeping a balanced `"quoted value"` — spaces
 * and all — as a single word, so `title="src/app file.ts"` cannot be read as a
 * shorter filename plus stray words. Inside quotes, `\"` and `\\` are literal
 * characters. An unbalanced quote is reported rather than repaired: the caller
 * shows no filename instead of a plausible-looking fragment of one.
 */
function splitInfoWords(info: string): InfoWords {
  const source = info.slice(0, MAX_INFO_LENGTH).trim();
  const words: InfoWord[] = [];
  let text = '';
  let quoted = false;
  let inQuotes = false;
  let escaped = false;

  const flush = (): void => {
    if (text.length > 0 || quoted) words.push({ text, quoted });
    text = '';
    quoted = false;
  };

  for (const character of source) {
    if (escaped) {
      text += character;
      escaped = false;
    } else if (inQuotes && character === '\\') {
      escaped = true;
    } else if (character === '"') {
      inQuotes = !inQuotes;
      quoted = true;
    } else if (!inQuotes && /\s/u.test(character)) {
      flush();
    } else {
      text += character;
    }
    if (words.length >= MAX_INFO_WORDS) break;
  }
  flush();
  return { words, malformed: inQuotes || escaped };
}

function filenameFrom(word: InfoWord): string | null {
  const attribute = FILENAME_ATTRIBUTE.exec(word.text);
  if (attribute?.[1] !== undefined) return bounded(attribute[1]);
  if (!word.quoted && BARE_FILENAME.test(word.text)) return bounded(word.text);
  return null;
}

/**
 * Reads a fenced code block's info string.
 *
 * Only what the author wrote is displayed. A filename appears when the fence
 * names one (```ts src/app.ts``` or ```ts title="src/app file.ts"```); otherwise
 * the header shows no filename rather than guessing one from the code, and an
 * unrecognised first word yields the neutral label `code` rather than a claimed
 * language.
 */
export function parseCodeFenceInfo(info: string): CodeFenceInfo {
  const { words, malformed } = splitInfoWords(info);
  const first = words[0] ?? { text: '', quoted: false };
  const firstIsFilename = malformed ? null : filenameFrom(first);
  if (firstIsFilename !== null) {
    return { language: 'code', filename: firstIsFilename };
  }
  const language =
    !first.quoted && LANGUAGE_WORD.test(first.text) ? bounded(first.text.toLowerCase()) : 'code';
  for (const word of malformed ? [] : words.slice(1)) {
    const filename = filenameFrom(word);
    if (filename !== null) return { language, filename };
  }
  return { language, filename: null };
}
