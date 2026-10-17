# Changelog

## 0.1.0 — 2026-10-17 (published to npm)

`npm i -g` is not the point: `dsh plugin --profile <p> add dsh-persona-switch` installs
`dsh-persona-switch@0.1.0` from the public registry, tarball shasum
`f254d059bb2817bfe3c62a93974a35ac1c0425f1`.

Note on the publish: npm answers **202** and processes the upload asynchronously
("Your package is being processed and may take a few minutes"). For ~1 minute the
registry serves a placeholder version (`Temporary package placeholder for staged
publishing`) before the real tarball replaces it — `scripts/publish.ps1` now polls
`npm view` for up to two minutes instead of trusting a single read.

Verified against **dsh 0.2.0-rc.2** (node 24.18.1, pnpm 12.8.1) and the runtime
inside **DeepSeek Harness Desktop 0.2.1-rc.1**. `@deepseek-ai/dsh-commands` is
byte-identical between those two (`lib/index.js`, 20,129 B, SHA256
`88909A0915E4E3B2…`), so the `commands.register` / `input.hint` surface this
plugin uses is unchanged.

Added

- One prompt section whose `text` is a provider, so the active persona is read
  at every assembly: switching takes effect on the next turn with no restart.
- `/persona` command — `list`, `<name>`, `off`, `reload`, `complete on|off|auto`.
- `persona_switch` tool, so the agent can switch itself on request.
- Persona files: `$DSH_HOME/personas/*.md` with `title` / `complete` / `suffix`
  front-matter; seeded from the package on first run.
- Seeds: `jb` (persona slim2), `terse` (example of `complete: false`),
  `_selftest` (answers only `BANANA`).
- `test/unit.mjs` — 30 assertions against a fake Cordis context, no model calls.
- `test/capture-prompt.mjs` — mock Anthropic-Messages/OpenAI endpoint that
  proves what the system message actually contains, with a `--persona` switch.
- `scripts/install-desktop.ps1` — install into the Electron app's reserved
  `desktop` profile (the CLI refuses it), with clone-based verification and
  `-Version` for registry builds.

Added

- One prompt section whose `text` is a provider, so the active persona is read
  at every assembly: switching takes effect on the next turn with no restart.
- `/persona` command — `list`, `<name>`, `off`, `reload`, `complete on|off|auto`.
- `persona_switch` tool, so the agent can switch itself on request.
- Persona files: `$DSH_HOME/personas/*.md` with `title` / `complete` / `suffix`
  front-matter; seeded from the package on first run.
- Seeds: `jb` (persona slim2), `terse` (example of `complete: false`),
  `_selftest` (answers only `BANANA`).
- `test/unit.mjs` — 26 assertions against a fake Cordis context, no model calls.
- `test/capture-prompt.mjs` — mock Anthropic-Messages/OpenAI endpoint that
  proves what the system message actually contains, with a `--persona` switch.

Design notes

- No third-party imports. `@deepseek-ai/dsh-tools` is published at 0.0.1-rc.1
  while the runtime ships 0.2.0-rc.2, so the tool definition is built from a
  plain JSON Schema instead of a version-pinned helper.
- `complete: true` makes the persona the *entire* system prompt (the model still
  receives every tool schema). `complete: false` keeps first-party guidance and
  puts the persona at the deployment-persona slot.

Known limits

- No Web settings panel: the switcher is a slash command and a tool.
- Two effective `complete` sections make prompt assembly fail; keep other
  persona plugins switched off.
- State is deployment-wide (`$DSH_HOME`), shared by every profile.
