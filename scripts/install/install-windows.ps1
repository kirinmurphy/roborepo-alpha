# install-windows.ps1 — Windows symlink installer for roborepo
#
# Requirements:
#   - Windows Developer Mode OR run PowerShell as Administrator
#     (symlink creation requires one of these)
#   - Git for Windows (https://git-scm.com) for hook scripts and bin/ commands
#     (hook scripts are bash — they will not run without Git Bash or WSL)
#
# Usage:
#   From PowerShell:  .\scripts\install\install-windows.ps1
#   From Git Bash:    called automatically by install/main.sh
#
# Less tested than macOS/Linux. Report issues or submit PRs.

param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

# Known harness ids and their Windows home roots. Not yet derived from the Node provider registry
# (scripts/harnesses/) the way the bash installers are (see harness_detected_rows in
# scripts/lib/manifests-data.sh). Every harness home is `~`-relative on Windows too (Claude Code
# reads %USERPROFILE%\.claude), so deriving this list from the manifests is follow-up work.
$KnownHarnessIds = @("claude", "codex", "gemini")
$adoptRootConfig = @{
  claude = $false
  codex = $false
  gemini = $false
}

# Kept in sync with globals/harnesses/*/provider.json by scripts/test/windows-installer-check.ps1,
# which fails CI if a provider is added there without being handled here. Every home is
# ~/-relative, matching the manifests directly.
function Resolve-ManifestHomeRoot {
  param($HomeRoot)
  switch ($HomeRoot) {
    "claude" { return (Join-Path $env:USERPROFILE ".claude") }
    "codex"  { return (Join-Path $env:USERPROFILE ".codex") }
    "gemini" { return (Join-Path $env:USERPROFILE ".gemini") }
    default { throw "manifest: unknown home_root '$HomeRoot'" }
  }
}

function Get-ManifestRows {
  param([string[]]$Harnesses)
  $manifestPath = Join-Path $repoRoot "manifests/platform/manifest.tsv"
  if (-not (Test-Path $manifestPath)) {
    throw "missing manifest: $manifestPath"
  }

  foreach ($line in Get-Content $manifestPath) {
    if ([string]::IsNullOrWhiteSpace($line) -or $line.StartsWith("#")) {
      continue
    }

    $cols = $line -split "`t", 6
    if ($cols.Count -ne 6) {
      throw "manifest: invalid row '$line'"
    }

    $harness = $cols[0]
    if ($Harnesses -and ($harness -notin $Harnesses)) {
      continue
    }

    $homeRoot = Resolve-ManifestHomeRoot $cols[4]
    [PSCustomObject]@{
      Harness = $harness
      Kind = $cols[1]
      RepoRel = $cols[2]
      HomePath = Join-Path $homeRoot $cols[3]
      Flags = $cols[5]
    }
  }
}

function Link-Item {
  param($RepoRel, $HomePath, [switch]$AllowReplace)
  $src = Join-Path $repoRoot $RepoRel

  if (-not (Test-Path $src)) {
    Write-Warning "missing source: $src"
    return
  }

  $parentDir = Split-Path -Parent $HomePath
  if (-not (Test-Path $parentDir)) {
    if ($DryRun) {
      Write-Host "would mkdir: $parentDir"
    } else {
      New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
    }
  }

  if (Test-Path $HomePath) {
    $existing = Get-Item $HomePath -Force
    if ($existing.LinkType -eq "SymbolicLink" -and $existing.Target -eq $src) {
      Write-Host "ok: $HomePath"
      return
    }
    if (-not $AllowReplace) {
      Write-Warning "conflict: $HomePath already exists; not replacing it"
      Write-AgentMergePrompt "install" "resolve local path conflict" $RepoRel $HomePath
      throw "install has non-root config conflicts; no replacement was made for $HomePath"
    }
    $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $stateDirName = ".roborepo"  # keep in sync with scripts/install/state-lib.sh cli_state_dirname
    $backupRoot = Join-Path $env:USERPROFILE ".cli-backups\$timestamp"
    $backupPath = Join-Path $backupRoot $HomePath.TrimStart('\').TrimStart('/')
    if (-not $DryRun) {
      New-Item -ItemType Directory -Path (Split-Path -Parent $backupPath) -Force | Out-Null
      Move-Item -Path $HomePath -Destination $backupPath
    }
    Write-Host "backup: $HomePath -> $backupPath"
  }

  if ($DryRun) {
    Write-Host "link: $HomePath -> $src"
    return
  }

  try {
    New-Item -ItemType SymbolicLink -Path $HomePath -Target $src -Force | Out-Null
    Write-Host "link: $HomePath -> $src"
  } catch {
    Write-Warning "Failed to create symlink: $HomePath"
    Write-Warning "Enable Windows Developer Mode or run PowerShell as Administrator."
    Write-Warning "  Settings > System > For Developers > Developer Mode"
  }
}

function Remove-RepoLink {
  param($HomePath)

  $existing = Get-Item $HomePath -Force -ErrorAction SilentlyContinue
  if ($null -eq $existing -or $existing.LinkType -ne "SymbolicLink") {
    return
  }

  $target = [System.IO.Path]::GetFullPath($existing.Target)
  $root = [System.IO.Path]::GetFullPath($repoRoot)
  if (-not $target.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
    return
  }

  if ($DryRun) {
    Write-Host "cleanup: $HomePath"
    return
  }

  Remove-Item $HomePath -Force
  Write-Host "cleanup: $HomePath"
}

function Write-AgentMergePrompt {
  param($Harness, $Mode, $RepoRel, $HomePath)
  $src = Join-Path $repoRoot $RepoRel
  Write-Host ""
  Write-Host "================================================================================"
  Write-Host "MERGE REVIEW REQUIRED: harness install conflict" -ForegroundColor Magenta
  Write-Host "Merge review prompt:"
  Write-Host "Local path: $HomePath"
  Write-Host "================================================================================"
  Write-Host @"
Compare harness config at:
  $src

With local user config at:
  $HomePath

Default stance: keep the local user config as source of truth. Preserve existing local behavior unless you can prove a harness change can be added safely.

Selected install direction: $Mode.

Required first step: compute your own complete comparison of both paths. Do not rely on this prompt as an exhaustive conflict summary. For directories, inspect the full recursive file list and content diffs. For structured files, parse the format when possible and identify all changed keys/tables/arrays/sections before editing.

Merge instructions:
- Keep local-only behavior by default.
- Add repo-only harness behavior only when it does not conflict with local behavior.
- If both sides edit the same setting, hook, rule, command, skill, or MCP/server entry, explain the conflict and stop for user choice.
- Do not delete, replace, or move the local path unless the user explicitly approves that exact action.
- Report the files changed and the conflicts left unresolved.
Harness: $Harness
"@
  Write-Host "================================================================================"
  Write-Host ""
}

function Confirm-Choice {
  param($Prompt)
  $answer = Read-Host "$Prompt [Y/n]"
  return ($answer -eq "" -or $answer -eq "y" -or $answer -eq "Y" -or $answer -eq "yes" -or $answer -eq "YES")
}

# Record the content hash of a root_config file roborepo just wrote, so a later install/update can
# tell "roborepo's own baseline changed" apart from "something else touched this file since."
# Best-effort: never let hash bookkeeping block an
# install. Mirrors record_root_config_write/root_config_drift_status in scripts/install/install-lib.sh.
function Write-RootConfigRecord {
  param($Harness, $HomePath)
  if ($DryRun) { return }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return }
  $stateScript = Join-Path $repoRoot "scripts\cli\root-config-state.mjs"
  & node $stateScript record $Harness $HomePath 2>$null
}

function Get-RootConfigDriftStatus {
  param($Harness, $HomePath)
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return "unwritten" }
  $stateScript = Join-Path $repoRoot "scripts\cli\root-config-state.mjs"
  $result = & node $stateScript check $Harness $HomePath 2>$null
  if (-not $result) { return "unwritten" }
  return $result.Trim()
}

# Interactive collision menu for a drifted user-owned root config. Shared by Invoke-RootConfigPreflight
# (via Resolve-UserConfigCollision) and Export-UserConfig's fallback so the adopt/merge/quit prompt
# lives in exactly one place. Loops until the user confirms adopt or merge (both leave the local file
# in place), or throws "install canceled by user" on quit. No return value — both callers treat a
# normal return as "resolved, leave the file alone."
function Invoke-RootConfigCollisionPrompt {
  param($Harness, $RepoRel, $HomePath)
  $src = Join-Path $repoRoot $RepoRel

  if (-not [Environment]::UserInteractive) {
    throw "$HomePath exists and PowerShell is not interactive. Run interactively or use -DryRun to inspect collisions."
  }

  while ($true) {
    Write-Host ""
    Write-Host "User-owned $Harness config exists:"
    Write-Host "  local:   $HomePath"
    Write-Host "  harness: $src"
    Write-Host ""
    Write-Host "Choose:"
    Write-Host "  1) adopt         keep local root config; install only clean harness links"
    Write-Host "  2) merge prompt  print merge prompt; leave root config unchanged"
    Write-Host "  q) quit"
    $choice = Read-Host "Selection [1/2/q]"

    switch ($choice) {
      { $_ -in @("1", "adopt") } {
        Write-Host ""
        Write-Host "Keeping local $HomePath. Harness defaults will not be installed for this file."
        Write-AgentMergePrompt $Harness "adopt existing" $RepoRel $HomePath
        if (Confirm-Choice "Continue by adopting existing local config?") {
          Write-Host "skip: $HomePath left in place"
          return
        }
      }
      { $_ -in @("2", "agent", "prompt") } {
        Write-AgentMergePrompt $Harness "manual merge before install" $RepoRel $HomePath
        if (Confirm-Choice "Skip this root config export for now?") {
          Write-Host "skip: $HomePath left in place"
          return
        }
      }
      { $_ -in @("q", "Q", "quit", "exit") } {
        throw "install canceled by user"
      }
      default {
        Write-Host "Invalid selection."
      }
    }
  }
}

function Export-UserConfig {
  param($Harness, $RepoRel, $HomePath)
  $src = Join-Path $repoRoot $RepoRel

  if (-not (Test-Path $src)) {
    Write-Warning "missing source: $src"
    return
  }

  if (Test-Path $HomePath) {
    $existing = Get-Item $HomePath -Force
    if ($existing.LinkType -eq "SymbolicLink" -and $existing.Target -eq $src) {
      if (-not $DryRun) {
        Remove-Item $HomePath
        Copy-Item $src $HomePath
      }
      Write-Host "copy: $HomePath <- $src (converted from repo symlink)"
      Write-RootConfigRecord $Harness $HomePath
      return
    }
    if ($existing.LinkType -ne "SymbolicLink" -and (Test-Path $HomePath -PathType Leaf)) {
      $srcHash = (Get-FileHash $src).Hash
      $homeHash = (Get-FileHash $HomePath).Hash
      if ($srcHash -eq $homeHash) {
        Write-Host "ok: $HomePath"
        Write-RootConfigRecord $Harness $HomePath
        return
      }

      # root_config files are mutable and expected to change between installs (new permissions,
      # hooks, MCP entries in the repo baseline). A byte mismatch against the current repo source
      # doesn't by itself mean the user touched the file — it may just mean the baseline moved on
      # since the last install/update. Only treat it as a real collision when the file drifted from
      # what roborepo itself last wrote. Mirrors the equivalent branch in install-lib.sh.
      $driftStatus = Get-RootConfigDriftStatus $Harness $HomePath
      if ($driftStatus -eq "clean") {
        if (-not $DryRun) {
          Copy-Item $src $HomePath -Force
        }
        Write-Host "copy: $HomePath <- $src (baseline changed, no local drift)"
        Write-RootConfigRecord $Harness $HomePath
        return
      }
    }
  } else {
    if (-not $DryRun) {
      New-Item -ItemType Directory -Force -Path (Split-Path $HomePath) | Out-Null
      Copy-Item $src $HomePath
    }
    Write-Host "copy: $HomePath <- $src"
    Write-RootConfigRecord $Harness $HomePath
    return
  }

  # Fallback safety net: in normal flow Invoke-RootConfigPreflight has already resolved every
  # root_config collision (and set adoptRootConfig, so this function is skipped for adopted rows).
  # This only runs if a drifted collision reaches here anyway — defer to the shared prompt.
  if ($DryRun) {
    Write-Host "collision: $HomePath"
    Write-Host "dry-run: would ask whether to keep existing config or print merge prompt"
    return
  }

  Invoke-RootConfigCollisionPrompt $Harness $RepoRel $HomePath
}

function Resolve-UserConfigCollision {
  param($Harness, $RepoRel, $HomePath)
  $src = Join-Path $repoRoot $RepoRel

  if (-not (Test-Path $src)) {
    Write-Warning "missing source: $src"
    return $false
  }

  if (Test-Path $HomePath) {
    $existing = Get-Item $HomePath -Force
    if ($existing.LinkType -eq "SymbolicLink" -and $existing.Target -eq $src) {
      return $false
    }
    if ($existing.LinkType -ne "SymbolicLink" -and (Test-Path $HomePath -PathType Leaf)) {
      $srcHash = (Get-FileHash $src).Hash
      $homeHash = (Get-FileHash $HomePath).Hash
      if ($srcHash -eq $homeHash) {
        return $false
      }

      # root_config files are mutable and the repo baseline is expected to change between installs.
      # A byte mismatch against the current source is only a real collision when the file ALSO
      # drifted from what roborepo itself last wrote — a clean file whose baseline simply moved on
      # must not be treated as a collision here, or the preflight would wrongly prompt the user and
      # set adopt, blocking the routine baseline update. Let Export-UserConfig do the silent update
      # in that case (it re-checks drift and copies). Mirrors the equivalent branch in
      # Export-UserConfig above and install-lib.sh's export_user_config.
      $driftStatus = Get-RootConfigDriftStatus $Harness $HomePath
      if ($driftStatus -eq "clean") {
        return $false
      }
    }
  } else {
    return $false
  }

  if ($DryRun) {
    Write-Host "collision: $HomePath"
    Write-Host "dry-run: would ask whether to keep existing config or print merge prompt"
    return $false
  }

  # A genuine drift collision: prompt (adopt or merge). Both outcomes leave the local file in place,
  # so the caller records this row as adopted ($true) and skips Export-UserConfig for it. Quit throws
  # inside the shared prompt.
  Invoke-RootConfigCollisionPrompt $Harness $RepoRel $HomePath
  return $true
}

function Test-CleanTarget {
  param($RepoRel, $HomePath)
  $src = Join-Path $repoRoot $RepoRel

  if (-not (Test-Path $HomePath)) {
    return $true
  }

  $existing = Get-Item $HomePath -Force
  if ($existing.LinkType -eq "SymbolicLink" -and $existing.Target -eq $src) {
    return $true
  }

  Write-Warning "conflict: $HomePath already exists and is not managed by this repo."
  Write-AgentMergePrompt "install" "resolve local path conflict" $RepoRel $HomePath
  return $false
}

function Copy-ManagedItem {
  param($RepoRel, $HomePath)
  $src = Join-Path $repoRoot $RepoRel

  if (-not (Test-Path $src)) {
    Write-Warning "missing source: $src"
    return
  }

  $parentDir = Split-Path -Parent $HomePath
  if (-not (Test-Path $parentDir)) {
    if ($DryRun) { Write-Host "would mkdir: $parentDir" }
    else { New-Item -ItemType Directory -Path $parentDir -Force | Out-Null }
  }

  if (Test-Path $HomePath) {
    $existing = Get-Item $HomePath -Force
    if ($existing.LinkType -eq "SymbolicLink") {
      if (-not $DryRun) { Remove-Item $HomePath -Force }
      Write-Host "reclaim (symlink): $HomePath"
    } else {
      # Already a real file/dir — check idempotency
      if ((Test-Path $HomePath -PathType Leaf) -and (Test-Path $src -PathType Leaf)) {
        $srcHash = (Get-FileHash $src).Hash
        $homeHash = (Get-FileHash $HomePath).Hash
        if ($srcHash -eq $homeHash) { Write-Host "ok: $HomePath"; return }
      } else {
        Write-Host "ok: $HomePath"
        return
      }
    }
  }

  if ($DryRun) { Write-Host "copy: $HomePath <- $src"; return }
  Copy-Item -Path $src -Destination $HomePath -Recurse -Force
  Write-Host "copy: $HomePath <- $src"
}

function Invoke-CleanTargetPreflight {
  $conflict = $false

  foreach ($row in Get-PresentManifestRows) {
    if ($row.Kind -ne "link") {
      continue
    }
    if (-not (Test-CleanTarget $row.RepoRel $row.HomePath)) {
      $conflict = $true
    }
  }

  if ($conflict) {
    throw "install has non-root config conflicts; no files were changed"
  }
}

function Invoke-RootConfigPreflight {
  $script:adoptRootConfig["claude"] = $false
  $script:adoptRootConfig["codex"] = $false

  foreach ($row in Get-PresentManifestRows) {
    if ($row.Kind -ne "root_config") {
      continue
    }
    if (Resolve-UserConfigCollision $row.Harness $row.RepoRel $row.HomePath) {
      $script:adoptRootConfig[$row.Harness] = $true
    }
  }
}

function Get-PresentHarnesses {
  $harnesses = @()
  foreach ($id in $KnownHarnessIds) {
    if ($HarnessPresence[$id]) {
      $harnesses += $id
    }
  }
  return $harnesses
}

function Get-PresentManifestRows {
  return Get-ManifestRows (Get-PresentHarnesses)
}

# Materialize a shared skill into the machine-local cache at ~/.roborepo/skills/<name>, stamped
# with a '.builtin-managed' marker file, then symlink each harness view to that cache entry.
# Legacy managed symlinks are migrated to the cache-backed view. A real dir without the marker is
# a native skill and is left untouched.
function Copy-GlobalSkills {
  param($HomeDir, [string[]]$AllowedNames = @())
  $srcDir = Join-Path $repoRoot "globals\system\skills"
  $skillsHome = Join-Path $HomeDir "skills"
  $cacheHome = Join-Path $env:USERPROFILE "$stateDirName\skills"

  if (-not (Test-Path $srcDir)) { return }

  Get-ChildItem $srcDir -Directory | ForEach-Object {
    $name = $_.Name
    if ($name.StartsWith(".")) { return }
    if (($AllowedNames.Count -gt 0) -and ($AllowedNames -notcontains $name)) { return }
    $skillMd = Join-Path $srcDir "$name\SKILL.md"
    if (-not (Test-Path $skillMd)) { return }
    if ($_.LinkType -eq "SymbolicLink") { return }  # skip symlinked source dirs

    $src = Join-Path $srcDir $name
    $cacheTarget = Join-Path $cacheHome $name
    $marker = Join-Path $cacheTarget ".builtin-managed"
    $target = Join-Path $skillsHome $name

    if (Test-Path $cacheTarget -PathType Any) {
      $existingCache = Get-Item $cacheTarget -Force
      if (($existingCache.LinkType -eq "SymbolicLink") -or ((Test-Path $cacheTarget -PathType Container) -and (-not (Test-Path $marker)))) {
        if ($existingCache.LinkType -eq "SymbolicLink") {
          if ($existingCache.Target -like "$repoRoot*" -or $existingCache.Target -like "$env:USERPROFILE\$stateDirName\skills*") {
            if (-not $DryRun) {
              Remove-Item $cacheTarget -Force -Recurse
            }
          } else {
            Write-Host "skip (unmanaged symlink): $cacheTarget"
            return
          }
        } elseif (-not $DryRun) {
          Remove-Item $cacheTarget -Force -Recurse
        }
      } elseif ((Test-Path $cacheTarget) -and (-not (Test-Path $marker))) {
        if (-not $DryRun) { Remove-Item $cacheTarget -Force -Recurse }
      }
    }

    if (-not $DryRun) {
      if (-not (Test-Path $cacheHome)) { New-Item -ItemType Directory -Path $cacheHome -Force | Out-Null }
      Copy-Item -Path $src -Destination $cacheTarget -Recurse -Force
      New-Item -ItemType File -Path $marker -Force | Out-Null
    }
    Write-Host "copy: $cacheTarget <- $src"

    # A real dir without our marker is a native-installed skill — leave it.
    if ((Test-Path $target) -and -not (Test-Path $target -PathType Leaf) -and -not (Test-Path (Join-Path $target ".builtin-managed"))) {
      Write-Host "skip (native skill): $target"
      return
    }

    $linkOk = $false
    if (Test-Path $target -PathType Any) {
      $existing = Get-Item $target -Force
      if ($existing.LinkType -eq "SymbolicLink" -and $existing.Target -eq $cacheTarget) {
        $linkOk = $true
      } elseif ($existing.LinkType -eq "SymbolicLink" -and ($existing.Target -like "$repoRoot*" -or $existing.Target -like "$env:USERPROFILE\$stateDirName\skills*")) {
        if (-not $DryRun) {
          Remove-Item $target -Force
          New-Item -ItemType SymbolicLink -Path $target -Target $cacheTarget -Force | Out-Null
        }
        Write-Host "relink: $target -> $cacheTarget"
        $linkOk = $true
      } elseif ($existing.LinkType -eq "SymbolicLink") {
        Write-Host "skip (unmanaged symlink): $target"
        return
      } elseif (Test-Path (Join-Path $target ".builtin-managed")) {
        if (-not $DryRun) {
          Remove-Item $target -Force -Recurse
          New-Item -ItemType SymbolicLink -Path $target -Target $cacheTarget -Force | Out-Null
        }
        Write-Host "relink: $target -> $cacheTarget"
        $linkOk = $true
      } else {
        Write-Host "skip (native skill): $target"
        return
      }
    }

    if (-not $linkOk) {
      if (-not $DryRun) {
        if (-not (Test-Path $skillsHome)) { New-Item -ItemType Directory -Path $skillsHome -Force | Out-Null }
        New-Item -ItemType SymbolicLink -Path $target -Target $cacheTarget -Force | Out-Null
      }
      Write-Host "link: $target -> $cacheTarget"
    } elseif (-not $DryRun -and -not (Test-Path $target)) {
      New-Item -ItemType SymbolicLink -Path $target -Target $cacheTarget -Force | Out-Null
      Write-Host "link: $target -> $cacheTarget"
    }
  }

  # Prune managed skill copies (those carrying our marker) whose source has been removed.
  if (-not (Test-Path $cacheHome)) { return }
  Get-ChildItem $cacheHome -Directory | ForEach-Object {
    $name = $_.Name
    if ($name.StartsWith(".")) { return }
    $entryMarker = Join-Path $_.FullName ".builtin-managed"
    if (-not (Test-Path $entryMarker)) { return }
    if (($AllowedNames.Count -gt 0) -and ($AllowedNames -notcontains $name)) {
      if (-not $DryRun) { Remove-Item $_.FullName -Recurse -Force }
      Write-Host "prune: $($_.FullName) (not in base skill set)"
      return
    }
    $skillMd = Join-Path $srcDir "$name\SKILL.md"
    if (Test-Path $skillMd) { return }
    if (-not $DryRun) { Remove-Item $_.FullName -Recurse -Force }
    Write-Host "prune: $($_.FullName) (source removed)"
    if (Test-Path $skillsHome) {
      $view = Join-Path $skillsHome $name
      if ((Test-Path $view) -and (Get-Item $view -Force).LinkType -eq "SymbolicLink") {
        if (-not $DryRun) { Remove-Item $view -Force }
        Write-Host "prune: $view (source removed)"
      }
    }
  }
}

function Render-HomeRules {
  param($Harness)
  $renderer = Join-Path $repoRoot "scripts\cli\rules-render.mjs"
  if (-not (Test-Path $renderer)) { return }
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { return }
  if ($DryRun) {
    & node $renderer --dry-run $Harness
  } else {
    & node $renderer $Harness
  }
}

function Invoke-ManifestRows {
  param($HarnessLabel, [string[]]$Harnesses)

  Write-Host ""
  Write-Host "--- $HarnessLabel ---"
  foreach ($row in Get-ManifestRows $Harnesses) {
    switch ($row.Kind) {
      "root_config" {
        if (-not $adoptRootConfig[$row.Harness]) {
          Export-UserConfig $row.Harness $row.RepoRel $row.HomePath
        }
      }
      "managed_copy" {
        Copy-ManagedItem $row.RepoRel $row.HomePath
      }
      "link" {
        Copy-ManagedItem $row.RepoRel $row.HomePath
      }
      "rendered_rules" {
        # Render after the manifest loop for this harness.
      }
      "cleanup" {
        Remove-RepoLink $row.HomePath
      }
    }
  }
}

# Detect which harnesses are present, from the same known-id set Get-PresentHarnesses iterates.
$HarnessPresence = @{}
foreach ($id in $KnownHarnessIds) {
  $HarnessPresence[$id] = Test-Path (Resolve-ManifestHomeRoot $id)
}

if (-not ($HarnessPresence.Values -contains $true)) {
  Write-Warning "No supported harness found (Claude Code: ~AppData\Roaming\Claude, Codex: ~\.codex, Gemini CLI: ~\.gemini)."
  Write-Warning "Install one of them first, then re-run this script."
  exit 1
}

Invoke-CleanTargetPreflight
Invoke-RootConfigPreflight

# Per-harness managed links, root config export, and per-skill links.
$HarnessDisplayNames = @{ claude = "Claude"; codex = "Codex"; gemini = "Gemini CLI" }
foreach ($id in $KnownHarnessIds) {
  if ($HarnessPresence[$id]) {
    Invoke-ManifestRows $HarnessDisplayNames[$id] @($id)
    Render-HomeRules $id
    $harnessHome = Resolve-ManifestHomeRoot $id
    Copy-GlobalSkills $harnessHome @("builtin-support")
  } else {
    Write-Host "skip: $($HarnessDisplayNames[$id]) — not found"
  }
}

# Post-install summary
Write-Host ""
Write-Host "Install complete."
foreach ($id in $KnownHarnessIds) {
  $status = if ($HarnessPresence[$id]) { "installed" } else { "skipped — not installed" }
  Write-Host "  $($HarnessDisplayNames[$id]): $status"
}
Write-Host ""
Write-Host "IMPORTANT: Hook scripts and bin/ commands require bash."
Write-Host "  Install Git for Windows: https://git-scm.com"
Write-Host "  Then add $(Join-Path $repoRoot 'bin') to your PATH or run install-global-commands.sh from Git Bash."
Write-Host ""
Write-Host "To add a harness later: install it, then re-run this script."
