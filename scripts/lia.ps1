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
        '-e', "METRICS_HOST_URL=http://host.docker.internal:$($Config.ports.gpuMetrics)",
        '-e', 'MODEL_STORAGE_DIR=/models',
        '-e', 'RUNTIME_STATE_PATH=/runtime/host-runtime-state.json',
        '-e', 'PROXY_MODEL_ID=lia-local',
        '--mount', $modelMountArg,
        '--mount', $runtimeMountArg,
        '--health-cmd', 'curl -fsS http://127.0.0.1:3005/health > /dev/null || exit 1',
        '--health-interval', '15s',
        '--health-timeout', '10s',
        '--health-retries', '2'
    )

    Start-DockerContainer `
        -ContainerName 'model-loader' `
        -ImageName $Config.docker.images.modelLoader `
        -LiaImageName $Config.docker.liaImages.modelLoader `
        -InternalPort 3005 `
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
        '-e', 'STORAGE_DIR=/app/server/storage',
        '-e', 'LLM_PROVIDER=generic-openai',
        '-e', "GENERIC_OPEN_AI_BASE_PATH=http://host.docker.internal:$($Config.ports.loader)/v1",
        '-e', 'GENERIC_OPEN_AI_MODEL_PREF=lia-local',
        '-e', 'GENERIC_OPEN_AI_API_KEY=not-used',
        '-e', 'GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT=8192',
        '-e', 'EMBEDDING_ENGINE=native',
        '-e', 'NO_PROXY=model-loader,localhost,127.0.0.1,host.docker.internal',
        '-e', 'no_proxy=model-loader,localhost,127.0.0.1,host.docker.internal',
        '-v', 'anythingllm-storage:/app/server/storage'
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
        -HealthCheckUrl "http://127.0.0.1:$($Config.ports.anything)" `
        -UseBaseImage
}

function Start-OpenWebUiContainer {
    $additionalArgs = @(
        '-e', 'WEBUI_AUTH=False',
        '-e', 'WEBUI_SECRET_KEY=lia-local-secret',
        '-e', 'ENABLE_OLLAMA_API=false',
        '-e', 'ENABLE_OPENAI_API=true',
        '-e', "OPENAI_API_BASE_URL=http://host.docker.internal:$($Config.ports.loader)/v1",
        '-e', "OPENAI_API_BASE_URLS=http://host.docker.internal:$($Config.ports.loader)/v1",
        '-e', 'OPENAI_API_KEYS=not-used',
        '-e', 'OPENAI_API_KEY=not-used',
        '-v', 'open-webui-data:/app/backend/data',
        '--health-cmd', 'curl -fsS http://127.0.0.1:8080/ > /dev/null || exit 1',
        '--health-interval', '30s',
        '--health-timeout', '5s',
        '--health-start-period', '60s',
        '--health-retries', '3'
    )

    Start-DockerContainer `
        -ContainerName 'openwebui' `
        -ImageName $Config.docker.images.openWebUi `
        -LiaImageName $Config.docker.liaImages.openWebUi `
        -InternalPort 8080 `
        -ExternalPort $Config.ports.openWebUi `
        -NetworkName $Config.docker.network `
        -Config $Config `
        -AdditionalArgs $additionalArgs `
        -HealthCheckUrl "http://127.0.0.1:$($Config.ports.openWebUi)" `
        -UseBaseImage
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
        '-e', 'CONFIG_PATH=/app/librechat.yaml',
        '-e', 'MONGO_URI=mongodb://librechat-mongo:27017/LibreChat',
        '-e', 'JWT_SECRET=7b9d6f2a3c8e5b1d4f7a9c3e8b2d5f1a7c9e3b6d2f8a5c1e4b7d9f3a8c2e5b1d',
        '-e', 'JWT_REFRESH_SECRET=5a8c2e6b9d3f5a7c1e4b8d2f6a9c3e7b5d1a4f8c2e6b9d3f5a7c1e4b8d2f6a9c',
        '-e', 'ALLOW_EMAIL_LOGIN=true',
        '-e', 'ALLOW_REGISTRATION=true',
        '-e', 'ALLOW_SOCIAL_LOGIN=false',
        '-e', 'OPENAI_API_KEY=not-used',
        '-e', "OPENAI_BASE_URL=http://host.docker.internal:$($Config.ports.loader)/v1",
        '-e', "OPENAI_API_BASE_URL=http://host.docker.internal:$($Config.ports.loader)/v1",
        '-e', "OPENAI_API_BASE_URLS=http://host.docker.internal:$($Config.ports.loader)/v1",
        '-e', "OPENAI_REVERSE_PROXY=http://host.docker.internal:$($Config.ports.loader)/v1",
        '-e', 'OPENAI_MODELS_FETCH=true',
        '-e', 'OPENAI_MODELS=lia-local',
        '-e', 'AUTO_FETCH_MODELS=true',
        '-e', 'CUSTOM_MODELS=[{"user":"system","name":"lia-local","displayName":"LIA Local LLM","modelName":"lia-local","icon":"llama"}]',
        '-e', 'ENABLE_OPENAI=true',
        '-e', 'OPENAI_PROXY_ENABLED=true',
        '-e', 'DEBUG_OPENAI=true',
        '-e', 'DISABLE_TELEMETRY=true',
        '-v', 'librechat-data:/app/api/data'
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

# Logique principale
Step "1/6" "Vérification de Docker"
$dockerInfoOk = $false
for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
        $null = docker info 2>&1
        if ($LASTEXITCODE -eq 0) {
            $dockerInfoOk = $true
            break
        }
    } catch {
        # daemon non prêt
    }
    if ($attempt -lt 3) {
        Write-Host "  Docker daemon non prêt, nouvel essai dans 5s... ($attempt/3)" -ForegroundColor DarkGray
        Start-Sleep -Seconds 5
    }
}
if (-not $dockerInfoOk) {
    throw "Docker n'est pas accessible. Veuillez vous assurer que Docker Desktop est démarré et fonctionnel."
}
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

# ── Vérification finale : tests de fumée ─────────────────────────────────────
# P-BASSE : un installateur idempotent doit aussi VÉRIFIER que la stack est
# réellement fonctionnelle (controller joignable, proxy OpenAI, inférence).
# Une erreur de syntaxe du controller (ParserError) serait ainsi détectée
# immédiatement au lieu de se manifester par un « fetch failed » dans l'UI.
$smokeScript = Join-Path (Split-Path -Parent $PSScriptRoot) 'tests\smoke.ps1'
if (Test-Path $smokeScript) {
    Step "7/7" "Vérification de la stack (tests de fumée)"
    Write-Host "  Attente de la disponibilité des services (20 s)..." -ForegroundColor DarkGray
    Start-Sleep -Seconds 20
    & $smokeScript
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Certains tests de fumée ont échoué. Détail : pwsh -File `"$smokeScript`""
    } else {
        OK "Tous les tests de fumée passent"
    }
} else {
    Write-Host "  [SKIP] tests\smoke.ps1 introuvable" -ForegroundColor DarkGray
}

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
