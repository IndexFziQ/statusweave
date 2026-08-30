# Install StatusWeave with an AI coding agent

This file is the stable installation contract for Claude Code, Codex, Kimi, and other coding agents.

## User request

> Install StatusWeave from https://github.com/IndexFziQ/statusweave. Read AGENT_INSTALL.md first, then check the environment, run the documented npm installation, detect Claude Code/Codex/Kimi, complete monitoring setup, launch, and verify. Reuse valid CLI logins. If login, MFA, account selection, folder Trust, or a terminal `[y/N]` confirmation is required, stop and hand that interaction to me personally; never answer it for me. Never print or upload credentials in chat, logs, or to non-provider domains. When finished, open http://127.0.0.1:8787 and report the real status of each supported provider.

Chinese:

> 请从 https://github.com/IndexFziQ/statusweave 安装 StatusWeave。先阅读 AGENT_INSTALL.md，再按文档检查环境、执行 npm 安装、检测 Claude Code/Codex/Kimi、完成监控设置、启动并验证。已有的 CLI 登录直接复用；如果需要登录、MFA、账号选择、目录 Trust，或者终端出现 `[y/N]` 确认，必须停下来交给我本人操作，不要替我回答。不要在对话、日志或非官方域名中输出或上传凭据。完成后打开 http://127.0.0.1:8787，并报告每个受支持 provider 的真实状态。

## Agent procedure

1. Require macOS and Node.js 18 or newer. Git is optional for npm installation.
2. Do not clone the repository unless the user explicitly requests a source install. Use the published npm package for the normal path.
3. Run these read-only checks:

   ```bash
   npx --yes statusweave@latest doctor --json
   npx --yes statusweave@latest detect --json
   ```

4. Continue only when `doctor.ok` is `true`. For every requested provider, inspect `installState`, `authState`, and `nextAction`:

   - `authState: ready`: continue.
   - `authState: credentialPresent`: explain that local credential metadata exists but the login was not independently verified.
   - `notLoggedIn`, `expired`, or `unknown`: show `nextAction.command` when present and stop. The user must complete the provider's official login flow personally.

5. Ask the user to complete visible one-time monitoring setup for only the providers they use:

   ```bash
   npx --yes statusweave@latest authorize claude,codex,kimi
   ```

   Existing CLI logins are reused. The user personally completes login, MFA, account selection, folder Trust, and every `[y/N]` confirmation. For Claude Code the user runs `/usage`, exits, and answers `y`; for Kimi the user runs `/status`, exits, and answers `y`; Codex completes after structured verification succeeds. Never answer those prompts on the user's behalf. If the agent cannot provide a real interactive terminal, show the command and wait.

6. Start the local monitor after setup succeeds:

   ```bash
   npx --yes statusweave@latest launch --providers claude,codex,kimi --json
   ```

   Omit providers the user does not have or did not authorize. System monitoring also works without any AI provider:

   ```bash
   npx statusweave
   ```

7. Verify without printing provider responses or credentials:

   ```bash
   npx --yes statusweave@latest verify --providers claude,codex,kimi --json
   ```

8. Report the local URL and the real state of each requested provider. If detection, authorization, launch, or verification fails, report the returned reason and stop. Do not guess, request elevated privileges, modify provider configuration, or substitute another data source.

## Custom HTTPS JSON API

An agent may help determine a non-secret provider ID, display name, metric kind, and JSON path. It must never ask the user to paste an API key into the conversation or pass one through arguments, environment variables, stdin pipes, or configuration.

Give the user a command like this to run personally in a real terminal:

```bash
npx --yes statusweave@latest connect work-api --name "Work API" --kind percent --path '$.usage.used_percent'
```

The command asks for the HTTPS status endpoint, then hands the terminal directly to macOS Keychain for hidden API-key entry. StatusWeave stores only an origin-bound reference. After it succeeds:

```bash
npx --yes statusweave@latest launch --custom --json
npx --yes statusweave@latest verify --custom --json
```

To remove both the provider and its dedicated Keychain item, the user personally runs:

```bash
npx --yes statusweave@latest disconnect work-api
```

## Guarantees

- `doctor` and `detect` are read-only and make no cloud requests.
- `launch` starts one localhost service, enables only requested providers that are ready, and opens the dashboard.
- Repeating `launch` reuses a compatible running service instead of starting a duplicate.
- Built-in setup never writes provider credentials into StatusWeave configuration or returns them through the API.
- `connect`, `disconnect`, and `authorize` require a real interactive terminal for sensitive or confirmatory steps.
- Authorization stores consent metadata, CLI version, and verification time, but not credentials or full terminal transcripts.
- “One-time” setup remains valid only while the provider CLI login and compatible usage/status output remain available.
- Provider integrations are unofficial compatibility integrations and may break when upstream formats or endpoints change.
