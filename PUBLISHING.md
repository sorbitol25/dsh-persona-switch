# Publishing this repo

Everything below is the difference between "works on my machine" and a repo
someone else can install in one line.

## 1. Metadata

Already filled in for `sorbitol25/dsh-persona-switch` (`author`, `repository`,
`homepage`, `bugs`). If you publish under a different account, change those four
fields plus the copyright line in `LICENSE`.

## 2. Push

```sh
git init
git add -A
git commit -m "dsh-persona-switch 0.1.0"
git branch -M main
git remote add origin https://github.com/<you>/dsh-persona-switch.git
git push -u origin main
```

Then set the GitHub topics — `dsh-plugin` is the one the Harness ecosystem
scans for (the official README asks plugin repos to add it):

```
dsh-plugin  dsh  deepseek-harness  persona  cordis
```

## 3. What ships and what does not

| file | in the repo | notes |
|---|---|---|
| `personas/jb.md` | **yes** | the example JB persona |
| `personas/terse.md`, `personas/_selftest.md` | yes | neutral examples |
| `personas/jb_full.md` | **no** | 84 KB variant; removed from the tip *and* from every earlier commit on 2026-10-12 (`git filter-branch` + `--force` push) |

`jb_full.md` is guarded twice so it cannot come back by accident: `.gitignore`
(tracked, documents the rule) and `.git/info/exclude` (local). If you ever add a
persona you do **not** want published:

```sh
# working tree keeps the file; only the index and history drop it
git rm --cached personas/<name>.md
git commit -m "persona: untrack <name>"

# if it already reached the remote, rewrite + force-push
git filter-branch --force --index-filter \
  "git rm --cached --ignore-unmatch personas/<name>.md" --prune-empty -- --all
rm -rf .git/refs/original
git reflog expire --expire=now --all && git gc --prune=now
git push --force origin main
```

> `filter-branch` can drop the file from the **working tree** too. Back the
> persona up before rewriting (this happened once; the copy in
> `$DSH_HOME/personas/` saved it).

## 4. Optional: npm

The package is publishable as-is (`files` already limits the tarball). If you
publish, the plugin can be installed by name:

```sh
dsh plugin --profile web add dsh-persona-switch
```

Check what would ship first:

```sh
npm pack --dry-run
```

## 5. Version compatibility

The plugin declares **no** `peerDependencies` on `@deepseek-ai/*` on purpose:
`dsh plugin add` rejects a plugin whose peers do not match the running runtime,
and `@deepseek-ai/dsh-tools` is published at `0.0.1-rc.1` while the runtime
ships `0.2.0-rc.2`. Importing nothing keeps the plugin installable across the
0.1.x → 0.2.x jump. If a future runtime changes the `systemPrompt.section` or
`commands.register` surface, this is the file to revisit: `lib/index.js`.

Re-verify before tagging a release:

```sh
node test/unit.mjs                                  # 26 assertions, no network
node test/capture-prompt.mjs --persona _selftest    # system message == persona
```

## 6. What actually happened here (2026-10-12)

Pushed as a **private** repo with `publish-to-github.ps1 -Private`:

```
repo      : sorbitol25/dsh-persona-switch
private   : true
default   : main
topics    : cordis, deepseek-harness, dsh, dsh-plugin, persona
commits   : 3
files     : 15
```

Two things worth knowing:

1. **A classic PAT without the `workflow` scope cannot push
   `.github/workflows/*.yml`** — GitHub rejects the *entire* push, not just that
   file. `publish-to-github.ps1` detects the rejection, holds the workflow file
   (`git rm --cached`, body kept on disk under `.github/`), and pushes the rest.
   To turn CI on later: add the `workflow` scope to the token at
   <https://github.com/settings/tokens>, then

   ```sh
   git add .github/workflows/test.yml
   git commit -m "ci: enable tests"
   git push
   ```

2. **Private → public** needs no CLI. Either
   `PATCH /repos/sorbitol25/dsh-persona-switch {"private": false}` or
   Settings → General → Danger Zone → Change visibility. Remember that going
   public also publishes the JB seeds unless you run `-Variant neutral` first
   (see §3).

The token is never written into `.git/config`: `origin` holds the plain HTTPS
URL and the token is only used inline for the push.

3. **Keep `git add -A` from re-adding the held workflow.** `.github/workflows/test.yml`
   is listed in `.git/info/exclude` (local-only, never shipped), so the file stays
   on disk but stays out of commits until the token can write workflows. Without
   that line the next `git add -A` stages it again and the push is rejected — which
   is exactly what happened on the second push attempt.

