// Deterministic child-process fixture for Agent Runtime tests. It is invoked
// with argv arrays by ProcessRunner (never through a shell).
const args = process.argv.slice(2);
if (args.includes('--fork-stubborn')) {
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const stubborn = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.on('SIGINT', () => {}); setInterval(() => {}, 1000);"], { stdio: 'ignore' });
  if (process.env.STUBBORN_PID_FILE !== undefined && stubborn.pid !== undefined) writeFileSync(process.env.STUBBORN_PID_FILE, String(stubborn.pid), { encoding: 'utf8', mode: 0o600 });
  process.on('SIGTERM', () => process.exit(0));
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  process.exit(0);
}
if (args.includes('--mutate-workspace')) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile('interleaf-fixture-change.txt', 'Deterministic fake agent change\n', { encoding: 'utf8', mode: 0o644 });
}
let stdinText = '';
if (args.includes('--read-stdin')) {
  for await (const chunk of process.stdin) stdinText += chunk.toString('utf8');
}
const prompt = [args.filter((arg) => arg !== '--read-stdin').join(' '), stdinText].filter(Boolean).join(' | ');
if (args.includes('--ignore-termination')) {
  const { stderr } = process;
  process.on('SIGTERM', () => stderr.write('fixture ignored SIGTERM\n'));
  // Readiness handshake. Until this handler is installed the default SIGTERM
  // disposition still applies, so a parent that cancels earlier would kill the
  // child outright and never exercise the escalation/reaping path. Tests wait
  // for this marker instead of guessing a startup delay.
  stderr.write('fixture ready: ignoring termination\n');
}
if (args.includes('--env-check')) process.stdout.write(`env:${process.env.INTERLEAF_SECRET ?? 'unset'}\n`);
if (args.includes('--echo-path-context')) {
  const temp = process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? '';
  process.stdout.write(`cwd=${process.cwd()} file=${process.execPath} home=${process.env.HOME ?? ''} temp=${temp} path=${process.env.PATH ?? ''}\n`);
  process.stdout.write(`${JSON.stringify({ type: 'path-context', cwd: process.cwd(), file: process.execPath, home: process.env.HOME ?? '', temp, path: process.env.PATH ?? '' })}\n`);
}
if (args.includes('--unicode')) {
  const unicode = Buffer.from('unicode 😀 boundary\n', 'utf8');
  process.stdout.write(unicode.subarray(0, 10));
  process.stdout.write(unicode.subarray(10));
}
if (args.includes('--partial-json')) {
  process.stdout.write('{"type":"partial');
  await new Promise((resolve) => setTimeout(resolve, 10));
  process.stdout.write('","ok":true}\n');
  process.stdout.write('{"type":"second","ok":true}\n');
}
if (args.includes('--large')) process.stdout.write('x'.repeat(2_100_000));
process.stdout.write(`fixture stdout: ${prompt}\n`);
process.stderr.write('fixture stderr\n');
process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: 'fake-thread-1234' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'progress', message: 'fixture structured output' })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'changed-files', files: [args.includes('--mutate-workspace') ? 'interleaf-fixture-change.txt' : 'fixture.txt'] })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'tests', status: 'passed', count: 1 })}\n`);
// A prompt carrying the diagram marker gets Markdown output with fenced Mermaid
// diagrams, so diagram rendering in Agent output can be exercised offline.
const DIAGRAM_MESSAGE = ['Mapped the excerpt:', '', '```mermaid', 'flowchart LR', '  Q[Query] --> A[Attention]', '  A --> O[Output]', '```'].join('\n');
const DIAGRAM_REPORT = ['## Fixture report', '', 'The run produced this sequence:', '', '```mermaid', 'sequenceDiagram', '  participant R as Reader', '  participant A as Agent', '  R->>A: Summarise excerpt', '  A-->>R: Report', '```', '', 'And a code sample:', '', '```text', 'fixture code', '```'].join('\n');
const closing = prompt.includes('e2e-pele-diagrams') ? [{ type: 'agent_message', text: DIAGRAM_MESSAGE }, { type: 'final', text: DIAGRAM_REPORT }] : [{ type: 'final', text: 'fixture final report' }];
process.stdout.write(closing.map((event) => `${JSON.stringify(event)}\n`).join(''));
if (args.includes('--sleep')) await new Promise((resolve) => setTimeout(resolve, 5_000));
if (args.includes('--fail')) process.exitCode = 7;
else process.stdout.write('fixture final\n');
