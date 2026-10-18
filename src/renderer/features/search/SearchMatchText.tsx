import { Fragment } from 'react';
import { splitTextBySearchTerms } from '@shared/search/text-match';

/**
 * Renders document-derived text with the exact matching tokens marked.
 *
 * The text is untrusted document content, so it is only ever emitted as React
 * text children — the component never touches `dangerouslySetInnerHTML`, and
 * the segment boundaries come from offsets into the string rather than from any
 * markup inside it. The mark relation is the shared exact whole-token one, so a
 * card paints exactly the words the in-document highlight paints.
 */
export function SearchMatchText(props: {
  readonly text: string;
  readonly query: string;
  readonly className?: string;
  readonly testId: string;
}) {
  const segments = splitTextBySearchTerms(props.text, props.query);
  return (
    <span className={props.className} data-testid={props.testId}>
      {/* Index keys are stable here: the segments are positional slices of one
          immutable string, never reordered or edited in place. */}
      {segments.map((segment, index) =>
        segment.isMatch
          ? <mark key={index} className="search-term-mark">{segment.text}</mark>
          : <Fragment key={index}>{segment.text}</Fragment>
      )}
    </span>
  );
}
