<#
  LIA-X Uninstall Cleanup — exécuté par le désinstalleur Inno ([UninstallRun])
  AVANT la suppression des fichiers (Inno exécute [UninstallRun] en premier).
  Ordre impératif :
    1. Services Windows STOPPÉS (sinon le contrôleur relance llama-server
       en boucle et les DLL restent verrouillées).
    2. TOUS les processus llama-server.exe TUÉS (toutes les instances :
       runtime llama-releases, dev, orphelines) + attente de libération.
    3. Conteneurs Docker stoppés/supprimés.
    4. Raccourcis Bureau / Menu Démarrer / Dossier Démarrage supprimés
       (postinstall.ps1 les crée via [Environment]::GetFolderPath, donc dans
       lesemplacements UTILISATEUR, pas {commonprograms} ni {userdesktop}).
    5. Marqueur d'installation supprimé.
  Les modèles GGUF et les volumes Docker sont CONSERVÉS par défaut
  (switch -Full pour tout purger).
#>
param(
    [Parameter(Mandatory = $true)][string]$InstallDir,
    [switch]$Full
)

$ErrorActionPreference = 'Continue'

function Write-Info($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    WARN: $msg" -ForegroundColor Yellow }

function Stop-LlamaServerProcesses {
    param([int]$MaxWaitSec = 20)
    # 1er passage : arret doux (laisse llama-server finir la requete en cours)
    $procs = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { return }
    foreach ($p in $procs) {
        try { Stop-Process -Id $p.Id -ErrorAction SilentlyContinue } catch { }
    }
    # Attente de sortie volontaire (5 s max)
    Start-Sleep -Seconds 5
    # 2e passage : kill force des recalcitrants
    $remaining = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)
    foreach ($p in $remaining) {
        try { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue } catch { }
    }
    # 3e passage : taskkill ceinture + bretelles (autres sessions / enfants)
    & taskkill.exe /F /IM llama-server.exe /T 2>$null | Out-Null
    # Attente de liberation reelle des handles (DLL ggml-*) — boucle courte
    # pour ne pas bloquer le desinstalleur en mode silencieux.
    $deadline = (Get-Date).AddSeconds($MaxWaitSec)
    while ((Get-Date) -lt $deadline) {
        $still = @(Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)
        if ($still.Count -eq 0) { break }
        Start-Sleep -Seconds 1
    }
}

Write-Info "Nettoyage LIA-X ($InstallDir)..."

# ── 1. Services Windows D'ABORD (sinon ils relancent llama-server) ───────
# runhidden : aucune sortie console = le desinstalleur ne reste jamais
# bloque sur un prompt ou un pipe plein.
$nssm = Join-Path $InstallDir 'tools\nssm\nssm.exe'
foreach ($svc in @('LIA Controller', 'LIA GPU Metrics')) {
    if (Test-Path -LiteralPath $nssm) {
        & $nssm stop $svc 2>$null | Out-Null
        Start-Sleep -Seconds 2
        & $nssm remove $svc confirm 2>$null | Out-Null
    }
    & sc.exe stop $svc 2>$null | Out-Null
    Start-Sleep -Seconds 1
    & sc.exe delete $svc 2>$null | Out-Null
}

# ── 2. TOUS les llama-server.exe (le controleur etant mort, plus de respawn)
Stop-LlamaServerProcesses -MaxWaitSec 20

# ── 3. Conteneurs Docker (timeouts courts : docker peut pendre si le
# daemon est arrete ; on ne doit jamais bloquer la fermeture) ───────────
try {
    $dockerInfo = & docker info 2>$null
    if ($LASTEXITCODE -eq 0) {
        foreach ($c in @('model-loader', 'anythingllm', 'anything-llm', 'openwebui', 'open-webui', 'librechat', 'librechat-mongo')) {
            & docker stop --time 5 $c 2>$null | Out-Null
            & docker rm -f $c 2>$null | Out-Null
        }
        if ($Full) {
            & docker volume rm anythingllm-storage open-webui-data librechat-data librechat-mongo 2>$null | Out-Null
        }
    }
} catch { }

# ── 4. Raccourcis ( crees par postinstall.ps1 via [Environment]::GetFolderPath,
#      donc Bureau/Menu Demarrer/Demarrage UTILISATEUR, et non {commonprograms}
#      ni {userdesktop} : sans cette suppression ils restent sur le poste) ───
$shortcutTargets = @(
    # Bureau utilisateur (peut etre redirige OneDrive)
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'LIA-X Model Manager.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Desktop')) 'LIA-X Model Manager.url'),
    # Menu Demarrer utilisateur + Menu commun
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'LIA-X\LIA-X Model Manager.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'LIA-X\LIA-X - Ajouter interfaces.lnk'),
    (Join-Path ([Environment]::GetFolderPath('Programs')) 'LIA-X\Documentation LIA-X.lnk'),
    (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'LIA-X\LIA-X Model Manager.lnk'),
    (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'LIA-X\LIA-X Model Manager.url'),
    (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'LIA-X\Documentation LIA-X.lnk'),
    (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'LIA-X\LIA-X - Ajouter interfaces.lnk'),
    # Dossier Demarrage : le host launcher ne doit plus relancer LIA-X
    (Join-Path ([Environment]::GetFolderPath('Startup')) 'LIA-X Host Launcher.lnk')
)
foreach ($lnk in $shortcutTargets) {
    if (-not $lnk) { continue }
    # Retire un eventuel separateur final pour un Test-Path exact
    $lnk = $lnk.TrimEnd('\')
    if (Test-Path -LiteralPath $lnk) {
        Remove-Item -LiteralPath $lnk -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $lnk)) { Write-Ok "Raccourci supprime : $lnk" }
    }
}
# Dossier du groupe de programmes une fois vide
foreach ($group in @((Join-Path ([Environment]::GetFolderPath('Programs')) 'LIA-X'),
                     (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) 'LIA-X'))) {
    if (-not $group) { continue }
    if ((Test-Path -LiteralPath $group) -and
        -not (Get-ChildItem -LiteralPath $group -Force -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $group -Force -Recurse -ErrorAction SilentlyContinue
    }
}

# ── 5. Runtime llama.cpp ─────────────────────────────────────────────────
# Le runtime est TELECHARGE a l'installation (plus d'embarquement) : jusqu'a
# 245 Mo selon le backend (CUDA 153 Mo, ROCm 245 Mo, Vulkan 31 Mo, CPU 19 Mo).
# Sans cette suppression, il resterait sur le disque apres desinstallation.
# Les modeles ({userdocs}\LIA-X\Models) ne sont PAS concernes : ils sont
# separes, dans le dossier Documents, et jamais supprimes.
$releaseRoot = Join-Path $InstallDir 'runtime\llama-releases'
if (Test-Path -LiteralPath $releaseRoot) {
    $runtimeSize = (Get-ChildItem -LiteralPath $releaseRoot -Recurse -File -ErrorAction SilentlyContinue |
        Measure-Object -Property Length -Sum).Sum
    try {
        Remove-Item -LiteralPath $releaseRoot -Recurse -Force -ErrorAction Stop
        Write-Ok ("Runtime llama.cpp supprime ({0:N1} Mo)" -f ($runtimeSize / 1MB))
    } catch {
        Write-Info ("Runtime llama.cpp partiellement supprime : {0}" -f $_.Exception.Message)
        # Some .dll stay locked by a leftover process; force it.
        Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 1
        Remove-Item -LiteralPath $releaseRoot -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path -LiteralPath $releaseRoot) {
            Write-Info "Des fichiers du runtime sont encore verrouilles ; supprimez {0} manuellement." -f $releaseRoot
        }
    }
}

# ── 6. Marqueur d'installation ───────────────────────────────────────────
$marker = Join-Path $InstallDir '.install-paths.json'
if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue }

Write-Ok 'Nettoyage terminé.'
