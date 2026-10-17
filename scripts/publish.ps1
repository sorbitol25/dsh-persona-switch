# publish.ps1 — the last mile: tests -> tarball check -> npm publish -> verify -> tag/push.
#
#   powershell -ExecutionPolicy Bypass -File scripts/publish.ps1 -DryRun   # everything except the upload
#   powershell -ExecutionPolicy Bypass -File scripts/publish.ps1           # real publish (needs `npm login` first)
#
# Preconditions: `npm whoami` prints your username, a clean git tree, and the
# version in package.json not already on the registry.
param(
  [switch]$DryRun,
  [string]$Tag = 'latest',
  # 2FA accounts: the web-login token cannot publish (403). Pass the 6-digit authenticator code.
  [string]$Otp
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
    if ($LASTEXITCODE -ne 0) { "`npublish   FAILED (exit $LASTEXITCODE)"; exit 1 }
    "`n(dry run: nothing uploaded)"
  } else {
    if ($Otp) { npm publish --access public --tag $Tag --otp $Otp } else { npm publish --access public --tag $Tag }
    $publishExit = $LASTEXITCODE

    # 2FA accounts: the interactive login token cannot publish (403). Ask once for the code.
    if ($publishExit -ne 0 -and -not $Otp) {
      $code = Read-Host "publish   got 403 (2FA). Enter the 6-digit authenticator code (blank to abort)"
      if ($code) {
        npm publish --access public --tag $Tag --otp $code.Trim()
        $publishExit = $LASTEXITCODE
      }
    }

    # 7. the registry is the source of truth, not the exit code: a 403 (2FA) must not tag a release.
    #    npm now answers 202 and processes the upload asynchronously ("Your package is being
    #    processed and may take a few minutes"), so poll instead of reading npm view once.
    $live = ''
    for ($i = 0; $i -lt 24; $i++) {
      $live = (& npm view "$name@$version" version 2>$null | Out-String).Trim()
      if ($live -eq $version) { break }
      Start-Sleep -Seconds 5
    }
    if ($publishExit -ne 0 -or $live -ne $version) {
      "`npublish   FAILED (exit $publishExit, registry says '$live' after ~2 min)"
      "          nothing was tagged. Fix the cause and re-run:"
      "          403 ... 2FA is required  ->  scripts\publish.ps1 -Otp <6 digits>, or a granular"
      "          access token with 'bypass 2FA' enabled in %USERPROFILE%\.npmrc"
      exit 1
    }
    npm view $name version dist.tarball time.modified
    if (-not (git tag --list "v$version")) { git tag "v$version" }
    git push origin "v$version"
    "tagged    v$version"
  }
  ""
  "install   dsh plugin --profile web add $name@$version"
  "desktop   powershell -ExecutionPolicy Bypass -File scripts/install-desktop.ps1 -Version $version"
} finally {
  Pop-Location
}
