import { useState, type ReactElement } from 'react';
import { AI_PROVIDER_DISPLAY_NAMES } from '@shared/constants/ai';
import type { DiagnosticsCollectResult, DiagnosticsProviderId } from '@shared/schemas/diagnostics';
import { Button } from '../../components/ui/button';
import { Select } from '../../components/ui/select';
import { useDiagnosticsStore } from '../../stores/use-diagnostics-store';
import { DiagnosticsDisclosure } from './DiagnosticsDisclosure';
import { DiagnosticsNotice } from './DiagnosticsNotice';
import { addedAnalysis } from './diagnostics-summary';

type Providers = DiagnosticsCollectResult['providers'];

const HEADING_ID = 'diagnostics-analysis-heading';

/**
 * Optional analysis of the reviewed report. Nothing is chosen for the user and
 * nothing is sent until they pick a provider and model and ask. The answer is
 * shown as plain text in its own panel, never as Markdown, links or actions.
 */
export function DiagnosticsAnalysis({ providers }: { readonly providers: Providers }): ReactElement {
  return (
    <div role="group" aria-labelledby={HEADING_ID} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h5 id={HEADING_ID} className="text-xs font-semibold text-text-primary">Optional: ask AI to analyze</h5>
        <p className="text-2xs leading-relaxed text-text-secondary">You can skip this. Export works without it.</p>
      </div>
      {providers.length === 0 ? <NoEligibleProvider /> : <AnalysisControls providers={providers} />}
    </div>
  );
}

function NoEligibleProvider(): ReactElement {
  return (
    <div data-testid="diagnostics-no-provider" className="flex flex-col gap-2 text-xs leading-relaxed text-text-secondary">
      <p>
        No connected AI provider can analyze this report without tools. You can still export it.
      </p>
      <p>
        To add an analysis, connect Claude Code in Settings › AI Providers, then come back here and prepare the report again.
        Leaving this page discards the current report.
      </p>
      <DiagnosticsDisclosure label="Why some providers are not offered">
        <p className="text-2xs leading-relaxed">
          Analysis only uses a supported CLI provider that can answer without tools, such as Claude Code. ChatGPT
          (subscription) retains a tool surface. OpenRouter and local-server analysis are disabled until their cancellation
          is safe.
        </p>
      </DiagnosticsDisclosure>
    </div>
  );
}

function AnalysisControls({ providers }: { readonly providers: Providers }): ReactElement {
  const step = useDiagnosticsStore((state) => state.step);
  const notice = useDiagnosticsStore((state) => state.notice);
  const analyze = useDiagnosticsStore((state) => state.analyze);
  const cancel = useDiagnosticsStore((state) => state.cancel);
  // Nothing is chosen for the user; the first request waits for their choice.
  const [providerId, setProviderId] = useState<DiagnosticsProviderId | ''>('');
  const [modelId, setModelId] = useState('');

  const provider = providers.find((entry) => entry.id === providerId);
  const name = provider === undefined ? null : AI_PROVIDER_DISPLAY_NAMES[provider.id];
  const ready = provider?.models.some((model) => model.id === modelId) === true;
  const idle = step === 'ready';
  const analyzing = step === 'analyzing';

  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex min-w-0 flex-col gap-1 text-xs font-medium text-text-primary">
          <span id="diagnostics-provider-label">Provider</span>
          <Select
            aria-labelledby="diagnostics-provider-label"
            data-testid="diagnostics-provider"
            value={providerId}
            placeholder="Choose a provider"
            disabled={!idle}
            size="sm"
            options={providers.map((entry) => ({ value: entry.id, label: AI_PROVIDER_DISPLAY_NAMES[entry.id] }))}
            onValueChange={(value) => { setProviderId(value); setModelId(''); }}
          />
        </div>
        <div className="flex min-w-0 flex-col gap-1 text-xs font-medium text-text-primary">
          <span id="diagnostics-model-label">Model</span>
          <Select
            aria-labelledby="diagnostics-model-label"
            data-testid="diagnostics-model"
            value={modelId}
            placeholder={provider === undefined ? 'Choose a provider first' : 'Choose a model'}
            disabled={!idle || provider === undefined}
            size="sm"
            options={(provider?.models ?? []).map((model) => ({ value: model.id, label: model.name }))}
            onValueChange={setModelId}
          />
        </div>
      </div>
      <p id="diagnostics-analysis-disclosure" className="text-2xs leading-relaxed text-text-secondary">
        Analysis sends the collected packet and your reviewed description, and nothing else, to {name ?? 'the provider you choose'}.
        That provider, or the account it uses, may process and keep them under its own terms. The answer is unverified,
        and Interleaf never runs or applies anything it suggests.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          data-testid="diagnostics-analyze"
          disabled={!idle || !ready}
          aria-busy={analyzing}
          aria-describedby="diagnostics-analysis-disclosure"
          onClick={() => { if (provider !== undefined) void analyze(provider.id, modelId); }}
        >
          {name === null ? 'Analyze' : `Analyze with ${name}`}
        </Button>
        {analyzing && <Button variant="danger" size="sm" data-testid="diagnostics-cancel" onClick={cancel}>Cancel analysis</Button>}
      </div>
      {analyzing && (
        <p role="status" aria-live="polite" className="text-xs text-text-secondary">Waiting for {name ?? 'the provider'}… Export stays available after it finishes or you cancel.</p>
      )}
      {!analyzing && !ready && <p className="text-2xs text-text-secondary">Choose a provider and a model to enable analysis.</p>}
      {notice?.kind === 'analysis-failed' && <DiagnosticsNotice notice={notice} />}
      <AnalysisAnswer />
    </>
  );
}

/** What the analysis added to the report, found by comparing main's two reports and shown as inert text. */
function AnalysisAnswer(): ReactElement | null {
  const report = useDiagnosticsStore((state) => state.report);
  if (report?.analyzed !== true) return null;
  const added = addedAnalysis(report.reviewedText, report.text);
  return (
    <section aria-labelledby="diagnostics-answer-heading" data-testid="diagnostics-analysis" className="flex flex-col gap-2 rounded-md border border-dashed border-border-strong p-3">
      <h6 id="diagnostics-answer-heading" className="text-xs font-semibold text-text-primary">Unverified AI analysis</h6>
      <p className="text-2xs leading-relaxed text-text-secondary">
        Written by a model, not checked by Interleaf. Treat it as a suggestion and do not run commands from it. It is included
        when you export the report.
      </p>
      {added === null
        ? <p className="text-xs text-text-secondary">The analysis was added to the full report file above.</p>
        : <p data-testid="diagnostics-analysis-text" className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-primary">{added}</p>}
    </section>
  );
}
