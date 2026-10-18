/**
 * Separately killable child for the synchronous ZIP64 archive regression.
 *
 * `inflateZipArchive` is synchronous, so a malformed archive that made the
 * parser loop would block the whole Vitest worker and a test timeout declared
 * inside that worker could never fire. Running one archive per child process
 * moves the bound to the parent, which can terminate a blocked child outright.
 *
 * Invoked as `node --import tests/fixtures/ts-extension-hooks.ts
 * tests/fixtures/zip-inflate-child.ts <inflate|hang>`, never through a shell.
 * In `inflate` mode the archive bytes arrive on stdin and one JSON result line
 * is written to stdout. In `hang` mode the child deliberately
 * never returns, so a test can prove the parent's deadline is what ends it.
 */
const mode = process.argv[2];

if (mode === 'hang') {
  process.stdout.write(`${JSON.stringify({ outcome: 'hanging' })}\n`);
  // Deliberately unyielding, standing in for a parser that never terminates:
  // no timer, signal handler, or in-process timeout can interrupt this loop, so
  // only the parent's deadline can end the run.
  for (;;) {
    /* spin */
  }
}

if (mode !== 'inflate') {
  process.stderr.write(`unknown mode: ${String(mode)}\n`);
  process.exit(2);
}

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
const archive = new Uint8Array(Buffer.concat(chunks));

const { inflateZipArchive } = await import(
  '../../src/renderer/features/reader/adapters/foliate/zip-inflate-core'
);

try {
  const entries = inflateZipArchive(archive);
  process.stdout.write(
    `${JSON.stringify({ outcome: 'returned', filenames: entries.map((entry) => entry.filename) })}\n`
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ outcome: 'threw', message: error instanceof Error ? error.message : String(error) })}\n`
  );
}
