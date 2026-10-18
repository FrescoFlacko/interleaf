import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MERMAID_LIMITS } from '@shared/schemas/mermaid';
import type { CloneableRecord, CloneableValue } from '@shared/models/portable';
import type { MermaidSandboxJob } from '@shared/types/mermaid';
import {
  MermaidRenderService,
  type MermaidSandbox,
} from '../../src/main/documents/mermaid/mermaid-render-service';

const INERT_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(#a)"/></svg>';

const log = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

type FakeSandbox = MermaidSandbox & {
  readonly jobs: MermaidSandboxJob[];
  destroyed: boolean;
};

/**
 * A renderer main can drive without an Electron window. `answer` decides what
 * the isolated side claims; the service is expected to distrust all of it.
 */
function fakeSandbox(answer: (job: MermaidSandboxJob) => Promise<CloneableValue>): FakeSandbox {
  const jobs: MermaidSandboxJob[] = [];
  const sandbox: FakeSandbox = {
    jobs,
    destroyed: false,
    ready: () => Promise.resolve(),
    run: async (job) => {
      jobs.push(job);
      return answer(job);
    },
    destroy: () => {
      sandbox.destroyed = true;
    },
  };
  return sandbox;
}

/** A promise whose settlement a test decides, without narrowing surprises. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  const box: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>((resolve) => {
    box.resolve = resolve;
  });
  return { promise, resolve: (value) => { box.resolve(value); } };
}

function rendered(job: MermaidSandboxJob, svg = INERT_SVG): CloneableRecord {
  return { jobId: job.jobId, status: 'rendered', svg, width: 120, height: 80 };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MermaidRenderService', () => {
  it('draws a valid diagram and reports its size', async () => {
    const sandbox = fakeSandbox((job) => Promise.resolve(rendered(job)));
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    const result = await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' });

    expect(result).toEqual({ status: 'rendered', svg: INERT_SVG, width: 120, height: 80 });
    expect(sandbox.jobs).toHaveLength(1);
    service.dispose();
  });

  it('applies the source policy before anything is dispatched', async () => {
    const sandbox = fakeSandbox((job) => Promise.resolve(rendered(job)));
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    await service.render({
      source: '%%{init: {"securityLevel":"loose"} }%%\nflowchart TD\n A-->B',
      appearance: 'dark',
    });

    expect(sandbox.jobs[0]?.source).not.toContain('securityLevel');
    expect(sandbox.jobs[0]?.appearance).toBe('dark');
    // Bounds travel with the job and are the product's, not the caller's.
    expect(sandbox.jobs[0]?.maxDimension).toBe(MERMAID_LIMITS.maxDimension);
    expect(sandbox.jobs[0]?.maxSvgBytes).toBe(MERMAID_LIMITS.maxSvgLength);
    service.dispose();
  });

  it('refuses an oversized source without starting a renderer', async () => {
    const createSandbox = vi.fn(() => fakeSandbox((job) => Promise.resolve(rendered(job))));
    const service = new MermaidRenderService({ createSandbox, log });

    const result = await service.render({
      source: 'x'.repeat(MERMAID_LIMITS.maxSourceLength + 1),
      appearance: 'light',
    });

    expect(result).toEqual({ status: 'failed', reason: 'source-too-large' });
    expect(createSandbox).not.toHaveBeenCalled();
    service.dispose();
  });

  it('falls back to unavailable when the isolated page never becomes ready', async () => {
    const sandboxes: FakeSandbox[] = [];
    const createSandbox = vi.fn(() => {
      const sandbox = fakeSandbox((job) => Promise.resolve(rendered(job)));
      sandbox.ready = () => Promise.reject(new Error('MermaidSandboxLoadFailed'));
      sandboxes.push(sandbox);
      return sandbox;
    });
    const service = new MermaidRenderService({ createSandbox, log });

    const result = await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' });

    expect(result).toEqual({ status: 'failed', reason: 'unavailable' });
    // The window that could not load is ended rather than kept and retried
    // forever, and no job was dispatched into it.
    expect(sandboxes[0]?.destroyed).toBe(true);
    expect(sandboxes[0]?.jobs).toHaveLength(0);

    await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' });
    expect(createSandbox).toHaveBeenCalledTimes(2);
    service.dispose();
  });

  it('gives every job a distinct identity', async () => {
    const sandbox = fakeSandbox((job) => Promise.resolve(rendered(job)));
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' });
    await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' });

    expect(sandbox.jobs[0]?.jobId).not.toBe(sandbox.jobs[1]?.jobId);
    service.dispose();
  });

  it('runs one diagram at a time', async () => {
    let active = 0;
    let peak = 0;
    const sandbox = fakeSandbox(async (job) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return rendered(job);
    });
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    await Promise.all(
      Array.from({ length: 5 }, () =>
        service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' })
      )
    );

    expect(peak).toBe(1);
    expect(sandbox.jobs).toHaveLength(5);
    service.dispose();
  });

  it('refuses work past the queue bound instead of growing without limit', async () => {
    const gate = deferred<'go'>();
    const sandbox = fakeSandbox(async (job) => {
      await gate.promise;
      return rendered(job);
    });
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    const pending = Array.from({ length: MERMAID_LIMITS.maxQueuedJobs + 4 }, () =>
      service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' })
    );
    const overflow = await service.render({
      source: 'flowchart TD\n A-->B',
      appearance: 'light',
    });

    expect(overflow).toEqual({ status: 'failed', reason: 'unavailable' });
    gate.resolve('go');
    await Promise.all(pending);
    service.dispose();
  });

  it('terminates the renderer process when a diagram passes its deadline', async () => {
    vi.useFakeTimers();
    const sandboxes: FakeSandbox[] = [];
    const service = new MermaidRenderService({
      createSandbox: () => {
        // The first renderer never answers; the timer is the only thing that
        // ends it, which is the point of the bound.
        const sandbox =
          sandboxes.length === 0
            ? fakeSandbox(() => new Promise<CloneableValue>(() => undefined))
            : fakeSandbox((job) => Promise.resolve(rendered(job)));
        sandboxes.push(sandbox);
        return sandbox;
      },
      log,
      timeoutMs: 50,
    });

    const pending = service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' });
    await vi.advanceTimersByTimeAsync(60);

    expect(await pending).toEqual({ status: 'failed', reason: 'timeout' });
    expect(sandboxes[0]?.destroyed).toBe(true);

    // The next diagram gets a fresh process: one hostile source costs one
    // renderer, not the feature.
    vi.useRealTimers();
    const next = await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' });
    expect(next.status).toBe('rendered');
    expect(sandboxes).toHaveLength(2);
    service.dispose();
  });

  it('never lets a caller extend the fixed deadline', async () => {
    vi.useFakeTimers();
    const sandbox = fakeSandbox(() => new Promise<CloneableValue>(() => undefined));
    const service = new MermaidRenderService({
      createSandbox: () => sandbox,
      log,
      timeoutMs: MERMAID_LIMITS.renderTimeoutMs * 100,
    });

    const pending = service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' });
    await vi.advanceTimersByTimeAsync(MERMAID_LIMITS.renderTimeoutMs + 10);

    expect(await pending).toEqual({ status: 'failed', reason: 'timeout' });
    service.dispose();
  });

  it('discards a reply that names a job this side already abandoned', async () => {
    const sandbox = fakeSandbox(() =>
      Promise.resolve({ jobId: 'some-other-job', status: 'rendered', svg: INERT_SVG, width: 10, height: 10 })
    );
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    expect(await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' })).toEqual({
      status: 'failed',
      reason: 'rejected-output',
    });
    service.dispose();
  });

  it.each([
    ['an unrecognized shape', { status: 'rendered' }, 'rejected-output'],
    ['a non-object reply', 'looks fine to me', 'rejected-output'],
  ])('refuses %s from the renderer', async (_name, answer, reason) => {
    const sandbox = fakeSandbox(() => Promise.resolve(answer));
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    expect(await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' })).toEqual({
      status: 'failed',
      reason,
    });
    service.dispose();
  });

  it('re-checks the markup itself rather than trusting the renderer sanitized it', async () => {
    const sandbox = fakeSandbox((job) =>
      Promise.resolve(rendered(job, '<svg><script>fetch("https://evil.example")</script></svg>'))
    );
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    expect(await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' })).toEqual({
      status: 'failed',
      reason: 'rejected-output',
    });
    service.dispose();
  });

  it('re-checks the dimensions the renderer reported', async () => {
    const sandbox = fakeSandbox((job) =>
      Promise.resolve({
        ...rendered(job),
        jobId: job.jobId,
        width: MERMAID_LIMITS.maxDimension + 1,
      })
    );
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    expect(await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' })).toEqual({
      status: 'failed',
      reason: 'output-too-large',
    });
    service.dispose();
  });

  it('passes a typed failure from the renderer straight through', async () => {
    const sandbox = fakeSandbox((job) =>
      Promise.resolve({ jobId: job.jobId, status: 'failed', reason: 'invalid-syntax' })
    );
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    expect(await service.render({ source: 'flowchart TD\n ???', appearance: 'light' })).toEqual({
      status: 'failed',
      reason: 'invalid-syntax',
    });
    service.dispose();
  });

  it('survives a renderer that cannot start', async () => {
    const service = new MermaidRenderService({
      createSandbox: () => {
        throw new Error('no window for you');
      },
      log,
    });

    expect(await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' })).toEqual({
      status: 'failed',
      reason: 'unavailable',
    });
    service.dispose();
  });

  it('answers everything still waiting when it is disposed', async () => {
    const gate = deferred<'go'>();
    const sandbox = fakeSandbox(async (job) => {
      await gate.promise;
      return rendered(job);
    });
    const service = new MermaidRenderService({ createSandbox: () => sandbox, log });

    const first = service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' });
    const queued = service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' });
    await Promise.resolve();
    service.dispose();

    expect(sandbox.destroyed).toBe(true);
    expect(await queued).toEqual({ status: 'failed', reason: 'unavailable' });
    gate.resolve('go');
    await first;

    expect(await service.render({ source: 'flowchart TD\n A-->B', appearance: 'light' })).toEqual({
      status: 'failed',
      reason: 'unavailable',
    });
  });
});
