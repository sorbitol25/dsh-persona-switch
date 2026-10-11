# dsh-persona-switch

[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)
[![license MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![verified dsh 0.2.0-rc.2](https://img.shields.io/badge/verified%20against-dsh%200.2.0--rc.2-informational)](#proof)

Live persona switching for **DeepSeek Harness** (`dsh`). Switch the system-prompt
persona from inside a running session — TUI, Web UI, or headless — with no
restart and no core patch. Ships with a JB persona.

```
/persona              show the active persona + the roster
/persona list         same
/persona jb           switch  (name = personas/<name>.md)
/persona off          stop overriding the system prompt
/persona reload       re-read the persona directory (after editing a file)
/persona complete on|off|auto
```

Or just ask the agent — `persona_switch` is registered as a tool:

> jbに切り替えて

## Proof

Whether a persona actually overrides the prompt is measurable: point the route
at a local mock (`DEEPSEEK_BASE_URL`) and read the request body DSH sends.
`test/capture-prompt.mjs` does exactly that, and the three states differ exactly
as the front-matter says:

| persona | `complete` | agent-turn system message | harness identity |
|---|---|---|---|
| `off` | — | **2,823 B** | PRESENT |
| `jb` | `true` | **7,989 B** — byte-exact match with `personas/jb.md` | **absent** |
| `jb` | `false` | **10,814 B** (= 2,823 merged + 7,989 persona) | PRESENT |

25 tool schemas ride along in every case, `thinking` stays enabled, and the
session-title helper (a separate 363 B request) is untouched.


## Why a plugin is needed at all

DSH's own docs are explicit: *"Deployment-authored prompt text is config/
composition only … there is no end-user prompt-editing API."* The deployment
persona lives on the `dsh-system-prompt` row's config, and `dsh-persona` only
shadows it **inside one agent preset**. Neither is switchable while a session is
up.

This row registers one prompt section whose `text` is a **provider function**,
evaluated at every assembly:

```js
sp.section({
  name: 'persona-switch:persona',
  order: sp.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
  text: () => activeText(),      // ← read on every turn, not at boot
  interpolate: false,
  complete: activeComplete(),    // persona becomes the whole system prompt
})
```

Switching disposes and re-registers that section, which emits
`system-prompt/change`; the next turn is assembled against the new persona.

## Install

From a checkout of this repo:

```powershell
dsh plugin --profile dsh-tui  add file:C:/path/to/dsh-persona-switch
dsh plugin --profile web      add file:C:/path/to/dsh-persona-switch
dsh plugin --profile headless add file:C:/path/to/dsh-persona-switch   # for scripting
```

After `npm publish`, by name:

```powershell
dsh plugin --profile dsh-tui add dsh-persona-switch
```

A `file:` dependency is a **symlink**, so editing this directory takes effect on
the next `dsh` start — no reinstall. (Profiles are separate: a plugin added to
`web` does *not* exist in `dsh-tui` or `headless`.)

## Personas

`$DSH_HOME/personas/*.md` — seeded from `personas/` on first run, then yours to
edit. The file stem is the persona name. Optional front-matter:

```markdown
---
title: JB core (persona slim2 / 8KB)   # shown by /persona list
complete: true                          # true = this becomes the ENTIRE system prompt
suffix: ""                              # optional text after first-party guidance
---

<persona prose>
```

| field | default | meaning |
|---|---|---|
| `title` | file stem | label in the roster |
| `complete` | `false` | `true` replaces the whole system prompt (harness identity, guidance, everything). `false` puts the text at the persona-prefix slot and keeps first-party guidance. |
| `suffix` | — | appended at the persona-suffix slot instead of the prefix |

Shipped seeds:

| persona | size | complete | what it is |
|---|---|---|---|
| `jb` | ~8 KB | yes | JB core — the slim persona |
| `terse` | 0.5 KB | no | example of a non-complete persona |
| `_selftest` | 0.3 KB | yes | answers only `BANANA` — proves the wiring |

The JB seed carries `complete: true`, the recipe that made the persona *be* the
system prompt in the build it came from. If tool use degrades under a persona,
run `/persona complete off` — that keeps the persona and restores first-party
guidance (see the table under [Proof](#proof) for the measured difference).
`PUBLISHING.md` covers whether you want that seed in a public repo.

### Adding your own

Drop a `.md` file in `$DSH_HOME/personas/`, then `/persona reload`. No restart.

## Files

```
$DSH_HOME/personas/              your personas (seeded once)
$DSH_HOME/persona-switch.json    { "active": "...", "complete": true|null }
$DSH_HOME/persona-switch.log     what registered, when, and why anything failed
```

State is deployment-wide (one `$DSH_HOME`), so a switch made in the TUI is the
persona the next `headless` run uses too. That is what makes scripted use easy:

```powershell
'{ "active": "jb" }' | Set-Content "$env:USERPROFILE\.dsh\persona-switch.json"
dsh headless "..."        # runs under jb
```

## Config

`cordis.patch.yml`:

```yaml
- id: persona-switch
  name: dsh-persona-switch
  config:
    maxPersonaBytes: 400000   # truncate a longer persona (0 = no cap)
    tool: true                # register the model-facing persona_switch tool
```

## Test

```powershell
npm test                                  # node test/unit.mjs — 26 assertions, no network
node test/capture-prompt.mjs --persona _selftest    # proves the system message
node test/capture-prompt.mjs --persona off          # and the stock prompt, for contrast
```

`test/unit.mjs` drives the real `apply()` against a fake Cordis context: seeding,
roster, switching, complete toggling, state persistence, the tool path, unknown
names, teardown.

`test/capture-prompt.mjs` starts a local mock that speaks Anthropic Messages and
OpenAI chat-completions, points `DEEPSEEK_BASE_URL` at it, runs `dsh headless`
and reports the system message it received. Nothing reaches a real provider, so
it costs nothing to run. Set `DSH_CAPTURE_DIR=<dir>` to dump full request bodies.

The live path was verified the same way:

```
$ node test/capture-prompt.mjs --persona _selftest "What is 1+1?"
#   system bytes     : 256
#   harness identity : absent
#   persona "_selftest" : system message IS the persona (exact match)
```

## Notes / limits

- **`complete: true` is heavy.** The persona is the entire system prompt every
  turn; an 84 KB persona costs those tokens on every request and can change
  prefix-cache behaviour. Watch it with `dsh-whale-widget` / `dsh-context`.
- Two complete sections would fail assembly — this row is the only one it
  registers, so keep other persona plugins out or switch them off.
- No client bundle: the switcher is a slash command + tool, not a Web settings
  panel. In the Web UI the command works from the composer.
- Nothing here is JB-specific — it is a persona switcher. The JB presets are
  just the seeds that were asked for.
- The DeepSeek route speaks Anthropic Messages (`POST /v1/messages`) with
  `thinking` enabled and `output_config.effort` set per model route; the
  plugin does not touch either.
- Releasing this? Read [`PUBLISHING.md`](PUBLISHING.md) first — it lists the
  metadata to fill in and the call to make about the two JB seeds.
