# Security

StatusWeave displays process information and can optionally read local AI CLI sessions and credentials. AI access is disabled until the user completes `statusweave authorize` or explicitly enables a provider for one launch.

## Data flow

| Feature | Local read | Network destination |
|---|---|---|
| System monitor | macOS system commands | None |
| Claude | Keychain credential and `~/.claude` session logs | `api.anthropic.com` |
| Codex | `~/.codex/auth.json` and session logs | `chatgpt.com` |
| Kimi | Local `kimi /status` and session logs | Whatever the installed Kimi CLI normally uses |
| Custom HTTP/command | User-selected config, URL, or command | User-selected destination |

Authenticated custom HTTP providers support one origin-bound Bearer key stored under StatusWeave's fixed macOS Keychain namespace. The provider configuration contains no key and cannot select an arbitrary Keychain service or account. `connect` delegates hidden key entry directly to the macOS `security` prompt, so the key never passes through StatusWeave arguments, environment variables, stdout, or configuration.

Claude, Codex, and Kimi support is an unofficial compatibility integration. Their endpoints and output formats may change without notice.

- Prefer `statusweave authorize <provider>`: login, MFA, account choice, and folder trust remain visible in the official CLI. `--enable-ai` and `STATUSWEAVE_AI_PROVIDERS` are explicit per-launch alternatives.
- Authorization metadata contains provider consent, CLI version, state, and timestamps only. `~/.statusweave` is mode `0700`; `authorization.json` is mode `0600`.
- Each interactive CLI uses a fixed empty directory under `~/.statusweave/cli-probes/`; symlinks are rejected.
- Revoking StatusWeave consent does not revoke the provider CLI's own login or folder trust.
- Enable custom providers explicitly with `STATUSWEAVE_ENABLE_CUSTOM=1`.
- The HTTP server listens on `127.0.0.1` by default.
- Local mode validates the Host header to resist DNS-rebinding access, and refresh requests reject foreign origins.
- Raw credentials and provider responses are never returned by the REST API.
- Authenticated custom endpoints must use HTTPS. The configured origin must still match before StatusWeave reads the provider's dedicated Keychain item.
- Keychain protects against accidental disclosure, not against a process that already controls the same macOS user session.
- Provider HTTP responses are capped at 1 MiB.
- Remote binding with AI/custom providers requires the additional `STATUSWEAVE_ALLOW_REMOTE=1` acknowledgement.
- StatusWeave has no telemetry.

## Reporting a vulnerability

Do not open a public issue for credential exposure, command execution, path traversal, or another security problem. Use [GitHub private vulnerability reporting](https://github.com/IndexFziQ/statusweave/security/advisories/new) and include reproduction steps and the affected version.

Supported versions: the latest `0.1.x` release and `main`.
