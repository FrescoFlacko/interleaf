# Contributing to Interleaf

Thanks for your interest in improving Interleaf. Bug reports, documentation
fixes and pull requests are welcome.

## Ground rules

- By participating you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).
- Report security vulnerabilities privately as described in
  [SECURITY.md](SECURITY.md), never in a public issue or pull request.
- For anything larger than a small fix, open an issue first so the approach can
  be agreed before you spend time on it.

## How changes are accepted

All changes reach `develop` through pull requests. Every pull request needs an
approving review from the maintainer (see [`.github/CODEOWNERS`](.github/CODEOWNERS))
and passing CI before it can be merged; contributors cannot merge their own
pull requests. Workflows on pull requests from forks run only after the
maintainer approves them.

## Development setup

Requirements: Node.js 22 and npm.

```bash
npm ci
npm run dev
```

Before opening a pull request, run:

```bash
npm run lint
npm run typecheck
npm run test
```

Add focused tests for every defect fix and significant behavior change. Tests
must use the fake providers and CLIs; automated tests never make paid provider
calls. See [docs/TEST_STRATEGY.md](docs/TEST_STRATEGY.md).

## Architecture and security boundaries

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and
[docs/SECURITY.md](docs/SECURITY.md) before changing process boundaries, IPC,
the filesystem, credentials, external content or subprocesses. In short:

- The main process owns the database, filesystem, credentials, native APIs and
  subprocesses.
- The preload is a narrow typed bridge; never expose raw IPC or Node
  primitives.
- The renderer is untrusted UI and receives opaque handles rather than
  privileged paths or secrets.
- Validate IPC at runtime, validate sender/origin where applicable, and return
  typed safe errors.
- Use canonical containment checks; reject traversal and symlink escapes.
- Spawn fixed executables with tokenized argv, `shell: false`, a minimal
  environment, and bounded I/O and time.
- Treat documents, model output, web content and external process output as
  untrusted data.
- Interactive document media (audio, video, embeds, forms, canvas programs and
  similar active content) is permanently unsupported.
- Never log, persist, render or pass credentials outside approved main-owned
  storage and redacted boundaries.

Changes governed by an architecture decision record must follow the applicable
file under [docs/decisions/](docs/decisions/).

## Pull requests

- Keep each pull request focused on one change and describe what it does and
  how you verified it.
- Do not commit secrets, credentials, personal paths or generated build output.
- Version bumps and releases are handled by the maintainer.

## License

Interleaf is licensed under the [Apache License, Version 2.0](LICENSE). By
submitting a contribution you agree that it is licensed under the same terms,
as described in section 5 of the license.
