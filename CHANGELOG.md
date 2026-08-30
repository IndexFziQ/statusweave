# Changelog

All notable changes are documented here.

## Unreleased

## 0.1.0 — 2026-08-30

### Changed

- Added persistent Dark and Light pixel-HUD themes to the local dashboard and project website.
- Clarified npm-first installation, optional AI authorization, unofficial provider compatibility, and current delivery status.
- Redesigned the project website as a responsive pixel-console interface and clarified agent-assisted installation and delivery status.
- Renamed the project, npm package, CLI commands, environment variables, config directory, macOS app, documentation, and website to StatusWeave.
- Refined the local dashboard into the StatusWeave “Loom” visual system: calmer one-pixel data surfaces, responsive KPI rows, persistent mobile detail, stronger AI usage hierarchy, actionable setup cards, and explicit stale-connection treatment.
- Upgraded shared design tokens to v2 and aligned the terminal console with healthy-green connections, rounded Unicode frames, truecolor output, wider adaptive meters, and width-aware process density.
- Authorized AI providers now remain enabled on later launches while their official CLI login stays valid; unavailable plan-limit data is distinguished from local usage totals.
- Authorization now reuses valid CLI sessions, opens the provider's explicit login command only when needed, and labels monitoring setup separately from an expired CLI login.
- Local dashboard assets use `Cache-Control: no-store` so a restarted server does not leave stale setup instructions in the browser.
- Local dashboards now pick up completed authorization and revocation on the next usage refresh without restarting; incomplete interactive setup is never auto-enabled.

### Security

- AI credential and session access is now disabled by default and requires an explicit provider allowlist.
- Custom providers require explicit opt-in.
- Remote binding with AI/custom providers requires an additional acknowledgement.
- Custom command failures no longer expose child-process error text.
- Dashboard values from processes and custom providers are HTML-escaped.
- Local HTTP requests now validate Host and refresh Origin values to resist DNS rebinding and cross-site triggers.
- Static-file paths are decoded and confined to the public directory.
- Provider responses are capped at 1 MiB and Kimi executable paths are shell-quoted.
- CLI-monitoring consent is stored as metadata only in a mode-`0600` file, with mode-`0700` provider probe directories and symlink rejection.
- Failed Kimi pseudo-terminal captures are no longer copied to a persistent debug transcript.

### Added

- A script-built, ad-hoc-signed Apple-silicon DMG for the unsigned floating-window companion app.
- Added an optional, local-only first-run link for voluntary installation reports; no report is sent automatically.
- Added installation-report and provider-compatibility issue templates plus a UI/provider verification checklist for pull requests.
- Structured Claude/Codex/Kimi install and authentication states with safe manual-login actions.
- A visible `statusweave authorize` flow for one-time official CLI login, folder trust, usage-screen verification, status inspection, and consent revocation.
- Step-by-step Chinese and English onboarding, provider-specific authorization guidance, refresh instructions, troubleshooting FAQ, and a copy-paste coding-agent installation request.
- Interactive HTTPS JSON Bearer-provider connect/disconnect commands backed by an origin-bound macOS Keychain item.
- Agent-friendly `doctor`, `detect`, `launch`, and `verify` commands for a one-sentence local setup flow.
- A shared installation contract for Claude Code, Codex, Kimi, and other coding agents.
- Node built-in tests for provider opt-in and usage-response parsing.
- npm trusted-publishing release workflow.
- An npm-first launch flow, security documentation, and contribution guidance.
- Security and contribution documentation.
