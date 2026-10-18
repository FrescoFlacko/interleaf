import { buildCliSearchPath } from '../app/cli-search-path';

export function buildMinimalChildEnvironment(extra?: Readonly<Record<string, string>>, clear?: readonly string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const allowed = ['PATH', 'HOME', 'USER', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'LANG', 'LC_ALL', 'XDG_CONFIG_HOME', 'TERM', 'SHELL', 'COMSPEC', 'PATHEXT'] as const;
  for (const key of allowed) {
    const value = key === 'PATH' ? buildCliSearchPath() : process.env[key];
    if (value !== undefined) env[key] = value;
  }
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (isSafeEnvironmentName(key) && Buffer.byteLength(value, 'utf8') <= 1024) env[key] = value;
    }
  }
  for (const key of clear ?? []) {
    if (allowed.includes(key as (typeof allowed)[number])) env[key] = undefined;
  }
  return env;
}

/** Defense in depth for main-owned profile overrides. Secret-bearing names
 * are rejected even if a caller bypasses the shared request schema. */
function isSafeEnvironmentName(key: string): boolean {
  return /^[A-Z_][A-Z0-9_]{0,63}$/u.test(key) && !/(API|AUTH|BASH_ENV|BEARER|CERT|COOKIE|CREDENTIAL|ENV|KEY|LD_PRELOAD|NODE_OPTIONS|PASS(?:WORD|WD)?|PERL5OPT|PRIVATE|PYTHONPATH|RUBYOPT|SECRET|TOKEN|AWS|AZURE|GITHUB|GOOGLE|CLAUDE|ANTHROPIC|OPENROUTER|SSH|DYLD)/iu.test(key);
}
