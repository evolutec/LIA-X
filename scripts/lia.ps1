# Chargement de la configuration et des modules
$ErrorActionPreference = "Stop"

# Chargement de la configuration depuis config.json
$configPath = Join-Path $PSScriptRoot "..\config.json"
if (-not (Test-Path $configPath)) {
    throw "Fichier de configuration introuvable : $configPath"
}
$Config = Get-Content $configPath -Raw | ConvertFrom-Json

# Conversion en Hashtable et construction des chemins absolus
$configHashtable = @{}
foreach ($property in $Config.PSObject.Properties) {
    $configHashtable[$property.Name] = $property.Value
}
$configHashtable['rootDir'] = Split-Path -Parent $PSScriptRoot
$configHashtable['modelsDir'] = Join-Path $configHashtable.rootDir $configHashtable.paths.modelsDir
$configHashtable.paths.runtimeConfigPath = Join-Path $configHashtable.rootDir $configHashtable.paths.runtimeConfigPath
$configHashtable.paths.runtimeStatePath = Join-Path $configHashtable.rootDir $configHashtable.paths.runtimeStatePath
$configHashtable.paths.hardwareProfilePath = Join-Path $configHashtable.rootDir $configHashtable.paths.hardwareProfilePath
$Config = $configHashtable

# Chargement des modules
$modulesPath = Join-Path $PSScriptRoot "..\modules"
$moduleFiles = @('common.ps1', 'docker.ps1', 'hardware.ps1', 'llama.ps1', 'services.ps1')
foreach ($moduleFile in $moduleFiles) {
    $modulePath = Join-Path $modulesPath $moduleFile
    if (Test-Path $modulePath) {
        . $modulePath
    } else {
        throw "Module introuvable : $modulePath"
    }
}

# Fonctions spécifiques aux conteneurs (utilisant la fonction générique)
function Start-ModelLoaderContainer {
    $modelMountArg = "type=bind,source=$($Config.modelsDir),target=/models"
    $runtimeMountArg = "type=bind,source=$(Join-Path $Config.rootDir $Config.paths.runtimeDir),target=/runtime,readonly"

    $additionalArgs = @(
        '-e', "LLAMA_HOST_CONTROL_URL=http://host.docker.internal:$($Config.ports.controller)",
        '-e', "LLAMA_SERVER_BASE_URL=http://host.docker.internal:$($Config.ports.llama)",
        '-e', 'MODEL_STORAGE_DIR=/models',
        '-e', 'RUNTIME_STATE_PATH=/runtime/host-runtime-state.json',
        '-e', 'PROXY_MODEL_ID=lia-local',
        '--mount', $modelMountArg,
        '--mount', $runtimeMountArg,
        '--restart', 'unless-stopped',
        '--health-cmd', 'curl -fsS http://localhost:3002/health > /dev/null || exit 1',
        '--health-interval', '15s',
        '--health-timeout', '3s',
        '--health-retries', '2'
    )

    Start-DockerContainer `
        -ContainerName 'model-loader' `
        -ImageName $Config.docker.images.modelLoader `
        -LiaImageName $Config.docker.liaImages.modelLoader `
        -InternalPort 3002 `
        -ExternalPort $Config.ports.loader `
        -NetworkName $Config.docker.network `
        -Config $Config `
        -AdditionalArgs $additionalArgs `
        -HealthCheckUrl "http://127.0.0.1:$($Config.ports.loader)/health"

    # Vérification du mount /models
    $inspectionRaw = docker inspect model-loader 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Impossible d'inspecter le conteneur model-loader après démarrage."
    }

    $inspection = $inspectionRaw | ConvertFrom-Json
    $mounts = @($inspection[0].Mounts)
    $modelsDirResolved = (Resolve-Path -LiteralPath $Config.modelsDir).Path

    $modelsMountOk = $false
    foreach ($mount in $mounts) {
        if ($mount.Destination -ne '/models') { continue }
        if ($mount.Type -ne 'bind') { continue }
        $source = [string]$mount.Source
        if ($source -eq $modelsDirResolved -or $source -eq $Config.modelsDir) {
            $modelsMountOk = $true
            break
        }
    }

    if (-not $modelsMountOk) {
        throw "Mount /models invalide: bind mount vers '$modelsDirResolved' absent."
    }

    OK "Model Loader prêt sur http://localhost:$($Config.ports.loader)"
}

function Start-AnythingLLMContainer {
    $additionalArgs = @(
        '-v', 'anythingllm-storage:/app/server/storage',
        '--restart', 'unless-stopped'
    )

    Start-DockerContainer `
        -ContainerName 'anythingllm' `
        -ImageName $Config.docker.images.anythingllm `
        -LiaImageName $Config.docker.liaImages.anythingllm `
        -InternalPort 3001 `
        -ExternalPort $Config.ports.anything `
        -NetworkName $Config.docker.network `
        -Config $Config `
        -AdditionalArgs $additionalArgs `
        -HealthCheckUrl "http://127.0.0.1:$($Config.ports.anything)"
}

function Start-OpenWebUiContainer {
    $additionalArgs = @(
        '-v', 'open-webui-data:/app/backend/data',
        '--restart', 'unless-stopped'
    )

    Start-DockerContainer `
        -ContainerName 'open-webui' `
        -ImageName $Config.docker.images.openWebUi `
        -LiaImageName $Config.docker.liaImages.openWebUi `
        -InternalPort 8080 `
        -ExternalPort $Config.ports.openWebUi `
        -NetworkName $Config.docker.network `
        -Config $Config `
        -AdditionalArgs $additionalArgs `
        -HealthCheckUrl "http://127.0.0.1:$($Config.ports.openWebUi)"
}

function Start-LibreChatContainer {
    # Démarrer MongoDB requis pour LibreChat
    Remove-Container 'librechat-mongo'
    docker run -d `
        --name librechat-mongo `
        --network $Config.docker.network `
        -v librechat-mongo:/data/db `
        --restart unless-stopped `
        mongo:6 | Out-Null

    $additionalArgs = @(
        '-v', 'librechat-data:/app/api/data',
        '--restart', 'unless-stopped'
    )

    Start-DockerContainer `
        -ContainerName 'librechat' `
        -ImageName $Config.docker.images.libreChat `
        -LiaImageName $Config.docker.liaImages.libreChat `
        -InternalPort $Config.ports.libreChatInternal `
        -ExternalPort $Config.ports.libreChat `
        -NetworkName $Config.docker.network `
        -Config $Config `
        -AdditionalArgs $additionalArgs `
        -HealthCheckUrl "http://127.0.0.1:$($Config.ports.libreChat)"
}

# Logique principale refactorisée
OK "Docker opérationnel"

# Normalisation de la configuration runtime existante
Normalize-RuntimeConfig

Step "2/6" "Choix interface"
$interfaceChoice = Get-InterfaceChoice
OK "Sélection utilisateur enregistrée"

Step "3/6" "Détection matériel et préparation llama.cpp"
$hardware = Get-HardwareProfile
$plan = Get-BackendPlan $hardware
Save-HardwareProfile $Config $hardware
INFO "Matériel détecté : $($hardware.label)"
if ($hardware.cpu) {
    INFO "CPU détecté : $($hardware.cpu.model) | cœurs physiques : $($hardware.cpu.physical_cores) | threads : $($hardware.cpu.logical_processors)"
}
if ($hardware.memory) {
    $GB = 1024 * 1024 * 1024
    INFO "RAM détectée : $([math]::Round($hardware.memory.total_bytes / $GB, 2)) Go"
}
INFO "Backend cible : $($plan.label)"

$buildResult = Build-LlamaCpp $plan
$llamaServerBinary = $buildResult.binaryPath
if (-not $llamaServerBinary) { $llamaServerBinary = Resolve-LlamaServerBinary $buildResult.buildDir }
Write-RuntimeConfig $Config -backend $buildResult.backend -backendLabel $buildResult.label -binaryPath $llamaServerBinary -recommendedContext $plan.recommended_context -recommendedGpuLayers $plan.recommended_gpu_layers
if ($buildResult.source -eq 'release') {
    OK "llama.cpp préparé via binaire officiel avec backend $($buildResult.label)"
} else {
    OK "llama.cpp compilé avec backend $($buildResult.label)"
}

Step "4/6" "Contrôleur hôte et runtime"
Ensure-ControllerServiceInstalled $Config
Start-HostMetricsService $Config
Ensure-ControllerRunning $Config
Start-DefaultRuntime $Config

Step "5/6" "Conteneurs applicatifs"
Ensure-DockerNetwork $Config.docker.network
Start-ModelLoaderContainer

switch ($interfaceChoice) {
    "1" { Start-OpenWebUiContainer }
    "2" { Start-AnythingLLMContainer }
    "3" { Start-LibreChatContainer }
    "4" {
        Start-AnythingLLMContainer
        Start-OpenWebUiContainer
        Start-LibreChatContainer
    }
}

Step "6/6" "Ouverture navigateur"
$tabs = @("http://localhost:$($Config.ports.loader)")
if ($interfaceChoice -in @("2", "4")) {
    $tabs += "http://localhost:$($Config.ports.anything)"
}
if ($interfaceChoice -in @("1", "4")) {
    $tabs += "http://localhost:$($Config.ports.openWebUi)"
}
if ($interfaceChoice -in @("3", "4")) {
    $tabs += "http://localhost:$($Config.ports.libreChat)"
}

Open-Tabs $tabs

$sep = "=" * 64
Write-Host "`n  $sep" -ForegroundColor Cyan
Write-Host "  STACK LLAMA.CPP PRÊTE" -ForegroundColor Green
Write-Host "  $sep" -ForegroundColor Cyan
Write-Host "  Model Loader -> http://localhost:$($Config.ports.loader)" -ForegroundColor White
if ($interfaceChoice -in @("2", "4")) {
    Write-Host "  AnythingLLM  -> http://localhost:$($Config.ports.anything)" -ForegroundColor White
}
if ($interfaceChoice -in @("1", "4")) {
    Write-Host "  Open WebUI   -> http://localhost:$($Config.ports.openWebUi)" -ForegroundColor White
}
if ($interfaceChoice -in @("3", "4")) {
    Write-Host "  LibreChat    -> http://localhost:$($Config.ports.libreChat)" -ForegroundColor White
}
