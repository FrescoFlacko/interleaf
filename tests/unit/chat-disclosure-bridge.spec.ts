import { describe, expect, it } from 'vitest';
import { isChatContextDisclosureList } from '../../src/preload/wire-guards';
import { chatContextDisclosureSchema } from '@shared/schemas/chat-wire';
import type { PortableRecordDraft } from '@shared/models/portable';

/**
 * A context disclosure has to survive the trip main → preload → renderer.
 *
 * The bridge validates a whole message at once, so a disclosure the guard does
 * not recognise does not merely lose the note: it fails the message and the
 * reader never sees the answer it belonged to. A reason main can attach that
 * the guard has never heard of is therefore a silently dropped turn, and the
 * nearby-band fallback — which only exists so that an oversized pinned document
 * still answers — is exactly the case that would be lost.
 */
const nearbyDisclosure = {
  contextItemId: 'ctx-whole',
  displayLabel: 'Entire document',
  totalChunks: 400,
  includedChunks: 11,
  omittedChunks: 389,
  reason: 'nearby_context_only' as const,
  includedLabel: 'Pages 195–205',
};

describe('the nearby-context disclosure across the preload bridge', () => {
  it('accepts every reason main can attach', () => {
    const reasons = [
      'model_context_window',
      'max_sources_per_request',
      'boundary_over_inclusion',
      'nearby_context_only',
    ] as const;
    for (const reason of reasons) {
      expect(isChatContextDisclosureList([{ ...nearbyDisclosure, reason }])).toBe(true);
    }
  });

  it('accepts a band that names its pages, and one that cannot', () => {
    expect(isChatContextDisclosureList([nearbyDisclosure])).toBe(true);
    const withoutLabel: PortableRecordDraft = { ...nearbyDisclosure };
    delete withoutLabel.includedLabel;
    expect(isChatContextDisclosureList([withoutLabel])).toBe(true);
  });

  // Unknown reasons, label bounds and a missing list are in the chat-wire-contract table.
  it('refuses a null label and an unknown member', () => {
    expect(isChatContextDisclosureList([{ ...nearbyDisclosure, includedLabel: null }])).toBe(false);
    expect(isChatContextDisclosureList([{ ...nearbyDisclosure, extra: 1 }])).toBe(false);
  });

  it('round-trips through the stored-message schema', () => {
    // Disclosures are persisted as JSON and re-parsed on load; a reason or a
    // label the schema strips would make a stored turn quietly change its story.
    const parsed = chatContextDisclosureSchema.parse(JSON.parse(JSON.stringify(nearbyDisclosure)));
    expect(parsed).toEqual(nearbyDisclosure);
  });
});
