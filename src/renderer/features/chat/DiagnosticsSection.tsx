import { useEffect, useState, type ReactElement } from 'react';
import { AI_PROVIDER_DISPLAY_NAMES } from '@shared/constants/ai';
import {
  DIAGNOSTICS_LIMITS,
  type DiagnosticsCollectResult,
  type DiagnosticsFailure,
  type DiagnosticsProviderId,
} from '@shared/schemas/diagnostics';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/select';
import { useDiagnosticsStore, type DiagnosticsNotice } from '../../stores/use-diagnostics-store';

/**
 * Private diagnostics, in Settings › Advanced.
 *
 * Collection is local and needs neither a document nor an AI provider. The
 * user reviews the exact packet and report before anything is sent, chooses a
 * provider themselves, and exports only by picking a file in a native dialog.
 * The packet and handle are dropped when the panel closes.
 */

const FAILURE_COPY: Record<DiagnosticsFailure, string> = {
  'provider-unavailable': 'That provider is no longer ready to analyze without tools. Run diagnostics again to refresh the list.',
  'model-unavailable': 'That model is no longer offered by the provider. Choose another model.',
  busy: 'Another diagnostics analysis is still running. Wait for it to finish or cancel it.',
  timeout: 'The provider took too long to answer. Try again, or export the report without an analysis.',
  'too-long': 'The provider\'s answer was longer than diagnostics allow, so it was not used.',
  empty: 'The provider returned no usable answer.',
  'provider-failed': 'The provider could not complete the analysis. Check its connection in AI Providers, then try again.',
  cancelled: 'Analysis cancelled. Nothing from it was kept.',
};

function noticeText(notice: DiagnosticsNotice): string {
  switch (notice.kind) {
    case 'error': return notice.message;
    case 'analysis-failed': return FAILURE_COPY[notice.reason];
    case 'exported': return `Saved ${notice.fileName}. Review it before sharing it with anyone.`;
    case 'export-cancelled': return 'Export cancelled. Nothing was saved.';
  }
}

export function DiagnosticsSection(): ReactElement {
  const step = useDiagnosticsStore((state) => state.step);
  const collected = useDiagnosticsStore((state) => state.collected);
  const notice = useDiagnosticsStore((state) => state.notice);
  const collect = useDiagnosticsStore((state) => state.collect);
  const discard = useDiagnosticsStore((state) => state.discard);

  // Closing Settings or leaving Advanced forgets the packet here and in main.
  useEffect(() => discard, [discard]);

  const failed = notice !== null && (notice.kind === 'error' || notice.kind === 'analysis-failed');
  return (
    <section aria-labelledby="settings-diagnostics-heading" data-testid="settings-diagnostics" className="mt-6 max-w-xl border-t border-border-subtle pt-4">
      <h4 id="settings-diagnostics-heading" className="text-sm font-semibold text-text-primary">Private diagnostics</h4>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">
        Helps with provider detection and sign-in, imports, startup, packaging and updates, and agent preparation.
        Interleaf collects its version, runtime versions, OS family and architecture, whether it is packaged, each
        provider&apos;s readiness, and counts of local log records by category, level and known failure code.
        Raw log messages, settings, credentials, library contents, documents, notes, chats, file paths, and account names
        are never included in the packet or shared. Status checks may connect to configured providers, but diagnostics packets
        leave this device only if you explicitly choose to analyze or export.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button
          variant={collected === null ? 'primary' : 'outline'}
          size="sm"
          data-testid="diagnostics-run"
          onClick={() => { void collect(); }}
          disabled={step !== 'idle' && step !== 'ready'}
          aria-busy={step === 'collecting'}
        >
          {step === 'collecting' ? 'Collecting…' : collected === null ? 'Run diagnostics' : 'Run diagnostics again'}
        </Button>
        {collected !== null && (
          <Button variant="ghost" size="sm" data-testid="diagnostics-discard" onClick={discard} disabled={step !== 'ready'}>
            Discard
          </Button>
        )}
      </div>
      {step === 'collecting' && <p role="status" aria-live="polite" className="mt-2 text-xs text-text-secondary">Collecting diagnostics on this device…</p>}
      {notice !== null && (
        <p
          role={failed ? 'alert' : 'status'}
          data-testid="diagnostics-notice"
          className={failed ? 'mt-3 rounded-md bg-danger/10 p-2 text-xs text-danger' : 'mt-3 text-xs text-text-secondary'}
        >
          {noticeText(notice)}
        </p>
      )}
      {collected !== null && <CollectedDiagnostics collected={collected} />}
    </section>
  );
}

function CollectedDiagnostics({ collected }: { readonly collected: DiagnosticsCollectResult }): ReactElement {
  const step = useDiagnosticsStore((state) => state.step);
  const issue = useDiagnosticsStore((state) => state.issue);
  const report = useDiagnosticsStore((state) => state.report);
  const setIssue = useDiagnosticsStore((state) => state.setIssue);
  const review = useDiagnosticsStore((state) => state.review);
  const exportReport = useDiagnosticsStore((state) => state.exportReport);
  const idle = step === 'ready';

  return (
    <div className="mt-4 space-y-4">
      <div>
        <h5 className="text-xs font-semibold text-text-primary">Collected on this device</h5>
        <pre
          data-testid="diagnostics-packet"
          tabIndex={0}
          aria-label="Collected diagnostics packet"
          className="mt-1 max-h-48 overflow-auto rounded-md border border-border-subtle bg-bg-surface p-2 text-2xs leading-relaxed text-text-primary"
        >
          {collected.packetText}
        </pre>
      </div>
      <label className="block text-xs text-text-secondary">
        <span className="font-medium text-text-primary">Describe the problem (optional)</span>
        <textarea
          data-testid="diagnostics-issue"
          value={issue}
          maxLength={DIAGNOSTICS_LIMITS.issueMaxLength}
          rows={3}
          disabled={!idle}
          onChange={(event) => { setIssue(event.target.value); }}
          aria-describedby="diagnostics-issue-help"
          className="mt-1 block w-full rounded-md border border-border-strong bg-bg-primary p-2 text-xs text-text-primary placeholder:text-text-secondary disabled:opacity-50"
          placeholder="For example: Claude shows as not signed in after I sign in from the terminal."
        />
        <span id="diagnostics-issue-help" className="mt-1 block text-2xs leading-relaxed">
          {issue.length}/{DIAGNOSTICS_LIMITS.issueMaxLength}. Interleaf removes common secrets, email addresses and file paths before
          showing the report. Leave out anything else you would not share.
        </span>
      </label>
      <Button variant="outline" size="sm" data-testid="diagnostics-review" onClick={() => { void review(); }} disabled={!idle} aria-busy={step === 'reviewing'}>
        {step === 'reviewing' ? 'Preparing…' : report === null ? 'Review report' : 'Review report again'}
      </Button>
      {report === null ? (
        <p className="text-2xs text-text-secondary">Review the report to enable analysis and export.</p>
      ) : (
        <>
          <div>
            <h5 className="text-xs font-semibold text-text-primary">Report preview</h5>
            <p className="mt-1 text-2xs leading-relaxed text-text-secondary">
              This is exactly what Export saves. Review it before sharing it: Interleaf cannot guarantee it identifies no one.
            </p>
            <pre
              data-testid="diagnostics-report"
              tabIndex={0}
              aria-label="Diagnostics report preview"
              className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border-subtle bg-bg-surface p-2 text-2xs leading-relaxed text-text-primary"
            >
              {report.text}
            </pre>
          </div>
          <DiagnosticsAnalysis key={collected.handle} providers={collected.providers} />
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" data-testid="diagnostics-export" onClick={() => { void exportReport(); }} disabled={!idle} aria-busy={step === 'exporting'}>
              {step === 'exporting' ? 'Exporting…' : 'Export report…'}
            </Button>
            <span className="text-2xs text-text-secondary">Saves a Markdown file where you choose. Nothing is uploaded or shared.</span>
          </div>
        </>
      )}
    </div>
  );
}

function DiagnosticsAnalysis({ providers }: { readonly providers: DiagnosticsCollectResult['providers'] }): ReactElement {
  const step = useDiagnosticsStore((state) => state.step);
  const analyzed = useDiagnosticsStore((state) => state.report?.analyzed === true);
  const analyze = useDiagnosticsStore((state) => state.analyze);
  const cancel = useDiagnosticsStore((state) => state.cancel);
  // Nothing is chosen for the user; the first request waits for their choice.
  const [providerId, setProviderId] = useState<DiagnosticsProviderId | ''>('');
  const [modelId, setModelId] = useState('');

  if (providers.length === 0) {
    return (
      <p data-testid="diagnostics-no-provider" className="rounded-md border border-border-subtle bg-bg-surface p-2 text-xs leading-relaxed text-text-secondary">
        No connected provider can analyze this without tools. Collection and export still work. Optional analysis uses a
        supported tool-free CLI provider, such as Claude Code, connected in AI Providers. ChatGPT (subscription) retains a tool
        surface. OpenRouter and local-server analysis are disabled until their cancellation is safe.
      </p>
    );
  }

  const provider = providers.find((entry) => entry.id === providerId);
  const name = provider === undefined ? null : AI_PROVIDER_DISPLAY_NAMES[provider.id];
  const ready = provider?.models.some((model) => model.id === modelId) === true;
  return (
    <div className="space-y-2 rounded-md border border-border-subtle p-3">
      <h5 className="text-xs font-semibold text-text-primary">Optional AI analysis</h5>
      <div className="grid gap-2 sm:grid-cols-2">
        <Select
          aria-label="Provider for diagnostics analysis"
          data-testid="diagnostics-provider"
          value={providerId}
          placeholder="Choose a provider"
          disabled={step !== 'ready'}
          size="sm"
          options={providers.map((entry) => ({ value: entry.id, label: AI_PROVIDER_DISPLAY_NAMES[entry.id] }))}
          onValueChange={(value) => { setProviderId(value); setModelId(''); }}
        />
        <Select
          aria-label="Model for diagnostics analysis"
          data-testid="diagnostics-model"
          value={modelId}
          placeholder="Choose a model"
          disabled={step !== 'ready' || provider === undefined}
          size="sm"
          options={(provider?.models ?? []).map((model) => ({ value: model.id, label: model.name }))}
          onValueChange={setModelId}
        />
      </div>
      <p id="diagnostics-analysis-disclosure" className="text-2xs leading-relaxed text-text-secondary">
        Analysis sends the collected packet and your reviewed description, and nothing else, to {name ?? 'the provider you choose'}.
        That provider, or the account it uses, may process and keep them under its own terms. The answer is unverified,
        and Interleaf never runs or applies anything it suggests.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          data-testid="diagnostics-analyze"
          disabled={step !== 'ready' || !ready}
          aria-describedby="diagnostics-analysis-disclosure"
          onClick={() => { if (provider !== undefined) void analyze(provider.id, modelId); }}
        >
          {name === null ? 'Analyze' : `Analyze with ${name}`}
        </Button>
        {step === 'analyzing' && (
          <>
            <Button variant="danger" size="sm" data-testid="diagnostics-cancel" onClick={cancel}>Cancel analysis</Button>
            <span role="status" aria-live="polite" className="text-xs text-text-secondary">Waiting for {name ?? 'the provider'}…</span>
          </>
        )}
        {step !== 'analyzing' && analyzed && <span role="status" className="text-xs text-text-secondary">Analysis added to the report preview.</span>}
      </div>
    </div>
  );
}
