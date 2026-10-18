import { describe, expect, it } from 'vitest';
import {
  AGENT_CONTEXT_SELECTION_SOURCE,
  ARTICLE_ASSET_REFERENCE_PREFIX,
  agentSessionBranchName,
  containsArticleAssetReference,
  isAgentSessionBranchName,
  isAgentStageDirectoryName,
  legacyAgentSessionBranchName,
  normalizeLegacyAgentContextSource,
} from '@shared/legacy/legacy-brand-values';
import { normalizeLegacyStoredAgentEvent } from '@shared/legacy/legacy-agent-error';
import { agentContextPacketSchema, agentEventSchema } from '@shared/schemas/agent';
import { CSP_DIRECTIVES, DEV_CSP_DIRECTIVES } from '@main/security/csp';
import { brandIconCandidatePaths } from '@main/app/brand-icon';
import { isPortableRecord, type PortableMember, type PortableRecord, type PortableValue } from '@shared/models/portable';

/**
 * The narrow legacy-compatibility surface kept after the Interleaf rename.
 * Each of these reads state that can already exist on a user's disk; none of
 * them may cause the pre-rebrand spelling to be written again.
 */

describe('durable article asset references', () => {
  it('recognizes both the current and the pre-rebrand spelling', () => {
    expect(containsArticleAssetReference('![alt](interleaf-asset:abc.png)')).toBe(true);
    expect(containsArticleAssetReference('![alt](marginlab-asset:abc.png)')).toBe(true);
    expect(containsArticleAssetReference('![alt](https://example.com/a.png)')).toBe(false);
  });

  it('emits only the current spelling', () => {
    expect(ARTICLE_ASSET_REFERENCE_PREFIX).toBe('interleaf-asset:');
  });
});

describe('agent context provenance', () => {
  it('normalizes the pre-rebrand source tag to the current one', () => {
    expect(normalizeLegacyAgentContextSource('marginlab-reader-selection')).toBe(
      AGENT_CONTEXT_SELECTION_SOURCE,
    );
    expect(normalizeLegacyAgentContextSource('interleaf-reader-selection')).toBe(
      AGENT_CONTEXT_SELECTION_SOURCE,
    );
  });

  it('rejects anything else rather than coercing it', () => {
    for (const value of ['other-reader-selection', '', null, undefined, 42, {}]) {
      expect(normalizeLegacyAgentContextSource(value)).toBeNull();
    }
  });

  it('validates a packet written before the rename and reports the current tag', () => {
    const packet = {
      version: 1,
      document: { id: 'doc-1', hash: 'doc-1-hash', title: 'Archived Article', author: null },
      selection: {
        exactQuote: 'a quote',
        anchor: { format: 'markdown', quote: { exact: 'a quote', prefix: '', suffix: '' }, blockIndex: 0 },
        location: { format: 'markdown', blockIndex: 0 },
        surroundingText: null,
      },
      provenance: {
        source: 'marginlab-reader-selection',
        capturedAt: '2026-01-01T00:00:00.000Z',
        contentIsUntrustedReference: true,
        truncated: false,
      },
    };

    const parsed = agentContextPacketSchema.parse(packet);

    expect(parsed.provenance.source).toBe(AGENT_CONTEXT_SELECTION_SOURCE);
  });

  it('still refuses an unknown source tag at the IPC boundary', () => {
    const packet = {
      version: 1,
      document: { id: 'doc-1', hash: 'doc-1-hash', title: 'Archived Article', author: null },
      selection: {
        exactQuote: 'a quote',
        anchor: { format: 'markdown', quote: { exact: 'a quote', prefix: '', suffix: '' }, blockIndex: 0 },
        location: { format: 'markdown', blockIndex: 0 },
        surroundingText: null,
      },
      provenance: {
        source: 'attacker-supplied',
        capturedAt: '2026-01-01T00:00:00.000Z',
        contentIsUntrustedReference: true,
        truncated: false,
      },
    };

    expect(agentContextPacketSchema.safeParse(packet).success).toBe(false);
  });
});

describe('agent environment naming', () => {
  it('creates Interleaf-named branches', () => {
    expect(agentSessionBranchName('s1')).toBe('interleaf/s1');
  });

  it('rehydrates a session whose branch was created before the rename', () => {
    expect(isAgentSessionBranchName(legacyAgentSessionBranchName('s1'), 's1')).toBe(true);
    expect(isAgentSessionBranchName(agentSessionBranchName('s1'), 's1')).toBe(true);
  });

  it('still refuses a branch bound to a different session or an unrelated name', () => {
    expect(isAgentSessionBranchName('interleaf/other', 's1')).toBe(false);
    expect(isAgentSessionBranchName('marginlab/other', 's1')).toBe(false);
    expect(isAgentSessionBranchName('main', 's1')).toBe(false);
    expect(isAgentSessionBranchName(undefined, 's1')).toBe(false);
  });

  it('recognizes app-generated staging directories in either spelling', () => {
    expect(isAgentStageDirectoryName('.interleaf-stage-s1')).toBe(true);
    expect(isAgentStageDirectoryName('.marginlab-stage-s1')).toBe(true);
    expect(isAgentStageDirectoryName('src')).toBe(false);
  });
});

describe('custom media scheme in the Content Security Policy', () => {
  it('allows only the Interleaf media scheme for images and connections', () => {
    for (const policy of [CSP_DIRECTIVES, DEV_CSP_DIRECTIVES]) {
      expect(policy).toContain("img-src 'self' interleaf-media: data: blob:");
      expect(policy).toContain("connect-src 'self' interleaf-media:");
      // The pre-rebrand scheme is not registered, so it must not be permitted.
      expect(policy).not.toContain('marginlab-media');
      // Interactive document media stays permanently unsupported.
      expect(policy).toContain("media-src 'none'");
      expect(policy).toContain("object-src 'none'");
    }
  });
});

describe('packaged application icon resolution', () => {
  it('prefers the packaged resources copy over the repository copy', () => {
    const candidates = brandIconCandidatePaths({
      resourcesPath: '/Applications/Interleaf.app/Contents/Resources',
      mainDirectory: '/Applications/Interleaf.app/Contents/Resources/app.asar/out/main',
    });

    expect(candidates[0]).toBe('/Applications/Interleaf.app/Contents/Resources/icon.png');
    expect(candidates).toHaveLength(2);
  });

  it('falls back to the repository resources directory when unpackaged', () => {
    const candidates = brandIconCandidatePaths({
      mainDirectory: '/repo/out/main',
    });

    expect(candidates).toEqual(['/repo/resources/icon.png']);
  });
});

describe('pre-rebrand agent error events', () => {
  // An event with no error member omits the key, the way a stored event that
  // never had one reads back out of JSON.
  const legacyEvent = (error?: PortableValue): PortableRecord => ({
    sessionId: 'session-1',
    ordinal: 0,
    type: 'error',
    timestamp: '2026-01-01T00:00:00.000Z',
    ...(error === undefined ? {} : { error }),
  });
  const normalizedError = (event: PortableMember): PortableMember =>
    isPortableRecord(event) ? event.error : undefined;

  it('rewrites only the marker key and keeps bounded extras', () => {
    const normalized = normalizeLegacyStoredAgentEvent(
      legacyEvent({ __marginlabError: true, code: 'agent-failed', message: 'Boom', detail: { retries: 2 } }),
    );

    expect(normalizedError(normalized)).toEqual({
      __interleafError: true,
      code: 'agent-failed',
      message: 'Boom',
      detail: { retries: 2 },
    });
  });

  it('leaves a current-marker event untouched', () => {
    const current = legacyEvent({ __interleafError: true, code: 'agent-failed', message: 'Boom' });

    expect(normalizeLegacyStoredAgentEvent(current)).toBe(current);
  });

  it('refuses lookalikes that break the bounded rules', () => {
    const unchanged = [
      { __marginlabError: 'true', code: 'agent-failed', message: 'Boom' },
      { __marginlabError: true, code: 'x'.repeat(129), message: 'Boom' },
      { __marginlabError: true, code: 'agent-failed', message: '' },
      { __marginlabError: true, code: 'agent-failed', message: 'y'.repeat(2_001) },
      // An extra nested deeper than the bounded rules admit.
      { __marginlabError: true, code: 'agent-failed', message: 'Boom', extra: { a: { b: { c: { d: { e: { f: 'too deep' } } } } } } },
      { __marginlabError: true, __interleafError: false, code: 'agent-failed', message: 'Boom' },
    ];

    for (const error of unchanged) {
      const event = legacyEvent(error);
      expect(normalizeLegacyStoredAgentEvent(event)).toBe(event);
      // Nothing is normalized, so the event still fails the current schema.
      expect(agentEventSchema.safeParse(event).success).toBe(false);
    }
  });

  it('passes through values that are not events', () => {
    expect(normalizeLegacyStoredAgentEvent(null)).toBeNull();
    expect(normalizeLegacyStoredAgentEvent('event')).toBe('event');
    const withoutError = legacyEvent();
    expect(normalizeLegacyStoredAgentEvent(withoutError)).toBe(withoutError);
  });
});
