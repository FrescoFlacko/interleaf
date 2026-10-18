/**
 * Where "Installation help" sends the reader.
 *
 * One fixed external link per integration, opened through the existing
 * `app:open-external` boundary — Interleaf never downloads anything and never
 * runs a command on the user's behalf. A row only offers this when absence is
 * actually established, so `copilot` is deliberately absent from this table:
 * its unavailability is a product decision, not evidence that a binary is
 * missing (§4 rule 6).
 *
 * `cursor` is Agent-Mode-only like `opencode`, but it is still detected by
 * resolving `cursor-agent`, so a missing binary is established absence and the
 * link is offered.
 *
 * Each destination was requested during implementation and answered HTTP 200
 * (checked 2026-09-15; the `cursor` entry 2026-09-17). `pi` and `omp` publish
 * no documentation site, so their entries are the homepage recorded in the
 * installed package's own metadata (`@earendil-works/pi-coding-agent`,
 * `@oh-my-pi/omp-stats`) rather than a URL recalled from memory.
 */
const INSTALLATION_HELP_LINKS: Readonly<Record<string, string | undefined>> = {
  codex: 'https://developers.openai.com/codex/cli/',
  'claude-code': 'https://docs.claude.com/en/docs/claude-code/setup',
  antigravity: 'https://antigravity.google/docs',
  opencode: 'https://opencode.ai/docs/',
  cursor: 'https://docs.cursor.com/en/cli/overview',
  pi: 'https://github.com/earendil-works/pi',
  omp: 'https://omp.sh',
};

export function installationHelpUrl(rowId: string): string | null {
  return INSTALLATION_HELP_LINKS[rowId] ?? null;
}
