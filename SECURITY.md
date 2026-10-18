# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues,
discussions or pull requests.

Report them privately through GitHub's
[private vulnerability reporting](https://github.com/FrescoFlacko/interleaf/security/advisories/new)
("Report a vulnerability" on the repository's **Security** tab). Include:

- the affected version or commit;
- the platform (macOS, Windows or Linux) and how Interleaf was installed;
- steps to reproduce, a proof of concept, or a sample document if relevant;
- the impact you believe it has.

You should receive an acknowledgement within a few days. Please give the
maintainer a reasonable time to release a fix before any public disclosure.

## Supported versions

Interleaf is pre-1.0. Only the latest release, and the `develop` branch, receive
security fixes.

## Scope

Interleaf opens untrusted documents and web content and can launch local agent
CLIs, so reports about these boundaries are especially welcome: IPC and preload
exposure, path traversal or symlink escapes, credential handling, document or
web-content sanitization, prompt injection that crosses a privilege boundary,
agent workspace isolation, and update-manifest trust.

## Security architecture

The threat model, controls and their automated verification are described in
[docs/SECURITY.md](docs/SECURITY.md).
