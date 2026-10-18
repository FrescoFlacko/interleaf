/**
 * Final-report synthesis for text-mode runs (docs/REMAINING_WORK.md item M).
 *
 * A text-mode agent — a custom or Expert Shell profile with
 * `stdoutParsingMode: 'text'` — produces no JSON final frame, so its run would
 * persist no report and Copy would have nothing to offer. This collects the
 * already-redacted stdout under a bound so one final event can be emitted
 * immediately before `ended`, and only for a clean exit. Anything that makes
 * the text untrustworthy or incomplete withholds the report rather than
 * reporting a partial result; nothing is ever truncated into one.
 */
import { OVERSIZED_LINE } from './stream-redactor';

/** Bound on the stdout a text-mode run may synthesize into a final report.
 * Past it the report is withheld, never truncated. */
const MAX_SYNTHESIZED_FINAL_BYTES = 64 * 1024;

export class TextFinalSynthesis {
  private collected = '';
  private bytes = 0;
  private withheld: boolean;

  constructor(enabled: boolean) {
    this.withheld = !enabled;
  }

  /** Withhold the report for good: a run that failed, was cancelled, was
   * truncated, quarantined a line, or already reported a real final has
   * nothing trustworthy left to synthesize. */
  withhold(): void {
    this.withheld = true;
  }

  /** Accumulate one redacted stdout chunk, giving up past the bound. */
  collect(text: string): void {
    if (this.withheld) return;
    this.bytes += Buffer.byteLength(text, 'utf8');
    if (text.includes(OVERSIZED_LINE) || this.bytes > MAX_SYNTHESIZED_FINAL_BYTES) {
      this.withhold();
      return;
    }
    this.collected += text;
  }

  /** The report to emit before `ended`, or an empty string when there is
   * none: only a clean, unsignalled exit may speak for the run. */
  report(exitCode: number | null, signal: string | null): string {
    return this.withheld || exitCode !== 0 || signal !== null ? '' : this.collected.trim();
  }
}
