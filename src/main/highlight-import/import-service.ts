import { WorkAdmission } from '../app/work-admission';
import { sourceKey } from './source-key';
import { randomUUID } from 'node:crypto';
import { InterleafError } from '@shared/errors/interleaf-error';
import type { BrowserWindow, OpenDialogOptions, OpenDialogReturnValue } from 'electron';
import type { ExternalHighlightRepository } from '../db/repositories/external-highlight-repository';
import type { ImportCommitInput } from '@shared/schemas/imported-highlight';
import type { ImportPreview, ImportResult } from '@shared/types/imported-highlight';
import type { ImportedSource } from './parser';
import { readImportFile } from './read-import-file';
import { summarizeImport } from './preview-summary';

type OpenDialog = (parent: BrowserWindow | null, options: OpenDialogOptions) => Promise<OpenDialogReturnValue>;
type Pending = { owner: number; expires: number; records: readonly ImportedSource[] };
export class HighlightImportService {
  readonly admission = new WorkAdmission();
  private readonly active = new Set<Promise<ImportPreview | null>>();
  private readonly pending = new Map<string, Pending>();
  private readonly generations = new Map<number, string>();
  constructor(private readonly repository: ExternalHighlightRepository, private readonly choose: OpenDialog) {}
  preview(owner: number, parent: BrowserWindow | null): Promise<ImportPreview | null> {
    const operation = this.admission.run(() => this.previewAdmitted(owner, parent));
    this.active.add(operation);
    void operation.then(() => { this.active.delete(operation); }, () => { this.active.delete(operation); });
    return operation;
  }
  async shutdown(): Promise<void> {
    this.admission.close();
    await Promise.allSettled(this.active);
    this.pending.clear();
    this.generations.clear();
  }
  list(offset: number) {
    this.assertOpen();
    return this.repository.list(offset);
  }
  associate(id: string, documentId: string | null) {
    this.assertOpen();
    return this.repository.associate(id, documentId);
  }
  private assertOpen(): void {
    if (this.admission.isClosed()) throw new InterleafError('internal', 'Application is shutting down.');
  }
  private async previewAdmitted(owner: number, parent: BrowserWindow | null): Promise<ImportPreview | null> {
    for (const [token, pending] of this.pending) if (pending.owner === owner || pending.expires < Date.now()) this.pending.delete(token);
    const generation = randomUUID();
    if (this.generations.size >= 8 || this.pending.size >= 8) throw new InterleafError('validation', 'Too many import previews are open.');
    this.generations.set(owner, generation);
    try {
    const result = await this.choose(parent, { title: 'Import highlights', properties: ['openFile'],
      filters: [{ name: 'Kindle clippings or Readwise highlights', extensions: ['txt', 'csv'] }] });
    if (result.canceled || !result.filePaths[0]) return null;
    const { provider, parsed } = await readImportFile(result.filePaths[0]);
    if (this.generations.get(owner) !== generation) throw new InterleafError('validation', 'The preview was superseded.');
    const summary = summarizeImport(parsed.records, this.repository);
    const token = randomUUID();
    this.pending.set(token, { owner, expires: Date.now() + 15 * 60 * 1000, records: parsed.records });
    return { token, provider, count: parsed.records.length, warnings: parsed.warnings, ...summary };
    } finally {
      if (this.generations.get(owner) === generation) this.generations.delete(owner);
    }
  }
  commit(owner: number, input: ImportCommitInput): ImportResult {
    this.assertOpen();
    const pending = this.pending.get(input.token);
    if (pending?.owner !== owner || pending.expires < Date.now()) throw new InterleafError('validation', 'The import preview expired. Choose the file again.');
    this.pending.delete(input.token);
    this.generations.delete(owner);
    const titles = new Set(pending.records.map((record) => sourceKey(record)));
    const choices = new Map<string, string | null>();
    for (const choice of input.choices) {
      if (!titles.has(choice.key) || choices.has(choice.key)) throw new InterleafError('validation', 'Invalid document selection.');
      choices.set(choice.key, choice.documentId);
    }
    return this.repository.commit(pending.records, choices);
  }
}
