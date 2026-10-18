/**
 * In-app privacy policy shown inside Settings > Privacy.
 *
 * This is static renderer content only: it reads no settings, calls no IPC, and
 * exposes no paths or credentials. It describes what the implementation
 * actually does, so any behavioural change to providers, Agent Mode, or Reader
 * Chat must be reflected here.
 */
import type { ReactNode } from 'react';

const PRIVACY_POLICY_EFFECTIVE_DATE = 'September 12, 2026';

function Article({ id, title, children }: { readonly id: string; readonly title: string; readonly children: ReactNode }) {
  return (
    <article aria-labelledby={id} className="mt-5">
      <h5 id={id} className="text-xs font-semibold text-text-primary">{title}</h5>
      <div className="mt-1.5 space-y-2 text-2xs leading-relaxed text-text-secondary">{children}</div>
    </article>
  );
}

export function PrivacyPolicy() {
  return (
    <section aria-labelledby="settings-privacy-policy-heading" data-testid="settings-privacy-policy" className="mt-6 border-t border-border-subtle pt-6">
      <h4 id="settings-privacy-policy-heading" className="text-sm font-semibold text-text-primary">Privacy Policy</h4>
      <p className="mt-1 text-2xs leading-relaxed text-text-secondary">
        Effective <time dateTime="2026-09-12">{PRIVACY_POLICY_EFFECTIVE_DATE}</time>. This is Interleaf’s current privacy policy and may later be
        mirrored on the Interleaf website. It describes how this version of the application handles your data; it does not promise legal
        guarantees beyond what the application implements.
      </p>

      <Article id="settings-privacy-policy-local" title="Interleaf is local-first">
        <p>
          Imported files, notes, highlights, conversations, settings, and local search indexes are stored on your own computer. Interleaf does
          not upload them anywhere on its own. Your content leaves your computer only when you choose an external AI provider and send a
          request, or when you explicitly export data.
        </p>
      </Article>

      <Article id="settings-privacy-policy-chat" title="Chat with cloud and CLI providers">
        <p>
          When you send a chat request, Interleaf can send your question, the document context you selected, and the conversation history
          included in that request to the provider or command-line tool you chose. Each provider has its own retention, training, and privacy
          terms, which govern what happens to that data once it arrives. Review the terms of the providers you enable.
        </p>
      </Article>

      <Article id="settings-privacy-policy-openrouter" title="OpenRouter">
        <p>
          OpenRouter is a router: it forwards your request to the upstream model provider it selects for the model you picked, and that upstream
          provider also receives your data. Review OpenRouter’s provider-routing and privacy controls, including the available privacy and
          no-retention options, and configure them in your OpenRouter account before sending sensitive content.
        </p>
        <p>
          Web Search is hosted by the provider, not by Interleaf. Enabling it sends your search query onward for provider-side processing and may
          incur separate cost.
        </p>
      </Article>

      <Article id="settings-privacy-policy-local-server" title="Local servers and Ollama">
        <p>
          A loopback Ollama or OpenAI-compatible endpoint tells Interleaf where to <em>connect</em>, not necessarily where inference
          <em> happens</em>. A server listening on your machine may still forward requests upstream.
        </p>
        <p>
          Ollama cloud-capable models send data to Ollama’s servers. If you want Ollama to stay on-device only, run it with
          <code className="px-1 font-mono">OLLAMA_NO_CLOUD=1</code> and select a local model.
        </p>
      </Article>

      <Article id="settings-privacy-policy-credentials" title="Credentials">
        <p>
          An OpenRouter API key is accepted in plaintext only while you are entering it, then encrypted with Electron safeStorage backed by your
          operating system’s keychain. Stored keys are never returned to the interface and are never intentionally logged, placed in prompts, or
          written to the settings database.
        </p>
        <p>
          CLI providers own their own authentication; Interleaf uses whatever session that tool already has. Interleaf never asks you for
          passwords or browser cookies.
        </p>
      </Article>

      <Article id="settings-privacy-policy-agent" title="Agent Mode">
        <p>
          Starting an agent task sends the task you wrote and the context you selected to the command-line agent you chose, under that tool’s own
          terms.
        </p>
        <p>
          Isolated worktrees and isolated copies reduce accidental writes to your active project. They are not operating-system or container
          sandboxes, and they do not confine what the agent tool can read elsewhere on your computer. Direct and unsafe modes write to your real
          project directory and require an explicit confirmation each time.
        </p>
      </Article>

      <Article id="settings-privacy-policy-codex" title="Codex Reader Chat">
        <p>
          Using Codex as a Reader Chat provider runs it in a constrained configuration: a private, empty, Interleaf-owned working directory, a
          read-only sandbox, approvals set to never, your personal Codex rules and configuration ignored, a minimal environment, bounded output
          and run time, cancellation, and a fail-closed response to unsupported or tool-use events.
        </p>
        <p>
          This is constrained, not tool-free. Those controls reduce risk but do not remove Codex’s built-in tool surface, and Codex still runs as
          your user account.
        </p>
      </Article>

      <Article id="settings-privacy-policy-untrusted" title="Untrusted content and diagnostics">
        <p>
          Interleaf treats documents, model output, web content, and command-line tool output as untrusted data. Text arriving from those sources
          does not by itself gain any additional filesystem, credential, network, or execution authority: what Interleaf will do with it stays
          bounded by code-level controls such as validated inter-process messages, canonical path checks, explicit confirmations, and the
          execution mode you selected. An AI model asked to summarise a document can still be influenced by what that document says, so treat
          model answers as suggestions rather than as verified statements.
        </p>
        <p>
          Interleaf’s own diagnostic logs are bounded and redacted, and exclude document bodies, prompts, context packets, credentials, and raw
          agent output streams.
        </p>
        <p>
          Agent session history is separate. Interleaf keeps a bounded record of each agent run on your computer so you can review what happened,
          and that record contains redacted output the agent tool itself produced. Ordinary local file paths and ambient values that a
          command-line tool prints about itself can therefore be retained there. This history stays on your computer, in Interleaf’s local
          database.
        </p>
      </Article>
    </section>
  );
}
