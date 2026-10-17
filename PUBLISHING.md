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

## 4. npm publish — the delivery path

The name is free (`https://registry.npmjs.org/dsh-persona-switch` → **404**) and the
tarball is already limited by `files` (11 files, 17 kB unpacked 47 kB).
`prepublishOnly` runs the unit tests, so a red test cannot be published.

One-time setup:

```sh
npm login          # browser + OTP; then:
npm whoami         # must print your npm username
```

Every release (one command, or the five steps by hand):

```powershell
powershell -ExecutionPolicy Bypass -File scripts/publish.ps1 -DryRun   # tests + tarball check, no upload
powershell -ExecutionPolicy Bypass -File scripts/publish.ps1           # upload + tag + push the tag
```

What it does, in order: dirty-tree guard → "already published?" guard (E404 = free) →
`npm whoami` guard → `npm test` → `npm pack --dry-run` (forbids `jb_full.md` / `.git`) →
`npm publish --access public` → `npm view` verify → `git tag v<version>` → `git push origin v<version>`.

By hand, the same thing:

```sh
cd persona-switch
npm test                       # 30 assertions, no network
npm pack --dry-run             # confirm: no .git, no jb_full.md
npm publish --access public    # publishConfig already says public
npm view dsh-persona-switch version dist.tarball time.modified
git tag v0.1.0 && git push --tags
```

### 2FA accounts — the 403 you get first

`npm login` in a browser hands you an *interactive* token. With 2FA enabled,
`npm publish` answers:

```
npm error code E403
npm error 403 Forbidden - PUT https://registry.npmjs.org/<pkg> - Two-factor
authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

That is npm's documented rule: publishing needs **either** 2FA **or** a granular
access token with *bypass 2FA*. **This account has `tfa:false`** (`npm profile get`),
so the registry refuses the publish — and enabling 2FA itself asks for the npm
**password** (`npm profile enable-2fa auth-and-writes` → `npm password:`), which is
not on disk (no saved login in Chrome/Edge, no entry in the local harvest ledger).

`scripts/enable-2fa-and-publish.mjs` closes that gap in one command — you type the
password once, locally, and it does the rest:

```powershell
node scripts/enable-2fa-and-publish.mjs
#   → npm password: ********          (not echoed, not stored)
#   → picks "Verification code (TOTP)", captures the secret npm hands out,
#     computes the code itself (RFC 6238, verified against the RFC vectors),
#     prints the recovery codes, saves the secret to %USERPROFILE%\.npm-2fa-secret
#   → npm publish --access public with a freshly generated OTP
node scripts/enable-2fa-and-publish.mjs --publish    # later releases: no prompts
```

Alternatives:

1. **OTP per publish** (nothing stored) — enable 2FA in the browser, then
   `scripts\publish.ps1 -Otp 123456`.
2. **Granular token with bypass 2FA** — npmjs.com → Access Tokens → Generate New →
   Granular → enable *bypass 2FA* → Read and write → put
   `//registry.npmjs.org/:_authToken=npm_…` in `%USERPROFILE%\.npmrc`.
   npm is restricting bypass-2FA tokens for account changes; still the documented
   route for publishing, but do not lean on it long-term.
3. **Trusted publishing (OIDC)** from GitHub Actions — no token, provenance included.
   Needs npm CLI ≥ 11.21, a cloud-hosted runner, and the package to exist already
   (the trusted-publisher config lives on the package's settings page), so the
   **first** publish is manual and later ones can be automated.

A 403 must never leave a release tag behind: `publish.ps1` now confirms the version
on the registry **before** `git tag` / `git push`.

After that, installing is one line per profile — and `dsh plugin add` appends the
bundle entry itself, because the package declares `dsh.bundle.patch`:

```sh
dsh plugin --profile web      add dsh-persona-switch
dsh plugin --profile dsh-tui  add dsh-persona-switch
dsh plugin --profile headless add dsh-persona-switch
```

**The desktop app is the one exception.** `dsh plugin --profile desktop …` refuses
(`profile "desktop" is managed exclusively by the Electron application`), so use:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/install-desktop.ps1 -Version 0.1.0
```

It writes the dep + bundle into `~/.dsh/profiles/desktop/package.json` (BOM-less),
copies the package into that profile's `node_modules`, and verifies the composition
through a throwaway profile clone. Quit the app fully (tray too) afterwards.

### Release checklist

- [ ] version bumped in `package.json` + a CHANGELOG entry
- [ ] `npm test` → 30/30
- [ ] `node test/capture-prompt.mjs --persona jb` → agent-turn system message is
      byte-exact `personas/jb.md` and the harness identity is **absent**
- [ ] `npm pack --dry-run` → 11 files, no `jb_full.md`, no `.git`
- [ ] published; `npm view dsh-persona-switch version` matches
- [ ] a clean profile installs by name: `dsh plugin --profile <new> add dsh-persona-switch`
- [ ] desktop: `scripts/install-desktop.ps1 -Version <version>`, restart, `/` lists `persona`

## 4b. What actually happened on 2026-10-17 (the first publish)

1. `npm login` (browser) → `npm whoami` = `sorbitol49`.
2. `npm publish` → **403**: `Two-factor authentication or granular access token with
   bypass 2fa enabled is required to publish packages`.
3. `npm profile get` → **`"tfa": false`**. npm requires 2FA *enabled* (or a bypass token);
   enabling it asks for the account password, and token creation (`npm token create`,
   `POST /-/npm/v1/tokens`) answers `"password" is required` too.
4. First granular token (package:write, 7-day expiry) → still 403, because
   `GET /-/npm/v1/tokens` reported **`"bypass_2fa": false`** for it.
5. Second granular token with **Bypass 2FA** enabled → `npm publish` answered
   **202 + "Your package is being processed"**; the registry served a placeholder for
   ~60 s and then `version = 0.1.0`, `dist-tags.latest = 0.1.0`, shasum matching the
   local tarball.
6. `publish.ps1` reported FAILED at that moment because it read `npm view` once — fixed
   by polling (24 × 5 s). `git tag v0.1.0` was created afterwards and pushed.

So the rule of thumb: **2FA-on or a bypass token**; if neither, the password is the only
way in (and it never leaves your machine — `scripts/enable-2fa-and-publish.mjs` asks for
it locally, derives TOTP itself, and can then publish unattended).

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

