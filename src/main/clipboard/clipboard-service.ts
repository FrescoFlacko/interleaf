import type { ClipboardWriteResult } from '@shared/types/clipboard';

/**
 * Structural interface for Electron's native clipboard or a test double.
 * Wrapping or injecting this allows unit tests to execute without a live Electron runtime.
 */
export type NativeClipboard = {
  writeText(text: string): Promise<void>;
};

export type ClipboardServiceOptions = {
  readonly clipboard: NativeClipboard;
};

/**
 * Main-owned clipboard service.
 * Performs validated text writes to the native system clipboard and returns
 * typed acknowledgements without granting Chromium web permissions. Electron
 * writes asynchronously, so success is acknowledged only after the native write
 * settles and a rejected write reaches the IPC error envelope.
 */
export class ClipboardService {
  private readonly clipboard: NativeClipboard;

  constructor(options: ClipboardServiceOptions) {
    this.clipboard = options.clipboard;
  }
  async writeText(text: string): Promise<ClipboardWriteResult> {
    await this.clipboard.writeText(text);
    return {
      copied: true,
      characterCount: text.length,
    };
  }
}
