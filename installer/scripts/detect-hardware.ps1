# installer\scripts\detect-hardware.ps1
# Détection matérielle + configuration runtime — conforme aux fonctions
# Get-HardwareProfile / Get-RecommendedRuntimeConfig / Get-BackendPlan /
# Write-RuntimeConfig de hardware.ps1 (deploiement : installer\scripts\)
param(
    [Parameter(Mandatory = $true)][string]$RootDir,
    [string]$ModelsDir = '',
    [int]$ControllerPort = 13579,
    [int]$LlamaPort = 12434,
    # Release llama.cpp utilisee au telechargement. Pincee pour reproductibilite ;
    # si le tag n'existe plus, le script retombe sur la release b* la plus recente.
    [string]$ReleaseTag = 'b11236',
    # Mise hors ligne stricte : n'appelle jamais le reseau.
    [switch]$NoDownload
)
# Dossier canonique des modèles GGUF : C:\Users\<utilisateur>\Documents\LIA-X\Models
# (identique à l'installateur Inno : {userdocs}\LIA-X\Models).
if ([string]::IsNullOrWhiteSpace($ModelsDir)) {
    $ModelsDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'LIA-X\Models'
}
if (-not (Test-Path -LiteralPath $ModelsDir)) {
    New-Item -ItemType Directory -Path $ModelsDir -Force | Out-Null
}

$ErrorActionPreference = 'Stop'

function Write-Step([string]$msg) { Write-Host "== $msg ==" }
function Write-Ok([string]$msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Info([string]$msg) { Write-Host "  $msg" }
function Write-WarnMsg([string]$msg) { Write-Host "  [WARN] $msg" -ForegroundColor Yellow }

# hardware.ps1 est deploye dans le meme dossier que ce script
# ({app}\installer\scripts\). On tente aussi l'ancien emplacement
# {app}\modules\ pour rester compatible avec une installation anterieure.
$hardwareCandidates = @(
    (Join-Path $PSScriptRoot 'hardware.ps1'),
    (Join-Path $RootDir 'installer\scripts\hardware.ps1'),
    (Join-Path $RootDir 'modules\hardware.ps1')
)
$hardwareModule = $hardwareCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $hardwareModule) {
    Write-Host "  [ERREUR] hardware.ps1 introuvable (cherche dans : $($hardwareCandidates -join ' | '))"
    exit 1
}
try {
    . $hardwareModule
} catch {
    Write-Host "  [ERREUR] Chargement de hardware.ps1 impossible : $($_.Exception.Message)"
    exit 1
}

# Chemins (identiques à config.json / paths)
$RuntimeDir        = Join-Path $RootDir 'runtime'
$RuntimeConfigPath = Join-Path $RuntimeDir 'host-runtime-config.json'
$HardwareProfilePath = Join-Path $RuntimeDir 'hardware-profile.json'
$ReleaseRoot       = Join-Path $RuntimeDir 'llama-releases'

# Sur une installation neuve, ni runtime\ ni llama-releases\ n'existent : ils
# sont crees ici, car c'est aussi la destination des archives telechargees.
foreach ($dir in @($RuntimeDir, $ReleaseRoot)) {
    if (-not (Test-Path -LiteralPath $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
}

# Purge des runtimes et archives obsolètes, AVANT toute sélection.
# Le runtime n'étant plus embarqué, il est téléchargé : sans cette purge, une
# réinstallation accumulerait les anciennes versions (85 Mo pour b11013-vulkan
# + 31 Mo pour le nouveau b11236) alors qu'un seul binaire est utilisé.
#
# Ne sont JAMAIS supprimés :
#  - le runtime correspondant au tag courant (il peut venir d'une tentative
#    précédente, et surtout il peut être le seul disponible hors ligne) ;
#  - tout dossier dont le nom ne ressemble pas à <tag>-<backend> : on ne
#    devine pas, on ne risque pas de supprimer un runtime inconnu.
function Remove-StaleLlamaReleases {
    param([string]$KeepTag)

    if (-not (Test-Path -LiteralPath $ReleaseRoot)) { return }

    # Motif strict : le dossier doit s'appeler <tag>-<backend>, le tag ayant la
    # forme d'une release llama.cpp (b11236). Tout ce qui ne suit pas ce nommage
    # est laisse intact : on ne devine pas, on ne risque pas de supprimer un
    # dossier inconnu.
    $dirs = @(Get-ChildItem -LiteralPath $ReleaseRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '^b\d+-(?<backend>[a-z0-9]+)$' })

    $staleDirs = @($dirs | Where-Object {
        $_.Name -notmatch ('^' + [regex]::Escape($KeepTag) + '-')
    })

    # Les .zip sont des telechargements intermediaires : on ne les supprime que
    # s'il reste au moins un runtime extrait (sinon c'est la seule copie
    # disponible, typiquement en mode hors ligne).
    $staleZips = @()
    if ($dirs.Count -gt 0) {
        $staleZips = @(Get-ChildItem -LiteralPath $ReleaseRoot -Filter '*.zip' -File -ErrorAction SilentlyContinue)
    }
    $staleZips += @(Get-ChildItem -LiteralPath $ReleaseRoot -Filter '*.partial' -File -ErrorAction SilentlyContinue)

    if ($staleDirs.Count -eq 0 -and $staleZips.Count -eq 0) { return }

    $freed = 0
    Write-Step 'Nettoyage des runtimes obsolètes'
    foreach ($dir in $staleDirs) {
        $size = (Get-ChildItem -LiteralPath $dir.FullName -Recurse -File -ErrorAction SilentlyContinue |
            Measure-Object -Property Length -Sum).Sum
        try {
            Remove-Item -LiteralPath $dir.FullName -Recurse -Force -ErrorAction Stop
            $freed += $size
            Write-Info ("  Supprimé {0} ({1:N1} Mo)" -f $dir.Name, ($size / 1MB))
        } catch {
            Write-WarnMsg ("  Impossible de supprimer {0} : {1}" -f $dir.Name, $_.Exception.Message)
        }
    }
    foreach ($zip in $staleZips) {
        $size = $zip.Length
        try {
            Remove-Item -LiteralPath $zip.FullName -Force -ErrorAction Stop
            $freed += $size
            Write-Info ("  Supprimé {0} ({1:N1} Mo)" -f $zip.Name, ($size / 1MB))
        } catch {
            Write-WarnMsg ("  Impossible de supprimer {0} : {1}" -f $zip.Name, $_.Exception.Message)
        }
    }
    if ($freed -gt 0) { Write-Ok ("Espace récupéré : {0:N1} Mo" -f ($freed / 1MB)) }
}

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
# Re-classification robuste (complète la logique de hardware.ps1) :
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


# Plan backend : source unique Get-BackendPlan (plus de liste dupliquee ici).
$plan = Get-BackendPlan $hardware
$recommended = @{
    backend       = $plan.recommended_backend
    backend_label = $plan.label
    context       = $plan.recommended_context
    gpu_layers    = $plan.recommended_gpu_layers
}
$candidates = @($plan.releaseCandidates)

Write-Step 'Capacites backend (detection reelle)'
foreach ($capName in @('cuda', 'rocm', 'vulkan', 'cpu')) {
    $cap = $plan.capabilities.$capName
    $state = if ($cap.available) { 'disponible  ' } else { 'indisponible' }
    Write-Info ("  {0,-7} : {1} - {2}" -f $capName, $state, $cap.detail)
}
if ($plan.gpu_memory) {
    $GBm = 1024 * 1024 * 1024
    Write-Info ("  memoire GPU : dediee {0:N2} Go / unifiee {1:N2} Go / utilisable {2:N2} Go ({3})" -f ($plan.gpu_memory.dedicated_bytes / $GBm), ($plan.gpu_memory.unified_bytes / $GBm), ($plan.gpu_memory.usable_bytes / $GBm), $plan.gpu_memory.source)
}
if ($plan.fallback_reason) { Write-WarnMsg "Repli backend : $($plan.fallback_reason)" }
Write-Step "Sélection du runtime (backend recommandé : $($recommended.backend_label))"

# ---------------------------------------------------------------------------
# Téléchargement du runtime llama.cpp (GitHub Releases)
#
# Le runtime n'est PAS embarqué dans l'installateur : le backend qui convient
# au matériel (CUDA sur NVIDIA, ROCm sur AMD, Vulkan, CPU) est téléchargé à
# l'installation. La source est officielle (github.com/ggml-org/llama.cpp) et
# chaque archive est vérifiée par son empreinte SHA-256 publiée par GitHub
# (champ `digest` de l'API), avant extraction.
# ---------------------------------------------------------------------------
$LlamaReleaseApi = 'https://api.github.com/repos/ggml-org/llama.cpp/releases'
$LlamaReleaseHeaders = @{ 'User-Agent' = 'LIA-X-Installer'; 'Accept' = 'application/vnd.github+json' }

# Résout le tag effectif : tag demandé s'il existe, sinon release b* la plus
# récente. Retourne $null si le réseau est indisponible.
function Resolve-LlamaReleaseTag {
    param([string]$PreferredTag)
    try {
        $preferred = Invoke-RestMethod -Uri "$LlamaReleaseApi/tags/$PreferredTag" -Headers $LlamaReleaseHeaders -TimeoutSec 30
        return @{ tag = [string]$preferred.tag_name; source = 'tag' }
    } catch {
        Write-WarnMsg "Tag $PreferredTag introuvable ou API injoignable, recherche de la release b* la plus recente"
    }
    try {
        $releases = Invoke-RestMethod -Uri "$LlamaReleaseApi?per_page=15" -Headers $LlamaReleaseHeaders -TimeoutSec 30
        $match = $releases | Where-Object { $_.tag_name -match '^b\d+$' } | Select-Object -First 1
        if ($match) { return @{ tag = [string]$match.tag_name; source = 'latest-b' } }
    } catch {
        Write-WarnMsg "Impossible de lister les releases : $($_.Exception.Message)"
    }
    return $null
}

# Charge l'index des assets d'un tag (nom -> url + digest SHA-256).
function Get-LlamaReleaseAssets {
    param([string]$Tag)
    try {
        $release = Invoke-RestMethod -Uri "$LlamaReleaseApi/tags/$Tag" -Headers $LlamaReleaseHeaders -TimeoutSec 30
        $assets = @{}
        foreach ($asset in $release.assets) {
            $assets[$asset.name] = @{
                url    = [string]$asset.browser_download_url
                size   = [int64]$asset.size
                digest = [string]$asset.digest
            }
        }
        return $assets
    } catch {
        Write-WarnMsg "Lecture des assets de $Tag impossible : $($_.Exception.Message)"
        return $null
    }
}

# Télécharge + vérifie + extrait l'asset correspondant au motif du candidat.
# Retourne le chemin de llama-server.exe, ou $null en cas d'échec (le candidat
# suivant sera alors essayé).
function Try-DownloadLlamaCppRelease {
    param(
        [hashtable]$Candidate,
        [hashtable]$AssetIndex,
        [string]$Tag
    )

    $pattern = [string]$Candidate.assetPattern
    $assetName = ($AssetIndex.Keys | Where-Object { $_ -match $pattern } | Select-Object -First 1)
    if (-not $assetName) {
        Write-Info ("  Aucun asset pour le motif {0} dans la release {1}" -f $pattern, $Tag)
        return $null
    }
    $asset = $AssetIndex[$assetName]

    $zipPath = Join-Path $ReleaseRoot $assetName
    $sizeMo  = [math]::Round($asset.size / 1MB, 1)

    Write-Info ("  Téléchargement {0} ({1} Mo)" -f $assetName, $sizeMo)
    try {
        # -UseBasicParsing évite le moteur IE obsolète ; le flux est ecrit en
        # .partial puis renomme : un download interrompu ne laisse jamais une
        # archive tronquee exploitable.
        $partial = "$zipPath.partial"
        if (Test-Path -LiteralPath $partial) { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue }
        Invoke-WebRequest -Uri $asset.url -OutFile $partial -UseBasicParsing -TimeoutSec 900
        Move-Item -LiteralPath $partial -Destination $zipPath -Force
    } catch {
        Write-WarnMsg ("  Téléchargement échoué : {0}" -f $_.Exception.Message)
        return $null
    }

    # Vérification d'intégrité : SHA-256 attendu fourni par l'API GitHub.
    $expected = ''
    if ($asset.digest -match '^sha256:(?<hex>[0-9a-fA-F]{64})$') { $expected = $Matches.hex.ToLowerInvariant() }
    if ($expected) {
        $actual = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $expected) {
            Write-WarnMsg "  SHA-256 invalide (attendu $expected, obtenu $actual)"
            Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue
            return $null
        }
        Write-Ok ("  SHA-256 vérifié ({0})" -f $actual.Substring(0, 16))
    } else {
        Write-WarnMsg "  Empreinte SHA-256 non publiée par GitHub pour cet asset : archive conservée sans vérification"
    }

    $releaseDir = Join-Path $ReleaseRoot ("{0}-{1}" -f $Tag, $Candidate.backend)
    try {
        Write-Info "  Extraction dans $releaseDir"
        if (Test-Path -LiteralPath $releaseDir) { Remove-Item -LiteralPath $releaseDir -Recurse -Force }
        Expand-Archive -Path $zipPath -DestinationPath $releaseDir -Force
    } catch {
        Write-WarnMsg ("  Extraction impossible : {0}" -f $_.Exception.Message)
        return $null
    }
    $bin = Get-ChildItem -Path $releaseDir -Filter 'llama-server.exe' -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($bin) { return $bin.FullName }
    Write-WarnMsg "  llama-server.exe absent de l'archive extraite"
    return $null
}

# Résolution du runtime : releases locales d'abord (dossier <tag>-<backend> ou
# .zip déjà présent), puis téléchargement de la release officielle correspondant
# au backend recommandé. Chaque binaire candidat est VALIDE
# (llama-server.exe --version) avant d'être retenu : un backend dont le binaire
# ne démarre pas est écarté au profit du candidat suivant, au lieu d'être
# installé et de casser au premier chargement.
$selectedBackend  = $null
$selectedLabel    = $null
$binaryPath       = $null
$binaryValidation = $null
$binaryFailures   = @()

# Résolution de la release (une seule fois, partagée par tous les candidats).
# En mode -NoDownload ou hors ligne, l'index reste vide : seuls les runtimes
# locaux (étapes 1 et 2) sont considérés, et l'installation peut échouer
# proprement si aucun n'est présent.
$effectiveTag    = $ReleaseTag
$assetIndex      = @{}
if ($NoDownload) {
    Write-Info 'Mode hors ligne (-NoDownload) : aucun téléchargement ne sera tenté.'
} else {
    $resolved = Resolve-LlamaReleaseTag -PreferredTag $ReleaseTag
    if ($resolved) {
        $effectiveTag = $resolved.tag
        Write-Info ("Release llama.cpp : {0} (résolution : {1})" -f $effectiveTag, $resolved.source)
        $loaded = Get-LlamaReleaseAssets -Tag $effectiveTag
        if ($loaded) { $assetIndex = $loaded; Write-Info ("Assets disponibles : {0}" -f $assetIndex.Count) }
    } else {
        Write-WarnMsg 'GitHub injoignable : seuls les runtimes locaux seront utilisés.'
    }
}

# Purge des runtimes obsolètes, une fois le tag effectif connu : on conserve
# exactement <tag courant>-<backend> pour chaque backend, et on supprime le
# reste. Placée ici (et non avant) pour ne pas effacer un runtime utilisable
# si la résolution du tag échoue.
Remove-StaleLlamaReleases -KeepTag $effectiveTag

foreach ($candidate in $candidates) {
    $candidateBinary = $null

    # 1) Release locale deja extraite (dossier <tag>-<backend>)
    $localDirs = Get-ChildItem -Path $ReleaseRoot -Directory -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match "-$([regex]::Escape($candidate.backend))$" }
    foreach ($dir in $localDirs) {
        $bin = Get-ChildItem -Path $dir.FullName -Filter 'llama-server.exe' -File -Recurse -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if ($bin) { $candidateBinary = $bin.FullName; break }
    }

    # 2) Archive locale (.zip deja telechargee)
    if (-not $candidateBinary) {
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
                if ($bin) { $candidateBinary = $bin.FullName; break }
            } catch {
                Write-WarnMsg "Extraction impossible : $($_.Exception.Message)"
            }
        }
    }

    # 3) Telechargement de la release correspondant au backend candidat
    if (-not $candidateBinary -and $assetIndex.Count -gt 0) {
        $candidateBinary = Try-DownloadLlamaCppRelease -Candidate $candidate -AssetIndex $assetIndex -Tag $effectiveTag
    }

    if (-not $candidateBinary) { continue }

    # 3) Validation REELLE du binaire candidat
    $probe = Test-LlamaBinary -BinaryPath $candidateBinary
    if ($probe.ok) {
        $selectedBackend  = $candidate.backend
        $selectedLabel    = $candidate.label
        $binaryPath       = $candidateBinary
        $binaryValidation = $probe
        Write-Ok ("Binaire {0} valide (version : {1})" -f $candidate.backend, $(if ($probe.version) { $probe.version } else { 'inconnue' }))
        break
    }

    $binaryFailures += ("{0} : {1}" -f $candidate.backend, $probe.error)
    Write-WarnMsg ("Binaire {0} non valide : {1}" -f $candidate.backend, $probe.error)
}

if (-not $binaryPath) {
    Write-Host '  [ERREUR] Aucun runtime llama.cpp validable (local et reseau).'
    if (-not $assetIndex.Count) { Write-Host '    Aucun runtime local, et le telechargement a ete indisponible.' }
    foreach ($failure in $binaryFailures) { Write-Host "    - $failure" }
    exit 1
}

Write-Ok ("Backend : {0} ({1})" -f $selectedLabel, $selectedBackend)
Write-Info "Binaire : $binaryPath"
Write-Info ("Validation binaire : {0}" -f $(if ($binaryValidation.ok) { 'OK' } else { 'NON VALIDE' }))

# Contexte / gpu_layers recommandes (conforme a Write-RuntimeConfig)
$defaultContext   = $recommended.context
$defaultGpuLayers = 0
if ($selectedBackend -ne 'cpu') { $defaultGpuLayers = $recommended.gpu_layers }
# Si le plan recommande CUDA/ROCm mais que le binaire retenu est Vulkan, on
# conserve l'acceleration GPU (Vulkan fonctionne aussi sur NVIDIA/AMD).
if ($recommended.backend -in @('cuda', 'rocm') -and $selectedBackend -eq 'vulkan') {
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
    controller_port      = $ControllerPort
    server_port          = $LlamaPort
    backend              = $selectedBackend
    backend_label        = $selectedLabel
    recommended_backend  = $plan.recommended_backend
    proven_backends      = @($plan.proven_backends)
    plan_fallback_reason = [string]$plan.fallback_reason
    capabilities         = $plan.capabilities
    gpu_memory           = $plan.gpu_memory
    binary_path          = $binaryPath
    binary_validated     = [bool]$binaryValidation.ok
    binary_version       = [string]$binaryValidation.version
    binary_validated_at  = [string]$binaryValidation.tested_at
    binary_error         = [string]$binaryValidation.error
    release_tag          = $effectiveTag
    runtime_source       = $(if ($NoDownload) { 'offline' } elseif ($assetIndex.Count) { 'github-release' } else { 'local-only' })
    models_dir           = $ModelsDir
    proxy_model_id       = 'lia-local'
    default_context      = $defaultContext
    default_gpu_layers   = $defaultGpuLayers
    sleep_idle_seconds   = 60
    server_port_start    = $LlamaPort
    server_port_end      = ($LlamaPort + 10)
    max_instances        = 6
    hardware_detected_at = [string]$hardware.detected_at
}
$config | ConvertTo-Json -Depth 8 -Compress | Set-Content -Path $RuntimeConfigPath -Encoding UTF8

Write-Ok "Configuration runtime : $RuntimeConfigPath"
Write-Info ("  contexte par défaut = {0}, gpu_layers = {1}" -f $defaultContext, $defaultGpuLayers)

exit 0

