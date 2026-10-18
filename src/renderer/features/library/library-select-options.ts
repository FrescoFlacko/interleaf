import type { DocumentFormat, DocumentSortOption } from '@shared/types/document';
import type { SelectOption } from '../../components/ui/select-model';

export const FORMAT_FILTER_OPTIONS: readonly SelectOption<DocumentFormat | 'all'>[] = [
  { value: 'all', label: 'All Formats' },
  { value: 'pdf', label: 'PDF' },
  { value: 'epub', label: 'EPUB' },
  { value: 'mobi', label: 'MOBI / AZW' },
  { value: 'docx', label: 'DOCX' },
  { value: 'pptx', label: 'PowerPoint' },
  { value: 'markdown', label: 'Markdown' },
];

export const SORT_OPTIONS: readonly SelectOption<DocumentSortOption>[] = [
  { value: 'recent_added', label: 'Recently Added' },
  { value: 'recent_read', label: 'Recently Read' },
  { value: 'title_asc', label: 'Title (A-Z)' },
  { value: 'title_desc', label: 'Title (Z-A)' },
  { value: 'author_asc', label: 'Author (A-Z)' },
];
