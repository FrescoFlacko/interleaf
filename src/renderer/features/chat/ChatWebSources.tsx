import type { ChatWebSource } from '@shared/types/ai';

/**
 * The sources the bound provider's own hosted search returned for one answer.
 *
 * They are rendered from typed metadata, never from the answer's Markdown: the
 * message body is the model's own words, and a webpage title the provider
 * supplied is untrusted text that must not be able to reach it. Presentation
 * mirrors an external link inside an answer — an inert span labelled with its
 * validated host, never an anchor — and the heading keeps them visibly distinct
 * from `[src-*]` chips, which navigate the reader's own document.
 */
export function ChatWebSources({ sources }: { readonly sources: readonly ChatWebSource[] | undefined }) {
  if (!sources || sources.length === 0) return null;
  return (
    <section
      data-testid="chat-web-sources"
      aria-label="Web sources"
      className="space-y-1 border-l-2 border-border pl-2.5 text-xs leading-snug text-text-secondary"
    >
      <p className="text-2xs font-medium">Web sources</p>
      <ul className="space-y-0.5">
        {sources.map((source) => (
          <li key={source.url}>
            <span
              data-testid="chat-web-source"
              data-link-kind="web"
              data-link-host={sourceHost(source.url)}
              title={`External link: ${source.url}`}
              className="break-all underline decoration-dotted"
            >
              {source.title}
              <span data-testid="chat-web-source-host" className="ml-1 whitespace-nowrap text-2xs no-underline">
                ({sourceHost(source.url)})
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Main already rejected anything that is not an absolute http(s) URL. */
function sourceHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'web';
  }
}
