# publish.ps1 — the last mile: tests -> tarball check -> npm publish -> verify -> tag/push.
#
#   powershell -ExecutionPolicy Bypass -File scripts/publish.ps1 -DryRun   # everything except the upload
#   powershell -ExecutionPolicy Bypass -File scripts/publish.ps1           # real publish (needs `npm login` first)
#
# Preconditions: `npm whoami` prints your username, a clean git tree, and the
# version in package.json not already on the registry.
param(
  [switch]$DryRun,
  [string]$Tag = 'latest'
)
$ErrorActionPreference = 'Continue'   # native stderr becomes ErrorRecords; we check $LASTEXITCODE instead
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
  $pkg = Get-Content package.json -Raw | ConvertFrom-Json
  $name = $pkg.name
  $version = $pkg.version
  "package   $name@$version"

  # 1. a dirty tree means the tarball will not match what is committed
  $dirty = git status --porcelain
  if ($dirty) { "git       DIRTY — commit first:"; $dirty; exit 1 }
  "git       clean ($(git rev-parse --short HEAD))"

  # 2. never republish a version (E404 here just means "not published yet")
  $live = (& npm view "$name@$version" version 2>$null | Out-String).Trim()
  if ($live -eq $version) { "registry  $name@$version already published — bump package.json"; exit 1 }
  "registry  $name@$version is free"

  # 3. who am I
  $who = (& npm whoami 2>$null | Out-String).Trim()
  if (-not $who) {
    if (-not $DryRun) { "npm       NOT LOGGED IN — run: npm login"; exit 1 }
    "npm       NOT LOGGED IN (tolerated in -DryRun)"
  } else { "npm       as $who" }

  # 4. tests (prepublishOnly runs them again on publish; this is the early warning)
  & node test/unit.mjs | Select-Object -Last 1
  if ($LASTEXITCODE -ne 0) { "tests     FAILED"; exit 1 }

  # 5. tarball contents: 13 files, no .git, no unpublished personas
  $pack = (npm pack --dry-run 2>&1 | Out-String)
  $files = ($pack -split "`n" | Select-String 'npm notice (total files|unpacked size)') -join ' / '
  $pack -split "`n" | Select-String 'npm notice \d+\.?\d*[km]?B ' | ForEach-Object { $_.Line }
  $pack -split "`n" | Select-String 'total files|unpacked size' | ForEach-Object { $_.Line }
  foreach ($forbidden in 'jb_full.md', '.git/') {
    if ($pack -match [regex]::Escape($forbidden)) { "tarball   FORBIDDEN CONTENT: $forbidden"; exit 1 }
  }

  # 6. publish
  if ($DryRun) {
    npm publish --access public --tag $Tag --dry-run
    "`n(dry run: nothing uploaded)"
  } else {
    npm publish --access public --tag $Tag
    npm view $name version dist.tarball time.modified
    git tag "v$version"
    git push origin "v$version"
    "tagged    v$version"
  }
  ""
  "install   dsh plugin --profile web add $name@$version"
  "desktop   powershell -ExecutionPolicy Bypass -File scripts/install-desktop.ps1 -Version $version"
} finally {
  Pop-Location
}
