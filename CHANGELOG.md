# Changelog

## 0.1.0 — 2026-10-12

First release. Verified against **dsh 0.2.0-rc.2** (node 24.18.1, pnpm 12.8.1).

Added

- One prompt section whose `text` is a provider, so the active persona is read
  at every assembly: switching takes effect on the next turn with no restart.
- `/persona` command — `list`, `<name>`, `off`, `reload`, `complete on|off|auto`.
- `persona_switch` tool, so the agent can switch itself on request.
- Persona files: `$DSH_HOME/personas/*.md` with `title` / `complete` / `suffix`
  front-matter; seeded from the package on first run.
- Seeds: `jb` (persona slim2), `jb_full` (persona v13), `terse` (example of
  `complete: false`), `_selftest` (answers only `BANANA`).
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
