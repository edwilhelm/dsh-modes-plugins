<#
.SYNOPSIS
  Installs the custom DeepSeek Harness modes, plugins, and skills from this
  repository into $DSH_HOME (.agent-presets and profiles/web).

.DESCRIPTION
  Copies:
    agent-presets/<mode>/          -> $DSH_HOME/.agent-presets/<mode>/
    web-profile/*                  -> $DSH_HOME/profiles/web/ (config files)
    web-profile/plugins/subagent-acp/ -> $DSH_HOME/profiles/web/plugins/subagent-acp/

  Every file that already exists at the target is backed up into a
  timestamped folder before being overwritten. Nothing is deleted.

.PARAMETER DshHome
  Override the install root. Default: $env:DSH_HOME, else $HOME\.dsh.

.PARAMETER DryRun
  Print every action without changing anything.

.PARAMETER Yes
  Skip the confirmation prompt and the opencode-path prompt (keeps the
  placeholder path from web-profile/cordis.patch.yml).

.EXAMPLE
  .\install.ps1 -DryRun
  .\install.ps1
  .\install.ps1 -DshHome C:\custom\dsh -Yes
#>
[CmdletBinding()]
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME '.dsh' }),
  [switch]$DryRun,
  [switch]$Yes
)

$ErrorActionPreference = 'Stop'
$RepoRoot = $PSScriptRoot

function Write-Step([string]$Msg) { Write-Host "==> $Msg" -ForegroundColor Cyan }
function Write-Ok([string]$Msg)   { Write-Host "    $Msg" -ForegroundColor Green }
function Write-Skip([string]$Msg) { Write-Host "    $Msg" -ForegroundColor DarkGray }
function Write-Warn([string]$Msg) { Write-Host "    $Msg" -ForegroundColor Yellow }

# ---- resolve source dirs --------------------------------------------------
$PresetsSrc = Join-Path $RepoRoot 'agent-presets'
$WebSrc     = Join-Path $RepoRoot 'web-profile'
$WebFiles   = @('cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-workspace.yaml')

if (-not (Test-Path $PresetsSrc)) { throw "Not found: $PresetsSrc (run from the repo root)" }
if (-not (Test-Path $WebSrc))     { throw "Not found: $WebSrc" }

Write-Step "Installing to $DshHome"

# ---- target layout --------------------------------------------------------
$PresetsDst = Join-Path $DshHome '.agent-presets'
$WebDst     = Join-Path $DshHome 'profiles\web'

# ---- 1. backup existing files ---------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$BackupRoot = Join-Path $DshHome ".dsh-modes-plugins-backup-$stamp"
$toBackup = @()
foreach ($preset in Get-ChildItem $PresetsSrc -Directory) {
  $dst = Join-Path $PresetsDst $preset.Name
  if (Test-Path $dst) { $toBackup += $dst }
}
foreach ($f in $WebFiles) {
  $dst = Join-Path $WebDst $f
  if (Test-Path $dst) { $toBackup += $dst }
}
$webPluginDst = Join-Path $WebDst 'plugins\subagent-acp'
if (Test-Path $webPluginDst) { $toBackup += $webPluginDst }

if ($toBackup.Count -gt 0) {
  Write-Step "Backing up $($toBackup.Count) existing item(s) -> $BackupRoot"
  if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null }
  foreach ($item in $toBackup) {
    $rel = $item.Substring($DshHome.Length).TrimStart('\', '/')
    $dest = Join-Path $BackupRoot $rel
    Write-Ok "backup $rel"
    if (-not $DryRun) {
      New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
      Copy-Item $item $dest -Recurse -Force
    }
  }
} else {
  Write-Skip "Nothing to back up (clean install)"
}

# ---- 2. copy agent presets -------------------------------------------------
Write-Step "Copying agent presets"
foreach ($preset in Get-ChildItem $PresetsSrc -Directory) {
  $dst = Join-Path $PresetsDst $preset.Name
  Write-Ok "agent-presets/$($preset.Name) -> .agent-presets/$($preset.Name)"
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path $PresetsDst | Out-Null
    Copy-Item $preset.FullName $dst -Recurse -Force
  }
}

# ---- 3. copy web profile ---------------------------------------------------
Write-Step "Copying web profile"
if (-not $DryRun) { New-Item -ItemType Directory -Force -Path $WebDst | Out-Null }
foreach ($f in $WebFiles) {
  $src = Join-Path $WebSrc $f
  Write-Ok "web-profile/$f -> profiles/web/$f"
  if (-not $DryRun) { Copy-Item $src (Join-Path $WebDst $f) -Force }
}
# plugins
if (Test-Path (Join-Path $WebSrc 'plugins\subagent-acp')) {
  Write-Ok 'web-profile/plugins/subagent-acp -> profiles/web/plugins/subagent-acp'
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path (Join-Path $WebDst 'plugins') | Out-Null
    Copy-Item (Join-Path $WebSrc 'plugins\subagent-acp') $webPluginDst -Recurse -Force
  }
}

# ---- 4. opencode path fix-up ----------------------------------------------
$PatchPath = if ($DryRun) { Join-Path $WebSrc 'cordis.patch.yml' } else { Join-Path $WebDst 'cordis.patch.yml' }
$content = Get-Content $PatchPath -Raw
if ($content -match 'C:/PATH/TO/opencode\.exe') {
  Write-Step 'opencode path'
  $candidate = $null
  # Prefer the real executable over npm's .ps1/.cmd shim. `Get-Command opencode`
  # returns the shim first on Windows; the real binary lives under the npm global
  # root (e.g. $env:APPDATA\npm\node_modules\opencode-ai\bin\opencode.exe).
  $npmRoot = $null
  try { $npmRoot = (npm prefix -g 2>$null | Select-Object -Last 1) } catch {}
  $realExe = Join-Path $npmRoot "node_modules\opencode-ai\bin\opencode.exe"
  if (Test-Path $realExe) {
    $candidate = $realExe
  } else {
    try {
      $cmd = Get-Command opencode -ErrorAction SilentlyContinue
      if ($cmd -and $cmd.Source -match '\.exe$') { $candidate = $cmd.Source }
    } catch {}
  }
  if ($Yes -or -not $candidate) {
    if ($Yes) {
      Write-Warn 'Keeping placeholder C:/PATH/TO/opencode.exe — edit it in cordis.patch.yml yourself.'
    } else {
      Write-Warn "Could not auto-detect opencode. Edit 'C:/PATH/TO/opencode.exe' in $PatchPath yourself."
    }
  } else {
    Write-Ok "Detected opencode at: $candidate"
    if (-not $DryRun) {
      $content = $content -replace 'C:/PATH/TO/opencode\.exe', ($candidate -replace '\\', '/')
      Set-Content -Path $PatchPath -Value $content -Encoding UTF8
    }
  }
}

# ---- 5. summary ------------------------------------------------------------
Write-Step 'Done'
$presetNames = (Get-ChildItem $PresetsSrc -Directory | ForEach-Object { $_.Name }) -join ', '
Write-Ok "Presets installed:  $presetNames"
Write-Ok "Web profile:        $WebDst"
if ($toBackup.Count -gt 0) { Write-Ok "Backup:             $BackupRoot" }
Write-Host ''
Write-Host 'Next steps:' -ForegroundColor Cyan
Write-Host '  1. Restart the harness (dsh web restart)'
Write-Host '  2. Pick a mode: acp | autodiff | orchestrator'
if ($DryRun) { Write-Host ''; Write-Warn 'DRY RUN — nothing was changed.' }
