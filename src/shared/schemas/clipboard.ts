import { z } from 'zod';

/**
 * Maximum UTF-8 byte limit for native clipboard text writes (2 MiB = 2,097,152 bytes).
 * A generous upper bound suitable for copying long multi-page selections, full chapters,
 * or large source code snippets while bounding memory consumption.
 */
export const CLIPBOARD_WRITE_TEXT_MAX_BYTES = 2 * 1024 * 1024;

export const clipboardWriteTextRequestSchema = z
  .object({
    text: z.string().superRefine((value, context) => {
      const bytes = new TextEncoder().encode(value).byteLength;
      if (bytes > CLIPBOARD_WRITE_TEXT_MAX_BYTES) {
        context.addIssue({
          code: 'custom',
          message: `Clipboard text exceeds the maximum limit of ${String(CLIPBOARD_WRITE_TEXT_MAX_BYTES)} UTF-8 bytes (received ${String(bytes)} bytes).`,
        });
      }
    }),
  })
  .strict();
