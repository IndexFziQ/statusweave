<div align="center">
  <img src="docs/logo/logo-dark.png" width="120" alt="StatusWeave logo">
  <h1>StatusWeave</h1>
  <p><strong>See your AI coding usage and your Mac's health in one local dashboard.</strong></p>
  <p>MIT · Local-first · macOS</p>
  <p>
    <img src="https://img.shields.io/badge/platform-macOS-a78bfa" alt="platform">
    <img src="https://img.shields.io/badge/node-%3E%3D18-34d399" alt="node">
    <img src="https://img.shields.io/badge/license-MIT-fbbf24" alt="license">
    <img src="https://img.shields.io/badge/dependencies-0-f472b6" alt="zero dependencies">
  </p>
  <p>English · <a href="./README.zh-CN.md">中文文档</a></p>
</div>

![StatusWeave demo](docs/demo/statusweave-demo.gif)

_Demo uses synthetic data._

```bash
npx statusweave
```

That's it. StatusWeave starts a local server and opens `http://127.0.0.1:8787`. Mac system monitoring works immediately—no AI account required. Add `--no-open` when you do not want it to open a browser.

Requires macOS and Node.js 18+. Zero runtime dependencies.

## What you get

- **AI coding usage** — plan-limit windows and local token statistics for Claude Code, Codex, and Kimi, read from CLIs already installed and logged in on your Mac, only after your explicit authorization
- **Mac system status** — per-core CPU, memory, swap, disk, load, Apple Silicon GPU, app-memory breakdown, and top processes
- **Pixel dark/light dashboard** — follows macOS appearance, remembers your choice, and supports English and Chinese
- **Local read-only REST API** — JSON metrics for coding agents and other local apps; binds to `127.0.0.1` by default
- **Terminal console** — interactive TUI plus one-shot, ASCII, and JSON modes

> **Provider support is unofficial.** StatusWeave is not affiliated with, endorsed by, or supported by Anthropic, OpenAI, or Moonshot AI. Availability and accuracy depend on each provider's current CLI and may break without notice. Do not rely on these numbers for billing decisions.

## Add AI usage monitoring

System monitoring needs no setup. To add AI usage, authorize only the providers you actually use:

```bash
npx statusweave authorize claude,codex,kimi
npx statusweave
```

The one-time setup opens each selected CLI in a visible terminal:

- **Claude Code** — run `/usage`, confirm that usage is visible, exit, then answer `y`
- **Kimi** — run `/status`, confirm that usage is visible, exit, then answer `y`
- **Codex** — completes automatically after structured verification succeeds

Existing CLI logins are reused. If login, MFA, account selection, folder Trust, or a `[y/N]` prompt is required, you complete it personally. Authorized providers are enabled automatically on later launches.

```bash
npx statusweave authorize --status      # check setup state
npx statusweave authorize --reset kimi  # revoke consent without logging out Kimi
```

StatusWeave does not turn an arbitrary API key into subscription-limit data. Only the providers and flows documented here are supported.

## Install with a coding agent

Paste this into Claude Code, Codex, Kimi, or another coding agent:

> Install StatusWeave from https://github.com/IndexFziQ/statusweave. Read AGENT_INSTALL.md first, then check the environment, run the documented npm installation, detect Claude Code/Codex/Kimi, complete monitoring setup, launch, and verify. Reuse valid CLI logins. If login, MFA, account selection, folder Trust, or a terminal `[y/N]` confirmation is required, stop and hand that interaction to me personally; never answer it for me. Never print or upload credentials in chat, logs, or to non-provider domains. When finished, open http://127.0.0.1:8787 and report the real status of each supported provider.

The agent may inspect the environment, install, launch, and verify. It must not log in to your accounts or answer authorization prompts for you.

## Privacy

- **Local-first, no telemetry.** System metrics, local usage history, and dashboard data stay on your Mac.
- **AI providers are off by default.** Authorization stores only consent metadata with private file permissions—never passwords, API keys, OAuth tokens, or terminal transcripts.
- **Credentials stay scoped.** Claude and Codex tokens are sent only to their respective service endpoints; Kimi status is obtained through the installed Kimi CLI and follows that CLI's normal network behavior. Raw credentials are never returned by the local API.
- **Loopback only by default.** The server binds to `127.0.0.1`, rejects non-loopback Host headers, and ships with CORS off.
- Data-flow details and vulnerability reporting: [`SECURITY.md`](.github/SECURITY.md).

## REST API

The same data behind the dashboard is available to agents and local apps:

```bash
curl -s http://127.0.0.1:8787/api/stats | jq .cpu.overall
curl -s http://127.0.0.1:8787/api/usage | jq '.providers[0].plan'
```

| Endpoint | Content |
|---|---|
| `GET /api/stats` | Combined CPU, memory, swap, disk, load, process, app, and AI usage metrics |
| `GET /api/usage` | Supported AI provider usage |
| `GET /api/health` | Service health and enabled providers |

## Other ways to run

**Global install** also provides the `statusweave-cli` terminal console:

```bash
npm install -g statusweave
statusweave
statusweave-cli --once --json
```

**From source:**

```bash
git clone https://github.com/IndexFziQ/statusweave.git
cd statusweave
node src/statusweave.js
```

**Floating window / DMG** is an unsigned Apple-silicon beta companion. It does not start the monitor service itself, and Gatekeeper may block it, so `npx statusweave` remains the recommended entry point.

[Download StatusWeave for macOS (arm64, unsigned beta)](https://github.com/IndexFziQ/statusweave/releases/latest/download/StatusWeave-macOS-arm64.dmg)

Keep the local monitor running before opening the app:

```bash
npx statusweave
```

Then mount the DMG, drag `StatusWeave.app` to Applications, and try opening it. If macOS blocks the unsigned beta, go to **System Settings → Privacy & Security** and choose **Open Anyway**. To build the companion and DMG from source with Xcode Command Line Tools:

```bash
bash scripts/build-dmg.sh
```

## Stop and uninstall

- `npx statusweave`: press `Ctrl+C` in the terminal that started it.
- Global install: stop the process, then run `npm uninstall -g statusweave`.
- Source install: stop the process, then delete the cloned folder.

Optional local state lives in `~/.statusweave/`; review it before deleting it. Uninstalling does not log out any provider CLI. Revoke monitoring consent first with `statusweave authorize --reset <provider>` if desired.

## Contributing

Issues and pull requests are welcome—see [`CONTRIBUTING.md`](.github/CONTRIBUTING.md). Please report security problems through [GitHub private vulnerability reporting](https://github.com/IndexFziQ/statusweave/security/advisories/new), not public issues.

## License

[MIT](LICENSE)
