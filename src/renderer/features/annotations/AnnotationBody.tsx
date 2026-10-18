import type { Annotation } from '@shared/types/annotation';
import { MarkdownContent } from '../../components/markdown/MarkdownContent';
import { ANNOTATION_ROW_PRIMARY_TEXT } from './annotation-row-styles';

/**
 * Saved body of one annotation.
 *
 * A note body is stored verbatim and is frequently Markdown source — an AI Chat
 * answer saved as a note keeps its original text — so it renders through the
 * shared safe token renderer rather than as literal syntax. Editing still loads
 * and saves that same raw source. A bookmark label is a short title, not a note
 * body, and stays plain text.
 *
 * The body is never clamped: a long note grows its row until all of it is
 * readable, because a note the reader wrote is the row, not a preview of it.
 */
export function AnnotationBody({ annotation }: { readonly annotation: Annotation }) {
  if (annotation.note !== null) {
    return (
      <div className={ANNOTATION_ROW_PRIMARY_TEXT} data-testid="annotation-note-body">
        <MarkdownContent content={annotation.note} />
      </div>
    );
  }
  if (annotation.label === null) return null;
  return <p className={`whitespace-pre-wrap ${ANNOTATION_ROW_PRIMARY_TEXT}`}>{annotation.label}</p>;
}
