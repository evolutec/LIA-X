# modules/common.ps1
# Fonctions communes utilisées par lia.ps1

$ErrorActionPreference = "Stop"
$ScriptName = "common.ps1"
$ScriptDir = Split-Path -Parent $PSCommandPath
$ScriptPath = Join-Path $ScriptDir $ScriptName

function Confirm-Command([string]$cmd) {
    [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
}

function Test-IsAdministrator {
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-PreferredPowerShellExecutable {
    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if ($pwsh) {
        return $pwsh.Source
    }
    return (Get-Command powershell.exe -ErrorAction Stop).Source
}

function Step([string]$n, [string]$msg) {
    Write-Host "`n── [$n] $msg" -ForegroundColor Cyan
}

function OK([string]$msg)   { Write-Host "  ✅ $msg" -ForegroundColor Green }
function WARN([string]$msg) { Write-Host "  ⚠️  $msg" -ForegroundColor Yellow }
function FAIL([string]$msg) { Write-Host "  ❌ $msg" -ForegroundColor Red; exit 1 }
function INFO([string]$msg) { Write-Host "  ℹ️  $msg" -ForegroundColor DarkCyan }

function Ensure-Directory([string]$path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Ensure-WingetPackage([string]$id, [string]$name, [string]$checkCommand = "", [string]$override = "") {
    $isInstalled = $false
    if ($checkCommand) {
        $isInstalled = Confirm-Command $checkCommand
    } else {
        $wingetListOutput = winget list --id $id -e --accept-source-agreements 2>&1
        if ($LASTEXITCODE -eq 0 -and ($wingetListOutput -join "`n") -notmatch 'No installed package found') {
            $isInstalled = $true
        }
    }

    if (-not $isInstalled) {
        INFO "Installation $name"
        $args = @('install', '--id', $id, '-e', '--silent', '--accept-source-agreements', '--accept-package-agreements')
        if ($override) {
            $args += @('--override', $override)
        }
        winget @args
        if ($LASTEXITCODE -ne 0) {
            if ($checkCommand) {
                $isInstalled = Confirm-Command $checkCommand
            } else {
                $wingetListOutput = winget list --id $id -e --accept-source-agreements 2>&1
                $isInstalled = ($LASTEXITCODE -eq 0 -and ($wingetListOutput -join "`n") -notmatch 'No installed package found')
            }

            if (-not $isInstalled) {
                FAIL "Installation impossible : $name"
            }
        }

        if (-not $isInstalled) {
            if ($checkCommand) {
                $isInstalled = Confirm-Command $checkCommand
            } else {
                $wingetListOutput = winget list --id $id -e --accept-source-agreements 2>&1
                $isInstalled = ($LASTEXITCODE -eq 0 -and ($wingetListOutput -join "`n") -notmatch 'No installed package found')
            }
        }

        if (-not $isInstalled) {
            FAIL "Installation impossible : $name"
        }
    }

    OK "$name prêt"
}

function Wait-HttpOk([string]$url, [int]$maxTries = 30, [int]$delay = 3) {
    for ($i = 0; $i -lt $maxTries; $i++) {
        try {
            $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        } catch {}
        Start-Sleep -Seconds $delay
    }
    return $false
}

function Open-Tabs([string[]]$urls) {
    $chromePaths = @(
        "${env:ProgramFiles}\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
    )
    $chrome = $chromePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
    if ($chrome) {
        Start-Process $chrome ($urls -join " ")
    } else {
        $urls | ForEach-Object { Start-Process $_ }
    }
}

function Get-InterfaceChoice {
    Write-Host "`nInterfaces disponibles :" -ForegroundColor White
    Write-Host "  1) Open WebUI" -ForegroundColor Gray
    Write-Host "  2) AnythingLLM" -ForegroundColor Gray
    Write-Host "  3) LibreChat" -ForegroundColor Gray
    Write-Host "  4) Tous" -ForegroundColor Gray

    # Pour les tests automatisés, utiliser une valeur par défaut
    if ($env:CI -or $env:AUTOMATED_TEST) {
        Write-Host "Mode automatisé : sélection de Open WebUI (1)" -ForegroundColor Yellow
        return "1"
    }

    do {
        try {
            $choice = (Read-Host "Choix [1/2/3/4]").Trim()
            if ($choice -in @('1', '2', '3', '4')) {
                return $choice
            }
        } catch {
            # En cas d'erreur (pas d'entrée interactive), utiliser la valeur par défaut
            Write-Host "Mode non-interactif : sélection de Open WebUI (1)" -ForegroundColor Yellow
            return "1"
        }
    } while ($true)
}