# installer\detect-hardware.ps1
# Détection matérielle + configuration runtime — conforme aux fonctions
# Get-HardwareProfile / Get-RecommendedRuntimeConfig / Get-BackendPlan /
# Write-RuntimeConfig des modules LIA-X (modules/hardware.ps1, modules/services.ps1)
param(
    [Parameter(Mandatory = $true)][string]$RootDir
)
$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "== $msg ==" }
function Write-Ok([string]$msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Info([string]$msg) { Write-Host "  $msg" }
function Write-WarnMsg([string]$msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }

try {
    $modulesDir = Join-Path $RootDir 'modules'
    foreach ($m in @('hardware.ps1')) {
        . (Join-Path $modulesDir $m)
    }
} catch {
    Write-Host "  [ERREUR] Modules introuvables : $($_.Exception.Message)"
    exit 1
}

# Chemins (identiques à config.json / paths)
$RuntimeDir        = Join-Path $RootDir 'runtime'
$RuntimeConfigPath = Join-Path $RuntimeDir 'host-runtime-config.json'
$HardwareProfilePath = Join-Path $RuntimeDir 'hardware-profile.json'
$ReleaseRoot       = Join-Path $RuntimeDir 'llama-releases'

Write-Step 'Détection du matériel'
$hardware = Get-HardwareProfile
$vendor   = [string]$hardware.vendor
Write-Info "GPU : $($hardware.label)"
if ($hardware.cpu) {
    Write-Info ("CPU : {0} ({1} cœurs physiques / {2} logiques)" -f $hardware.cpu.model, $hardware.cpu.physical_cores, $hardware.cpu.logical_processors)
}
if ($hardware.memory) {
    $GB = 1024 * 1024 * 1024
    Write-Info ("RAM : {0:N2} Go" -f ($hardware.memory.total_bytes / $GB))
}

# ── Analyse iGPU / dGPU ─────────────────────────────────────────────────────
# Re-classification robuste (complète la logique de modules/hardware.ps1) :
$gpuNames = @()
if ($hardware.gpu -and $hardware.gpu.devices) {
    $gpuNames = @($hardware.gpu.devices | ForEach-Object { [string]$_.name })
}
$isBasicRender = $gpuNames.Count -gt 0 -and ($gpuNames | Where-Object { $_ -match 'Basic Render|Microsoft Basic|Virtual' }).Count -eq $gpuNames.Count
$hasDiscrete = $false
$hasIntegrated = $false
if ($hardware.gpu -and $hardware.gpu.devices) {
    foreach ($dev in $hardware.gpu.devices) {
        $name = [string]$dev.name
        $integrated = $false
        if ($dev.PSObject.Properties['is_integrated']) { $integrated = [bool]$dev.is_integrated }
        # Reclassification : iGPU connus
        if ($name -match 'UHD Graphics|Iris|Arc\s*(\(TM\))?\s*\d\d0V|Radeon.*Graphics|Radeon\(TM\)|Vega|Ryzen.*Radeon|Graphics\s*\(|Iris Xe') { $integrated = $true }
        if ($name -match 'GeForce|Quadro|RTX|GTX|Arc\s*(\(TM\))?\s*A\d|Radeon\s+(RX|Pro|WX)|Instinct') { $integrated = $false }
        if ($integrated) { $hasIntegrated = $true } else { $hasDiscrete = $true }
        Write-Info ("  périphérique : {0} → {1}" -f $name, $(if ($integrated) { 'iGPU' } else { 'dGPU' }))
    }
}
$igpuOnly = ($hasIntegrated -and -not $hasDiscrete) -or ($gpuNames.Count -gt 0 -and -not $hasIntegrated -and -not $hasDiscrete -and $vendor -in @('intel','amd'))
if ($isBasicRender) {
    Write-WarnMsg 'Seul un périphérique virtuel (Microsoft Basic Render) est détecté : traitement comme CPU seul.'
    $vendor = 'cpu'
    $hardware.vendor = 'cpu'
    $hardware.gpu.vendor = 'cpu'
}
if ($igpuOnly) {
    Write-Info 'iGPU uniquement détecté (mémoire unifiée partagée avec la RAM).'
}
$hardware['is_igpu_only'] = [bool]$igpuOnly
if ($hardware.gpu -is [hashtable]) {
    $hardware.gpu['is_igpu_only'] = [bool]$igpuOnly
    $hardware.gpu['has_discrete'] = [bool]$hasDiscrete
} else {
    $hardware.gpu | Add-Member -NotePropertyName is_igpu_only -NotePropertyValue ([bool]$igpuOnly) -Force
    $hardware.gpu | Add-Member -NotePropertyName has_discrete -NotePropertyValue ([bool]$hasDiscrete) -Force
}


# Plan backend (conforme à Get-BackendPlan) — candidats dans l'ordre de priorité
$recommended = Get-RecommendedRuntimeConfig $hardware
$candidates = @()
switch ($vendor) {
    'nvidia' {
        $candidates = @(
            @{ backend = 'cuda';   label = 'NVIDIA CUDA'; assetPattern = '^llama-.*-bin-win-cuda-13\.1-x64\.zip$' },
            @{ backend = 'cuda';   label = 'NVIDIA CUDA'; assetPattern = '^llama-.*-bin-win-cuda-12\.4-x64\.zip$' },
            @{ backend = 'vulkan'; label = 'Vulkan';      assetPattern = '^llama-.*-bin-win-vulkan-x64\.zip$' },
            @{ backend = 'cpu';    label = 'CPU';         assetPattern = '^llama-.*-bin-win-cpu-x64\.zip$' }
        )
    }
    'amd' {
        $candidates = @(
            @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = '^llama-.*-bin-win-vulkan-x64\.zip$' },
            @{ backend = 'cpu';    label = 'CPU';    assetPattern = '^llama-.*-bin-win-cpu-x64\.zip$' }
        )
    }
    'intel' {
        $candidates = @(
            @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = '^llama-.*-bin-win-vulkan-x64\.zip$' },
            @{ backend = 'cpu';    label = 'CPU';    assetPattern = '^llama-.*-bin-win-cpu-x64\.zip$' }
        )
    }
    default {
        $candidates = @(
            @{ backend = 'cpu'; label = 'CPU'; assetPattern = '^llama-.*-bin-win-cpu-x64\.zip$' }
        )
    }
}

Write-Step "Sélection du runtime (backend recommandé : $($recommended.backend_label))"

# Installation HORS LIGNE : releases embarquées uniquement, sans téléchargement.
$selectedBackend = $null
$selectedLabel   = $null
$binaryPath      = $null

foreach ($candidate in $candidates) {
    # 1) Release locale déjà extraite (dossier <tag>-<backend>)
    $localDirs = Get-ChildItem -Path $ReleaseRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "-$([regex]::Escape($candidate.backend))$" }
    foreach ($dir in $localDirs) {
        $bin = Get-ChildItem -Path $dir.FullName -Filter 'llama-server.exe' -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($bin) {
            $selectedBackend = $candidate.backend
            $selectedLabel   = $candidate.label
            $binaryPath      = $bin.FullName
            break
        }
    }
    if ($binaryPath) { break }

    # 2) Archive locale (.zip déjà téléchargée)
    $localZips = Get-ChildItem -Path $ReleaseRoot -Filter '*.zip' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match $candidate.assetPattern }
    foreach ($zip in $localZips) {
        $tag = 'local'
        if ($zip.Name -match '^llama-(?<tag>[^-]+)-bin-win-') { $tag = $Matches.tag }
        $releaseDir = Join-Path $ReleaseRoot ("{0}-{1}" -f $tag, $candidate.backend)
        try {
            Write-Info "Extraction locale : $($zip.Name)"
            Expand-Archive -Path $zip.FullName -DestinationPath $releaseDir -Force
            $bin = Get-ChildItem -Path $releaseDir -Filter 'llama-server.exe' -File -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($bin) {
                $selectedBackend = $candidate.backend
                $selectedLabel   = $candidate.label
                $binaryPath      = $bin.FullName
                break
            }
        } catch {
            Write-WarnMsg "Extraction impossible : $($_.Exception.Message)"
        }
    }
    if ($binaryPath) { break }
}

# 3) Aucune release locale compatible → secours vulkan embarqué puis cpu
if (-not $binaryPath) {
    Write-WarnMsg 'Aucune release locale compatible. Recherche du binaire embarqué de secours.'
    foreach ($fallback in @('vulkan', 'cpu')) {
        $localDirs = Get-ChildItem -Path $ReleaseRoot -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match "-$fallback$" }
        foreach ($dir in $localDirs) {
            $bin = Get-ChildItem -Path $dir.FullName -Filter 'llama-server.exe' -File -Recurse -ErrorAction SilentlyContinue |
                Select-Object -First 1
            if ($bin) {
                $selectedBackend = $fallback
                $selectedLabel   = if ($fallback -eq 'vulkan') { 'Vulkan' } else { 'CPU' }
                $binaryPath      = $bin.FullName
                break
            }
        }
        if ($binaryPath) { break }
    }
}

if (-not $binaryPath) {
    Write-Host '  [ERREUR] Aucun runtime llama.cpp disponible (offline).'
    exit 1
}


Write-Ok ("Backend : {0} ({1})" -f $selectedLabel, $selectedBackend)
Write-Info "Binaire : $binaryPath"

# Contexte / gpu_layers recommandés (conforme à Write-RuntimeConfig)
$defaultContext   = $recommended.context
$defaultGpuLayers = 0
if ($selectedBackend -ne 'cpu') { $defaultGpuLayers = $recommended.gpu_layers }
# Si le plan recommande CUDA mais que le binaire déployé est Vulkan (embarqué),
# on conserve l'accélération GPU (999) — Vulkan fonctionne aussi sur NVIDIA.
if ($recommended.backend -eq 'cuda' -and $selectedBackend -eq 'vulkan') {
    $defaultGpuLayers = $recommended.gpu_layers
}

# Profil matériel (conforme à Save-HardwareProfile)
$existingProfile = $null
try {
    if (Test-Path $HardwareProfilePath) {
        $existingProfile = Get-Content -Path $HardwareProfilePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    }
} catch { $existingProfile = $null }
$generationCount = 1
if ($existingProfile -and $existingProfile.generation_count) {
    $generationCount = [int]$existingProfile.generation_count + 1
}
$hardware | Add-Member -NotePropertyName generation_count -NotePropertyValue $generationCount -Force
$hardware | Add-Member -NotePropertyName generated_at -NotePropertyValue ((Get-Date).ToString('o')) -Force
$hardware | ConvertTo-Json -Depth 6 -Compress | Set-Content -Path $HardwareProfilePath -Encoding UTF8
Write-Ok "Profil matériel : $HardwareProfilePath (generation_count=$generationCount)"

# Configuration runtime (conforme à Write-RuntimeConfig)
$config = [ordered]@{
    controller_port    = 13579
    server_port        = 12434
    backend            = $selectedBackend
    backend_label      = $selectedLabel
    binary_path        = $binaryPath
    models_dir         = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'LIA-X\Models')
    proxy_model_id     = 'lia-local'
    default_context    = $defaultContext
    default_gpu_layers = $defaultGpuLayers
    sleep_idle_seconds = 60
    server_port_start  = 12434
    server_port_end    = 12444
    max_instances      = 6
}
$config | ConvertTo-Json -Depth 5 -Compress | Set-Content -Path $RuntimeConfigPath -Encoding UTF8
Write-Ok "Configuration runtime : $RuntimeConfigPath"
Write-Info ("  contexte par défaut = {0}, gpu_layers = {1}" -f $defaultContext, $defaultGpuLayers)

exit 0

