import { useState } from 'react';
import type { Annotation } from '@shared/types/annotation';
import { NoteComposer, type NoteComposerClose } from '../../components/note/NoteComposer';
import { NOTE_SAVE_SHORTCUT_HINT, handleNoteSaveShortcut } from '../../hooks/note-save-shortcut';
import { updateNoteText } from '../../hooks/note-persistence';
import { noteDraftKeyForAnnotation } from '../../hooks/note-drafts';
import { useAnnotationStore } from '../../stores/use-annotation-store';

type AnnotationInlineEditorProps = {
  readonly annotation: Annotation;
  /** "Note · Page 3": the row's own metadata, shown on the note's context line. */
  readonly context: string;
  readonly onClose: (close: NoteComposerClose) => void;
};

/**
 * The Annotations panel's inline editor for one row.
 *
 * A note's text, or a highlight's note, is edited in the autosaving note
 * composer with the row's real metadata and quote. Emptying a highlight's note
 * clears it; a note annotation is its text, so it cannot be emptied here (it is
 * deleted from the row menu instead). Every editor of one annotation continues
 * the same draft, so leaving a row while it saves and coming back writes in
 * order and shows the newest text. A bookmark's label keeps its explicit
 * Save and Cancel, since a label is a short name rather than a note.
 */
export function AnnotationInlineEditor({ annotation, context, onClose }: AnnotationInlineEditorProps) {
  if (annotation.type === 'bookmark') return <BookmarkLabelEditor annotation={annotation} onClose={onClose} />;
  return (
    <NoteComposer
      fieldId={`annotation-edit-${annotation.id}`}
      label="Note text"
      context={context}
      contextIcon="add-note"
      quote={annotation.selectedText}
      variant="inline"
      role="group"
      testIdPrefix="annotation-edit"
      draftKey={noteDraftKeyForAnnotation(annotation.id)}
      documentId={annotation.documentId}
      autosave={{
        initialText: annotation.note ?? '',
        initialId: annotation.id,
        allowEmpty: annotation.type === 'highlight',
        persist: updateNoteText(annotation.documentId),
      }}
      onClose={onClose}
    />
  );
}

/** The bookmark label editor, unchanged in behaviour: an empty label clears it. */
function BookmarkLabelEditor({ annotation, onClose }: Pick<AnnotationInlineEditorProps, 'annotation' | 'onClose'>) {
  const update = useAnnotationStore((state) => state.update);
  const [draft, setDraft] = useState(annotation.label ?? '');
  // Shared by the Save button and the Cmd/Ctrl+Enter shortcut so a second
  // press while the update is in flight cannot write the edit twice.
  const [saving, setSaving] = useState(false);

  const save = async (): Promise<void> => {
    if (saving) return;
    const trimmed = draft.trim();
    setSaving(true);
    const result = await update({
      documentId: annotation.documentId,
      id: annotation.id,
      label: trimmed.length > 0 ? trimmed : null,
    }).finally(() => { setSaving(false); });
    if (result) onClose({ reason: 'done', annotationId: annotation.id });
  };

  return (
    <div>
      <label htmlFor={`annotation-edit-${annotation.id}`} className="text-2xs font-medium text-text-secondary">
        Bookmark label
      </label>
      <textarea
        id={`annotation-edit-${annotation.id}`}
        autoFocus
        maxLength={500}
        value={draft}
        onChange={(event) => { setDraft(event.target.value); }}
        onKeyDown={(event) => {
          handleNoteSaveShortcut(event, !saving, () => { void save(); });
        }}
        className="mt-1 h-20 w-full resize-y rounded-md border border-border-subtle bg-bg-primary p-2 text-xs text-text-primary"
      />
      <div className="mt-1 flex items-center justify-end gap-2">
        <span className="mr-auto text-2xs text-text-secondary" data-testid="annotation-edit-shortcut-hint">
          {NOTE_SAVE_SHORTCUT_HINT}
        </span>
        <button
          type="button"
          onClick={() => { onClose({ reason: 'close', annotationId: annotation.id }); }}
          className="rounded px-2 py-1 text-xs text-text-secondary"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={() => { void save(); }}
          className="rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}
