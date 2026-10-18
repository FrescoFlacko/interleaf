import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

// Architecture boundary bans. Each names its sanctioned home (`allowed`): the
// one module that owns the banned primitive. Every other file in scope is
// checked; there are no whole-file exemptions. A new exception must be a single
// explicit file with a one-line reason beside it. Changing this file changes
// the quality gate's measurement identity, so edits are a separately reviewed
// policy work unit.
const MAIN_PROCESS = ['src/main/**/*.ts', 'src/preload/**/*.ts'];
const RENDERER = ['src/renderer/**/*.{ts,tsx}'];
const boundaryBans = [
  {
    scope: MAIN_PROCESS,
    allowed: ['src/main/security/path-guard.ts'],
    imports: ['node:path', 'path'].map((name) => ({
      name,
      importNames: ['relative'],
      message: 'Use the canonical containment helpers in src/main/security/path-guard.ts instead of path.relative checks.',
    })),
    // The property name `relative` is reserved in main/preload whatever the
    // receiver: calls, method references, computed access and destructuring of
    // path aliases, namespaces and dynamic imports are all caught. Unrelated
    // objects with a `relative` member are also rejected; rename such members.
    syntax: [
      "MemberExpression[property.name='relative']",
      "MemberExpression[computed=true][property.value='relative']",
      "ObjectPattern > Property[key.name='relative']",
      "ObjectPattern > Property[key.value='relative']",
    ].map((selector) => ({
      selector,
      message: 'Use the canonical containment helpers in src/main/security/path-guard.ts instead of path.relative checks.',
    })),
  },
  {
    scope: MAIN_PROCESS,
    allowed: ['src/main/agents/process-runner.ts'],
    imports: ['node:child_process', 'child_process'].map((name) => ({
      name,
      allowTypeImports: true,
      message: 'Spawn subprocesses through src/main/agents/process-runner.ts (fixed executable, tokenized argv, shell: false, bounded I/O).',
    })),
    syntax: [
      {
        selector: "ImportExpression[source.value=/^(node:)?child_process$/]",
        message: 'Spawn subprocesses through src/main/agents/process-runner.ts (fixed executable, tokenized argv, shell: false, bounded I/O).',
      },
    ],
  },
  {
    scope: RENDERER,
    allowed: ['src/renderer/app/api-client.ts'],
    imports: [],
    syntax: [
      // Any receiver: aliases of window (const w = window; w.interleafAPI) are covered.
      "MemberExpression[property.name='interleafAPI']",
      "MemberExpression[computed=true][property.value='interleafAPI']",
      "ObjectPattern > Property[key.name='interleafAPI']",
    ].map((selector) => ({
      selector,
      message: 'Reach main only through `bridge` from src/renderer/app/api-client.ts.',
    })),
  },
];

// Ambiguous types are banned outright: every value that crosses a module,
// process, storage or provider boundary must be described by a precise
// named model. Implicit catch-variable `unknown` is unaffected because it
// writes no keyword. Boundary configs below also set `no-restricted-syntax`,
// so they carry these selectors too rather than replacing them.
const unsafeTypeSyntax = [
  {
    selector: 'TSAnyKeyword',
    message:
      'Explicit `any` is not allowed. Declare the precise named model the value actually has (see docs/ARCHITECTURE.md "Type and model ownership"), or derive it from the owning schema (for example `z.input<typeof schema>`).',
  },
  {
    selector: 'TSUnknownKeyword',
    message:
      'Explicit `unknown` is not allowed. Declare the precise named model the value actually has (see docs/ARCHITECTURE.md "Type and model ownership"), derive it from the owning schema (for example `z.input<typeof schema>`), or accept `PortableValue` from `@shared/models/portable` at a not-yet-validated boundary.',
  },
];

// Flat config replaces, rather than merges, a rule's options when a later
// object matches the same file. Emit one object per scope carrying every ban,
// then one per exempt pattern carrying only the bans that do not exempt it.
function boundaryRules(bans) {
  const imports = bans.flatMap((ban) => ban.imports);
  const syntax = bans.flatMap((ban) => ban.syntax);
  return {
    '@typescript-eslint/no-restricted-imports': imports.length ? ['error', { paths: imports }] : 'off',
    'no-restricted-syntax': ['error', ...unsafeTypeSyntax, ...syntax],
  };
}

function boundaryConfigs(bans) {
  const scopes = [...new Set(bans.map((ban) => ban.scope))];
  return scopes.flatMap((scope) => {
    const scoped = bans.filter((ban) => ban.scope === scope);
    const exempt = [...new Set(scoped.flatMap((ban) => ban.allowed))];
    return [
      { files: scope, rules: boundaryRules(scoped) },
      ...exempt.map((pattern) => ({
        files: [pattern],
        rules: boundaryRules(scoped.filter((ban) => !ban.allowed.includes(pattern))),
      })),
    ];
  });
}

export default tseslint.config(
  {
    ignores: [
      // Generated, tool-owned and nested-checkout directories. This list mirrors
      // SKIP_DIRS in scripts/quality/gate.py, which the quality gate already
      // passes to the code scanner as `**/<name>/**`; the gate runs `eslint .`
      // with no exclude arguments, so ESLint's coverage is defined here alone.
      // Matching at any depth keeps the two inventories identical. Nested Git
      // worktrees under .worktrees/ are whole duplicate checkouts: leaving them
      // lintable made a root run enumerate every copy and, because they fall
      // outside the root tsconfig, made projectService open a separate
      // TypeScript program per checkout until the default heap was exhausted.
      '**/.agents/**',
      '**/.firecrawl/**',
      '**/.git/**',
      '**/.interleaf/**',
      // Legacy app-owned marker directory written before the Interleaf rename.
      '**/.marginlab/**',
      '**/.vite/**',
      '**/.worktrees/**',
      '**/__pycache__/**',
      '**/build/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/out/**',
      '**/playwright-report/**',
      '**/release/**',
      '**/test-results/**',
      // User-provided design/reference exports, outside the application source.
      // Only these exact names are excluded; unlisted siblings stay covered.
      '**/AI Chat UI Redesign/**',
      '**/AI Chat UI Redesign (1)/**',
      '**/AI Chat UI Redesign (2)/**',
      '**/AI Chat UI Redesign (5)/**',
      // Exact audited upstream JavaScript only. The ignore stops at `.js`: the
      // hand-written declarations that describe that code are Interleaf's own
      // TypeScript and are linted like every other module, so an ambient
      // declaration cannot become a hiding place for a banned keyword.
      'src/renderer/features/reader/adapters/foliate/upstream/**/*.js',
      'tests/fixtures/fake-agent-cli.mjs',
      'eslint.config.mjs',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-definitions': ['error', 'type'],
      '@typescript-eslint/no-unsafe-type-assertion': 'off',
      '@typescript-eslint/no-invalid-void-type': [
        'error',
        { allowInGenericTypeArguments: true },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-restricted-syntax': ['error', ...unsafeTypeSyntax],
    },
  },
  {
    files: ['**/*.tsx', 'src/renderer/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  ...boundaryConfigs(boundaryBans),
  {
    // Test files may assert on non-null contracts and use loose test doubles.
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  }
);
