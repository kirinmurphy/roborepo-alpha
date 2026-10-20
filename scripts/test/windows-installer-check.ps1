#!/usr/bin/env pwsh
# Windows-installer guardrails. The bash suite never touches install-windows.ps1, so nothing else
# in CI would notice if it stopped parsing or drifted from the provider manifests.
#
# Scope is deliberately static analysis, not an install: a real install mutates the runner's
# home directory and is not what this is guarding. What it guards is the drift that made Gemini
# invisible on Windows -- $KnownHarnessIds is a hand-maintained literal, so adding a provider to
# globals/harnesses/ silently leaves Windows behind with no failing check anywhere.
#
# Runs on windows-latest in CI; also runnable on macOS/Linux with PowerShell Core installed
# (`brew install --cask powershell`), since parsing and JSON reads are platform-independent.

$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$installer = Join-Path $repoRoot "scripts/install/install-windows.ps1"
$failures = @()

function Add-Failure { param([string]$Message) ; $script:failures += $Message }

# --- 1. The installer parses. A syntax error here is invisible to every other CI job. ---
if (-not (Test-Path $installer)) {
    Add-Failure "installer not found at $installer"
} else {
    $tokens = $null
    $parseErrors = $null
    [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors) | Out-Null
    if ($parseErrors -and $parseErrors.Count -gt 0) {
        foreach ($parseError in $parseErrors) {
            Add-Failure "parse error at line $($parseError.Extent.StartLineNumber): $($parseError.Message)"
        }
    } else {
        Write-Host "ok: install-windows.ps1 parses cleanly"
    }
}

# --- 2. $KnownHarnessIds matches the provider manifests. ---
# Windows does not yet DERIVE this list from the manifests (see the comment above
# $KnownHarnessIds in the installer). Until it does, the literal stays -- but it must stay in sync, and this check
# is what forces that.
$harnessDir = Join-Path $repoRoot "globals/harnesses"
$manifestIds = @(
    Get-ChildItem -Path $harnessDir -Directory |
        ForEach-Object { Join-Path $_.FullName "provider.json" } |
        Where-Object { Test-Path $_ } |
        ForEach-Object { (Get-Content $_ -Raw | ConvertFrom-Json).id } |
        Sort-Object
)

if ($manifestIds.Count -eq 0) {
    Add-Failure "no provider manifests found under $harnessDir"
}

$installerText = Get-Content $installer -Raw
if ($installerText -match '\$KnownHarnessIds\s*=\s*@\(([^)]*)\)') {
    $declaredIds = @(
        $Matches[1] -split ',' |
            ForEach-Object { $_.Trim().Trim('"').Trim("'") } |
            Where-Object { $_ -ne "" } |
            Sort-Object
    )

    $missing = @($manifestIds | Where-Object { $declaredIds -notcontains $_ })
    $extra = @($declaredIds | Where-Object { $manifestIds -notcontains $_ })

    if ($missing.Count -gt 0) {
        Add-Failure ("install-windows.ps1 `$KnownHarnessIds is missing provider(s): " + ($missing -join ", ") +
                     ". A provider was added under globals/harnesses/ without Windows support. Add it to " +
                     "`$KnownHarnessIds, `$adoptRootConfig, Resolve-ManifestHomeRoot, and `$HarnessDisplayNames.")
    }
    if ($extra.Count -gt 0) {
        Add-Failure ("install-windows.ps1 `$KnownHarnessIds names unknown provider(s): " + ($extra -join ", "))
    }
    if ($missing.Count -eq 0 -and $extra.Count -eq 0) {
        Write-Host ("ok: `$KnownHarnessIds matches provider manifests (" + ($manifestIds -join ", ") + ")")
    }
} else {
    Add-Failure "could not locate a `$KnownHarnessIds assignment in install-windows.ps1"
}

# --- 3. Every id in $KnownHarnessIds is handled by the per-harness lookups. ---
# A half-added provider (listed, but with no home root or display name) throws at install time on a
# user's machine. Cheap to catch here.
foreach ($id in $manifestIds) {
    if ($installerText -notmatch [regex]::Escape($id)) { continue }
    foreach ($lookup in @(
        @{ Name = "Resolve-ManifestHomeRoot"; Pattern = ('"' + $id + '"\s*{\s*return') },
        @{ Name = "HarnessDisplayNames";      Pattern = ('\$HarnessDisplayNames\s*=\s*@{[^}]*\b' + $id + '\s*=') }
    )) {
        if ($installerText -notmatch $lookup.Pattern) {
            Add-Failure "provider '$id' appears in install-windows.ps1 but has no $($lookup.Name) entry"
        }
    }
}

if ($failures.Count -gt 0) {
    Write-Host ""
    Write-Host "FAIL"
    foreach ($failure in $failures) { Write-Host "  $failure" }
    exit 1
}

Write-Host "windows installer checks passed"
