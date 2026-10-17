# install-desktop.ps1 — put dsh-persona-switch into the Electron app's reserved profile.
#
# The app's profile is `desktop`, and the CLI refuses to touch it:
#   dsh plugin --profile desktop …  ->  profile "desktop" is managed exclusively by the Electron application
# so this script does what `dsh plugin add` would do, by hand, and then verifies the composition.
#
#   powershell -ExecutionPolicy Bypass -File scripts/install-desktop.ps1
#   powershell -ExecutionPolicy Bypass -File scripts/install-desktop.ps1 -Version 0.1.2   # dep as ^0.1.2 (npm)
#
# Quit the app completely (tray included) before starting it again.
param(
  [string]$Version,                       # omit = file:<this checkout> (development symlink/copy)
  [string]$ProfilesRoot = (Join-Path $env:USERPROFILE '.dsh\profiles'),
  [string]$Name = 'dsh-persona-switch'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$pkgJson = Join-Path $root 'package.json'
if (-not (Test-Path $pkgJson)) { throw "not a dsh-persona-switch checkout: $root" }
$pkg = Get-Content $pkgJson -Raw | ConvertFrom-Json
$profileDir = Join-Path $ProfilesRoot 'desktop'
$profilePkg = Join-Path $profileDir 'package.json'
if (-not (Test-Path $profilePkg)) {
  throw "desktop profile not initialized: $profilePkg — open the DeepSeek Harness app once, then quit it."
}

$utf8 = New-Object System.Text.UTF8Encoding($false)     # a BOM breaks the loader's JSON.parse
$depTarget = if ($Version) { "^$Version" } else { 'file:' + ($root -replace '\\', '/') }

$raw = [System.IO.File]::ReadAllText($profilePkg, [System.Text.Encoding]::UTF8)
$j = $raw | ConvertFrom-Json
if (-not $j.dependencies) { $j | Add-Member -NotePropertyName dependencies -NotePropertyValue ([pscustomobject]@{}) -Force }
$j.dependencies | Add-Member -NotePropertyName $Name -NotePropertyValue $depTarget -Force
if (-not $j.dsh) { $j | Add-Member -NotePropertyName dsh -NotePropertyValue ([pscustomobject]@{}) -Force }
if (-not $j.dsh.profile) { $j.dsh | Add-Member -NotePropertyName profile -NotePropertyValue ([pscustomobject]@{}) -Force }
$bundles = @()
if ($j.dsh.profile.bundles) { $bundles = @($j.dsh.profile.bundles) }
if (-not ($bundles -contains $Name)) { $bundles = @($bundles + $Name) }
$j.dsh.profile | Add-Member -NotePropertyName bundles -NotePropertyValue $bundles -Force
$backup = "$profilePkg.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
Copy-Item $profilePkg $backup -Force
[System.IO.File]::WriteAllText($profilePkg, (($j | ConvertTo-Json -Depth 12) + "`n"), $utf8)
"dependencies  $Name = $depTarget"
"bundles       $($bundles -join ' > ')"
"backup        $backup"

# the plugin has to be resolvable from the profile directory
$dst = Join-Path $profileDir "node_modules\$Name"
New-Item -ItemType Directory -Path (Join-Path $profileDir 'node_modules') -Force | Out-Null
if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
Copy-Item $root $dst -Recurse -Force
foreach ($junk in '.git', '.github', 'scripts') { $p = Join-Path $dst $junk; if (Test-Path $p) { Remove-Item $p -Recurse -Force } }
"installed     $dst"

# verify: the reserved name cannot be dumped, so compose a throwaway clone instead
$tmp = Join-Path $ProfilesRoot '_verify_desktop'
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Copy-Item $profileDir $tmp -Recurse -Force
$tmpPkg = Join-Path $tmp 'package.json'
$t = [System.IO.File]::ReadAllText($tmpPkg, [System.Text.Encoding]::UTF8) -replace 'dsh-profile-desktop', 'dsh-profile-verify'
[System.IO.File]::WriteAllText($tmpPkg, $t, $utf8)
$dump = & dsh --profile _verify_desktop --dump-config 2>&1 | Out-String
Remove-Item $tmp -Recurse -Force
if ($dump -match 'id: persona-switch') {
  "verify        OK  (- id: persona-switch composes)"
  ""
  "Now quit DeepSeek Harness completely (tray included) and start it again."
  "In the app: '/' -> Commands -> persona, then '/persona <name>'."
} else {
  "verify        FAILED"
  "--- dump --dump-config (first 40 lines) ---"
  ($dump -split "`n" | Select-Object -First 40) -join "`n"
  exit 1
}
