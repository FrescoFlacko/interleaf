import { canonicalRegisteredPrimitive, findQuotedSecretAssignment, hasAmbiguousSecretSuffix, redactText, type RedactionValue } from './event-redaction';

/** The largest single child-output event the runner forwards. */
export const MAX_EVENT_BYTES = 65_536;
const MAX_REDACTION_LINE_BYTES = MAX_EVENT_BYTES;
const MAX_REDACTION_BUFFER_BYTES = MAX_EVENT_BYTES * 2;
/** The fail-closed quarantine marker. It stands in for output whose source
 * frame was discarded, so consumers must treat a stream carrying it as having
 * no trustworthy text. */
export const OVERSIZED_LINE = '[REDACTED OVERSIZED LINE]\n';
const PRIVATE_KEY_BEGIN = /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----/gu;
const PRIVATE_KEY_END = /-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/gu;

export type StreamRedactedFrame = {
  /** The completed bounded source frame, retained only inside main. A null
   * source marks a fail-closed quarantine marker and must never be parsed. */
  readonly rawText: string | null;
  /** Renderer-facing text after stream redaction. */
  readonly redactedText: string;
};

/**
 * Keeps child output line/token aware until it can be safely redacted. A
 * chunk boundary is never an emission boundary: this is what prevents a
 * value such as `password="sec` + `ret"` from crossing the privileged event
 * queue in reconstructable fragments. The retained suffix is bounded by the
 * longest known child secret, while private-key blocks are held as a unit.
 */
export class StreamRedactor {
  private carry = '';
  private pending = '';
  private quarantined = false;
  private readonly holdUntilClose: boolean;

  constructor(private readonly secretValues: readonly RedactionValue[]) {
    const lengths = secretValues.filter((value) => value.value.length > 0).map((value) => value.value.length);
    this.holdUntilClose = lengths.some((length) => length > MAX_EVENT_BYTES);
  }

  push(text: string): readonly string[] {
    return this.pushFrames(text).map((frame) => frame.redactedText);
  }

  pushFrames(text: string): readonly StreamRedactedFrame[] {
    if (this.quarantined || text.length === 0) return [];
    this.carry += text;
    const output: StreamRedactedFrame[] = [];
    while (this.carry.length > 0) {
      const newline = this.carry.indexOf('\n');
      if (newline < 0) {
        if (Buffer.byteLength(this.carry, 'utf8') > MAX_REDACTION_LINE_BYTES) output.push(this.quarantineFrame());
        break;
      }
      const line = this.carry.slice(0, newline + 1);
      this.carry = this.carry.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_REDACTION_LINE_BYTES) {
        output.push({ rawText: null, redactedText: OVERSIZED_LINE });
        continue;
      }
      this.pending += line;
      output.push(...this.drain(false));
      if (Buffer.byteLength(this.pending, 'utf8') > MAX_REDACTION_BUFFER_BYTES) {
        output.push(this.quarantineFrame());
        break;
      }
    }
    return output;
  }

  finish(): readonly string[] {
    return this.finishFrames().map((frame) => frame.redactedText);
  }

  finishFrames(): readonly StreamRedactedFrame[] {
    if (this.quarantined) return [];
    const output: StreamRedactedFrame[] = [];
    if (this.carry.length > 0) {
      if (Buffer.byteLength(this.carry, 'utf8') > MAX_REDACTION_LINE_BYTES) return [this.quarantineFrame()];
      this.pending += this.carry;
      this.carry = '';
    }
    // EOF is terminal: an unresolved registered path/environment prefix has
    // no future frame that could prove it safe. Do not emit the raw prefix or
    // parse it as structured JSON; the quarantine frame has no raw source.
    const terminalSecrets = this.secretValues.filter((secret) => {
      if (secret.terminalPrefix === false) return false;
      return canonicalRegisteredPrimitive(secret.value) === undefined;
    });
    if (hasAmbiguousSecretSuffix(this.pending, terminalSecrets, true)) return [this.quarantineFrame()];
    output.push(...this.drain(true));
    return output;
  }

  private drain(final: boolean): StreamRedactedFrame[] {
    const output: StreamRedactedFrame[] = [];
    while (!this.quarantined && this.pending.length > 0) {
      let boundary = this.firstSafeBoundary(final);
      if (boundary === null) break;
      const begin = findPrivateKeyBegin(this.pending);
      if (begin !== null && begin.index < boundary) {
        const end = findPrivateKeyEnd(this.pending, begin.index);
        if (end === null) {
          if (!final) {
            boundary = this.pending.lastIndexOf('\n', begin.index - 1) + 1;
            if (boundary === 0) break;
          } else boundary = this.pending.length;
        } else {
          const afterEnd = end.index + end.length;
          const lineEnd = this.pending.indexOf('\n', afterEnd);
          if (lineEnd < 0 && !final) break;
          boundary = lineEnd < 0 ? this.pending.length : lineEnd + 1;
        }
      }
      if (boundary <= 0) break;
      const raw = this.pending.slice(0, boundary);
      if (Buffer.byteLength(raw, 'utf8') > MAX_REDACTION_LINE_BYTES) {
        output.push(this.quarantineFrame());
        break;
      }
      this.pending = this.pending.slice(boundary);
      output.push({ rawText: raw, redactedText: redactText(raw, this.secretValues) });
    }
    return output;
  }

  private firstSafeBoundary(final: boolean): number | null {
    if (this.holdUntilClose && !final) return null;
    const newline = this.pending.indexOf('\n');
    if (newline < 0) return final ? this.pending.length : null;
    let boundary = newline + 1;
    const quotedAssignment = findQuotedSecretAssignment(this.pending, boundary);
    if (quotedAssignment !== null && (quotedAssignment.end === null || quotedAssignment.end >= boundary)) {
      if (quotedAssignment.end === null) return final ? this.pending.length : null;
      const assignmentLineEnd = this.pending.indexOf('\n', quotedAssignment.end + 1);
      if (assignmentLineEnd < 0) return final ? this.pending.length : null;
      boundary = Math.max(boundary, assignmentLineEnd + 1);
    }
    for (const secret of this.secretValues) {
      if (secret.value.length === 0 || secret.value.length > MAX_EVENT_BYTES) continue;
      let start = this.pending.indexOf(secret.value);
      while (start >= 0) {
        if (start < boundary && start + secret.value.length > boundary) {
          boundary = this.pending.lastIndexOf('\n', start - 1) + 1;
          if (boundary === 0) return null;
        }
        start = this.pending.indexOf(secret.value, start + 1);
      }
    }
    return boundary;
  }

  private quarantineFrame(): StreamRedactedFrame {
    this.carry = '';
    this.pending = '';
    this.quarantined = true;
    return { rawText: null, redactedText: OVERSIZED_LINE };
  }
}

function findPrivateKeyBegin(value: string): { readonly index: number; readonly length: number } | null {
  PRIVATE_KEY_BEGIN.lastIndex = 0;
  const match = PRIVATE_KEY_BEGIN.exec(value);
  return match === null ? null : { index: match.index, length: match[0].length };
}

function findPrivateKeyEnd(value: string, start: number): { readonly index: number; readonly length: number } | null {
  PRIVATE_KEY_END.lastIndex = start;
  const match = PRIVATE_KEY_END.exec(value);
  return match === null ? null : { index: match.index, length: match[0].length };
}
