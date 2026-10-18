import { describe, expect, it } from 'vitest';
import {
  MERMAID_LIMITS,
  applyMermaidSourcePolicy,
  describeMermaidFailure,
  mermaidRenderRequestSchema,
  mermaidRenderResultSchema,
  mermaidSandboxResultSchema,
} from '@shared/schemas/mermaid';

function accepted(source: string): { source: string; overridesRemoved: boolean } {
  const result = applyMermaidSourcePolicy(source);
  if (result.status !== 'accepted') throw new Error(`expected acceptance, got ${result.reason}`);
  return { source: result.source, overridesRemoved: result.overridesRemoved };
}

describe('mermaid source policy', () => {
  it('keeps an ordinary diagram source unchanged', () => {
    const result = accepted('flowchart TD\n  A[Start] --> B[End]');
    expect(result.source).toBe('flowchart TD\n  A[Start] --> B[End]');
    expect(result.overridesRemoved).toBe(false);
  });

  it('removes in-source configuration directives', () => {
    const result = accepted(
      '%%{init: {"securityLevel": "loose", "flowchart": {"htmlLabels": true}} }%%\nflowchart TD\n  A --> B'
    );
    expect(result.source).not.toContain('securityLevel');
    expect(result.source).not.toContain('htmlLabels');
    expect(result.source.startsWith('flowchart TD')).toBe(true);
    expect(result.overridesRemoved).toBe(true);
  });

  it('removes a directive that is never closed rather than keeping its tail', () => {
    const result = accepted('flowchart TD\n%%{init: {"theme": "forest"\n  A --> B');
    expect(result.source).not.toContain('theme');
    expect(result.source).toContain('A --> B');
    expect(result.overridesRemoved).toBe(true);
  });

  it('strips frontmatter configuration but keeps the diagram title', () => {
    const result = accepted(
      '---\ntitle: Release flow\nconfig:\n  theme: dark\n  securityLevel: loose\n---\nflowchart TD\n  A --> B'
    );
    expect(result.source).toContain('title: Release flow');
    expect(result.source).not.toContain('securityLevel');
    expect(result.source).not.toContain('theme');
    expect(result.overridesRemoved).toBe(true);
  });

  it('drops a frontmatter block that keeps nothing', () => {
    const result = accepted('---\nconfig:\n  theme: dark\n---\nflowchart TD\n  A --> B');
    expect(result.source.startsWith('flowchart TD')).toBe(true);
    expect(result.overridesRemoved).toBe(true);
  });

  it('leaves text that merely looks like frontmatter alone', () => {
    const result = accepted('flowchart TD\n  A["---"] --> B');
    expect(result.source).toContain('A["---"]');
    expect(result.overridesRemoved).toBe(false);
  });

  it('rejects a source past the character bound', () => {
    const source = `flowchart TD\n${'  A --> B\n'.repeat(4_000)}`;
    expect(source.length).toBeGreaterThan(MERMAID_LIMITS.maxSourceLength);
    expect(applyMermaidSourcePolicy(source)).toEqual({
      status: 'rejected',
      reason: 'source-too-large',
    });
  });

  it('rejects a source past the line bound even when it is short', () => {
    const source = `flowchart TD\n${'\n'.repeat(MERMAID_LIMITS.maxSourceLines)}A --> B`;
    expect(source.length).toBeLessThan(MERMAID_LIMITS.maxSourceLength);
    expect(applyMermaidSourcePolicy(source)).toEqual({
      status: 'rejected',
      reason: 'source-too-large',
    });
  });

  it('rejects a source that is nothing but directives', () => {
    expect(applyMermaidSourcePolicy('%%{init: {"theme": "dark"} }%%\n   ')).toEqual({
      status: 'rejected',
      reason: 'empty',
    });
  });

  it('normalizes line endings so the line bound cannot be evaded', () => {
    const result = accepted('flowchart TD\r\n  A --> B\r');
    expect(result.source).toBe('flowchart TD\n  A --> B');
  });
});

describe('mermaid contracts', () => {
  it('accepts a well-formed render request and rejects extra fields', () => {
    expect(
      mermaidRenderRequestSchema.safeParse({ source: 'flowchart TD\n A-->B', appearance: 'dark' })
        .success
    ).toBe(true);
    expect(
      mermaidRenderRequestSchema.safeParse({
        source: 'flowchart TD',
        appearance: 'light',
        securityLevel: 'loose',
      }).success
    ).toBe(false);
    expect(
      mermaidRenderRequestSchema.safeParse({ source: 'flowchart TD', appearance: 'sepia' }).success
    ).toBe(false);
    expect(
      mermaidRenderRequestSchema.safeParse({
        source: 'x'.repeat(MERMAID_LIMITS.maxSourceLength + 1),
        appearance: 'light',
      }).success
    ).toBe(false);
  });

  it('rejects a rendered result that exceeds the fixed output bounds', () => {
    expect(
      mermaidRenderResultSchema.safeParse({
        status: 'rendered',
        svg: '<svg></svg>',
        width: 10,
        height: 10,
      }).success
    ).toBe(true);
    expect(
      mermaidRenderResultSchema.safeParse({
        status: 'rendered',
        svg: '<svg></svg>',
        width: MERMAID_LIMITS.maxDimension + 1,
        height: 10,
      }).success
    ).toBe(false);
    expect(
      mermaidRenderResultSchema.safeParse({ status: 'failed', reason: 'exploded' }).success
    ).toBe(false);
  });

  it('requires the isolated renderer to name the job it is answering', () => {
    expect(
      mermaidSandboxResultSchema.safeParse({
        jobId: 'job-1',
        status: 'rendered',
        svg: '<svg></svg>',
        width: 10,
        height: 10,
      }).success
    ).toBe(true);
    expect(
      mermaidSandboxResultSchema.safeParse({
        status: 'rendered',
        svg: '<svg></svg>',
        width: 10,
        height: 10,
      }).success
    ).toBe(false);
  });

  it('has reader-facing wording for every failure reason', () => {
    const reasons = [
      'invalid-syntax',
      'unsupported-diagram',
      'source-too-large',
      'output-too-large',
      'timeout',
      'unavailable',
      'rejected-output',
    ] as const;
    const messages = reasons.map((reason) => describeMermaidFailure({ status: 'failed', reason }));
    for (const message of messages) {
      expect(message).toBeTruthy();
      // A sentence for a reader, not an identifier for a log.
      expect(message).toMatch(/^[A-Z].*\.$/);
    }
    expect(new Set(messages).size).toBe(reasons.length);
    expect(
      describeMermaidFailure({ status: 'rendered', svg: '<svg></svg>', width: 1, height: 1 })
    ).toBeNull();
  });
});
