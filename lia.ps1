$ErrorActionPreference = "Stop"
$ScriptName = "lia.ps1"
$ScriptDir = Split-Path -Parent $PSCommandPath
$ScriptPath = Join-Path $ScriptDir $ScriptName

$rootDir           = Split-Path -Parent $PSCommandPath
$runtimeDir        = Join-Path $rootDir "runtime"
$modelsDir         = Join-Path $rootDir "models"
$llamaRepoDir      = Join-Path $runtimeDir "llama.cpp"
$controllerScript  = Join-Path $rootDir "llama-host-controller.ps1"
$runtimeConfigPath = Join-Path $runtimeDir "host-runtime-config.json"
$runtimeStatePath  = Join-Path $runtimeDir "host-runtime-state.json"
$controllerPort    = 13579
$llamaPort         = 12434
$loaderPort        = 3002
$anythingPort      = 3001
$openWebUiPort     = 3003
$dockerNetwork     = "lia-network"
$modelLoaderImage  = "lia-model-loader:latest"
$anythingllmImage  = "mintplexlabs/anythingllm:latest"
$openWebUiImage    = "ghcr.io/open-webui/open-webui:main"

function Confirm-Command([string]$cmd) {
    [bool](Get-Command $cmd -ErrorAction SilentlyContinue)
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

function Get-LlamaReleaseCandidates($plan) {
    if ($plan.releaseCandidates) {
        return $plan.releaseCandidates
    }

    switch ($plan.backend) {
        'cuda' {
            return @(
                @{ backend = 'cuda'; label = 'NVIDIA CUDA'; assetPattern = 'llama-.*-bin-win-cuda-13\.1-x64\.zip$' },
                @{ backend = 'cuda'; label = 'NVIDIA CUDA'; assetPattern = 'llama-.*-bin-win-cuda-12\.4-x64\.zip$' },
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
        'vulkan' {
            return @(
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
        default {
            return @(
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
    }
}

function Normalize-RuntimeConfig {
    if (-not (Test-Path $runtimeConfigPath)) {
        return
    }

    $config = Get-Content $runtimeConfigPath -Raw | ConvertFrom-Json
    $updated = $false

    if ($config.server_port -ne $llamaPort) {
        $config.server_port = $llamaPort
        $updated = $true
    }

    if ([string]$config.backend -eq 'sycl') {
        $config.backend = 'vulkan'
        $config.backend_label = 'Vulkan'
        $updated = $true
    }

    if ([string]$config.binary_path -match 'llama-releases\\[^\\]+-sycl\\') {
        $config.binary_path = $config.binary_path -replace 'llama-releases\\([^\\]+)-sycl\\', 'llama-releases\\$1-vulkan\\'
        $updated = $true
    }

    if ($updated) {
        $config | ConvertTo-Json -Depth 6 | Set-Content -Path $runtimeConfigPath -Encoding UTF8
        OK "Configuration runtime existante normalisee sur Vulkan"
    }
}

function Get-LlamaServerBinaryFromDirectory([string]$directoryPath) {
    if (-not (Test-Path $directoryPath)) {
        return $null
    }

    $binary = Get-ChildItem -Path $directoryPath -Filter 'llama-server.exe' -File -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1

    if ($binary) {
        return $binary.FullName
    }

    return $null
}

function Try-DownloadLlamaCppRelease($plan) {
    $candidates = @(Get-LlamaReleaseCandidates $plan)

    try {
        $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/ggml-org/llama.cpp/releases/latest' -Headers @{ 'User-Agent' = 'LIA-setup' }
    } catch {
        WARN "Impossible de recuperer la derniere release llama.cpp."
        return $null
    }

    $releaseRoot = Join-Path $runtimeDir 'llama-releases'
    Ensure-Directory $releaseRoot

    foreach ($candidate in $candidates) {
        $asset = $release.assets | Where-Object { $_.name -match $candidate.assetPattern } | Select-Object -First 1
        if (-not $asset) {
            continue
        }

        $releaseDir = Join-Path $releaseRoot ("{0}-{1}" -f $release.tag_name, $candidate.backend)
        $archivePath = Join-Path $releaseRoot $asset.name
        $existingBinary = Get-LlamaServerBinaryFromDirectory $releaseDir

        if ($existingBinary) {
            INFO "Utilisation du binaire llama.cpp deja present : $($asset.name)"
            return @{ backend = $candidate.backend; label = $candidate.label; binaryPath = $existingBinary; source = 'release'; buildDir = $releaseDir }
        }

        INFO "Telechargement du binaire officiel llama.cpp : $($asset.name)"
        Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archivePath -Headers @{ 'User-Agent' = 'LIA-setup' }

        if (Test-Path $releaseDir) {
            Remove-Item $releaseDir -Recurse -Force -ErrorAction Stop
        }

        Expand-Archive -Path $archivePath -DestinationPath $releaseDir -Force

        $binaryPath = Get-LlamaServerBinaryFromDirectory $releaseDir
        if ($binaryPath) {
            return @{ backend = $candidate.backend; label = $candidate.label; binaryPath = $binaryPath; source = 'release'; buildDir = $releaseDir }
        }

        WARN "Le binaire telecharge ne contient pas llama-server.exe : $($asset.name)"
    }

    WARN "Aucun binaire précompilé compatible n'a pu être préparé."
    return $null
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
    Write-Host "  3) Les deux" -ForegroundColor Gray

    do {
        $choice = (Read-Host "Choix [1/2/3]").Trim()
    } while ($choice -notin @('1', '2', '3'))

    return $choice
}

function Get-HardwareProfile {
    $controllers = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    $names = @($controllers | ForEach-Object { $_.Name })
    $joined = ($names -join ' | ')

    if ($joined -match 'NVIDIA') {
        return @{ vendor = 'nvidia'; label = $joined }
    }
    if ($joined -match 'Radeon|AMD') {
        return @{ vendor = 'amd'; label = $joined }
    }
    if ($joined -match 'Intel') {
        return @{ vendor = 'intel'; label = $joined }
    }

    return @{ vendor = 'cpu'; label = if ($joined) { $joined } else { 'Aucun GPU détecté' } }
}

function Get-BackendPlan($hardware) {
    $vendor = [string]$hardware.vendor

    if ($vendor -eq 'nvidia') {
        return @{
            backend = 'cuda'
            label = 'NVIDIA CUDA'
            releaseCandidates = @(
                @{ backend = 'cuda'; label = 'NVIDIA CUDA'; assetPattern = 'llama-.*-bin-win-cuda-13\.1-x64\.zip$' },
                @{ backend = 'cuda'; label = 'NVIDIA CUDA'; assetPattern = 'llama-.*-bin-win-cuda-12\.4-x64\.zip$' },
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
    }

    if ($vendor -eq 'amd') {
        return @{
            backend = 'vulkan'
            label = 'Vulkan'
            releaseCandidates = @(
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
    }

    if ($vendor -eq 'intel') {
        return @{
            backend = 'vulkan'
            label = 'Vulkan'
            releaseCandidates = @(
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
    }

    return @{
        backend = 'cpu'
        label = 'CPU'
        releaseCandidates = @(
            @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
        )
    }
}

function Build-LlamaCpp($plan) {
    Ensure-Directory $runtimeDir

    $releaseResult = Try-DownloadLlamaCppRelease $plan
    if ($releaseResult) {
        return $releaseResult
    }

    FAIL "Aucun binaire llama.cpp précompilé compatible trouvé pour le backend $($plan.label). Compilation native désactivée."
}

function Resolve-LlamaServerBinary([string]$buildDir) {
    $directBinary = Get-LlamaServerBinaryFromDirectory $buildDir
    if ($directBinary) {
        return $directBinary
    }

    $candidates = @(
        (Join-Path $buildDir 'bin\llama-server.exe'),
        (Join-Path $buildDir 'bin\Release\llama-server.exe')
    )

    $binary = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $binary) {
        FAIL "llama-server.exe introuvable après compilation."
    }

    return $binary
}

function Stop-LlamaServerProcess {
    $procs = Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue
    if ($procs) {
        $procs | Stop-Process -Force -ErrorAction SilentlyContinue
        # Attendre libération du port
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep -Milliseconds 500
            $still = Get-NetTCPConnection -LocalPort $llamaPort -ErrorAction SilentlyContinue
            if (-not $still) { break }
        }
    }
}

function Stop-ExistingController {
    $connections = Get-NetTCPConnection -LocalPort $controllerPort -State Listen -ErrorAction SilentlyContinue
    foreach ($conn in @($connections)) {
        Stop-Process -Id $conn.OwningProcess -Force -ErrorAction SilentlyContinue
    }
    for ($i = 0; $i -lt 20; $i++) {
        Start-Sleep -Milliseconds 500
        $still = Get-NetTCPConnection -LocalPort $controllerPort -ErrorAction SilentlyContinue
        if (-not $still) { break }
    }
}

function Ensure-ControllerRunning {
    $controllerOk = $false
    if (Wait-HttpOk -url "http://127.0.0.1:$controllerPort/health" -maxTries 1 -delay 1) {
        try {
            $currentStatus = Invoke-RestMethod -Uri "http://127.0.0.1:$controllerPort/status" -Method Get -TimeoutSec 5 -ErrorAction Stop
            if ([string]$currentStatus.models_dir -ieq $modelsDir) {
                $controllerOk = $true
            } else {
                INFO "Contrôleur existant avec chemin différent ($($currentStatus.models_dir)), redémarrage..."
                Stop-LlamaServerProcess
                Stop-ExistingController
            }
        } catch {
            Stop-LlamaServerProcess
            Stop-ExistingController
        }
    } else {
        Stop-LlamaServerProcess
    }

    if (-not $controllerOk) {
        INFO "Démarrage du contrôleur hôte"
        Start-Process powershell.exe -ArgumentList @(
            '-ExecutionPolicy', 'Bypass',
            '-File', $controllerScript,
            '-Port', $controllerPort,
            '-ConfigPath', $runtimeConfigPath,
            '-StatePath', $runtimeStatePath
        ) -WindowStyle Hidden | Out-Null
    }

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$controllerPort/health" -maxTries 40 -delay 2)) {
        FAIL "Le contrôleur hôte ne répond pas."
    }

    OK "Contrôleur hôte prêt"
}

function Write-RuntimeConfig([string]$backend, [string]$backendLabel, [string]$binaryPath) {
    $config = @{
        controller_port = $controllerPort
        server_port = $llamaPort
        backend = $backend
        backend_label = $backendLabel
        binary_path = $binaryPath
        models_dir = $modelsDir
        proxy_model_id = 'lia-local'
        default_context = 8192
        default_gpu_layers = if ($backend -eq 'cpu') { 0 } else { 999 }
    }

    $config | ConvertTo-Json -Depth 5 | Set-Content -Path $runtimeConfigPath -Encoding UTF8
}

function Get-DefaultModel {
    $firstModel = Get-ChildItem -Path $modelsDir -Filter *.gguf -File -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
    if (-not $firstModel) {
        return $null
    }

    return $firstModel.Name
}

function Start-DefaultRuntime {
    $defaultModel = Get-DefaultModel
    if (-not $defaultModel) {
        WARN "Aucun modèle GGUF détecté. Le runtime restera inactif jusqu’au premier import."
        return
    }

    INFO "Chargement initial : $defaultModel"
    $payload = @{ model = $defaultModel } | ConvertTo-Json
    Invoke-RestMethod -Uri "http://127.0.0.1:$controllerPort/start" -Method Post -Body $payload -ContentType 'application/json' | Out-Null

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$llamaPort/v1/models" -maxTries 30 -delay 2)) {
        WARN "llama-server ne répond pas encore. Le Model Loader permettra de relancer un modèle."
    } else {
        OK "llama-server répond sur http://127.0.0.1:$llamaPort/v1"
    }
}

function Ensure-DockerNetwork([string]$name) {
    docker network inspect $name *> $null
    if ($LASTEXITCODE -ne 0) {
        docker network create $name | Out-Null
        if ($LASTEXITCODE -ne 0) {
            FAIL "Création du réseau Docker impossible : $name"
        }
    }

    OK "Réseau Docker $name prêt"
}

function Remove-Container([string]$name) {
    docker stop $name 2>$null | Out-Null
    docker rm $name 2>$null | Out-Null
}

function Sync-AnythingLLMConfiguration {
    $python = @'
import sqlite3

conn = sqlite3.connect('/app/server/storage/anythingllm.db')
cur = conn.cursor()

cur.execute(
    """
    UPDATE workspaces
    SET
        chatProvider = ?,
        chatModel = ?,
        agentProvider = ?,
        agentModel = ?
    """,
    ('generic-openai', 'lia-local', 'generic-openai', 'lia-local')
)

conn.commit()
print(cur.rowcount)
'@

    docker exec anythingllm python3 -c $python | Out-Null
    if ($LASTEXITCODE -ne 0) {
        WARN "Synchronisation AnythingLLM non appliquee."
        return
    }

    OK "AnythingLLM synchronise sur le proxy OpenAI local"
}

function Sync-OpenWebUiConfiguration {
    $python = @'
import json
import sqlite3

conn = sqlite3.connect('/app/backend/data/webui.db')
cur = conn.cursor()
row = cur.execute('SELECT id, data FROM config LIMIT 1').fetchone()

if row:
    config_id, raw = row
    data = json.loads(raw)
    openai = data.setdefault('openai', {})
    openai['enable'] = True
    openai['api_base_urls'] = ['http://model-loader:3002/v1']
    openai['api_keys'] = ['not-used']
    api_configs = openai.setdefault('api_configs', {})
    slot = api_configs.setdefault('0', {})
    slot['enable'] = True
    slot['connection_type'] = 'external'
    slot['auth_type'] = 'bearer'
    ollama = data.setdefault('ollama', {})
    ollama['enable'] = False
    ollama['base_urls'] = []
    ollama['api_configs'] = {'0': {'enable': False}}
    data['direct'] = {'enable': False}
    cur.execute('UPDATE config SET data = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', (json.dumps(data), 0, config_id))
    conn.commit()
    print(config_id)
else:
    print('0')
'@

    docker exec open-webui python -c $python | Out-Null
    if ($LASTEXITCODE -ne 0) {
        WARN "Synchronisation Open WebUI non appliquee."
        return
    }

    OK "Open WebUI synchronise sur le proxy OpenAI local"
}

function Start-ModelLoaderContainer {
    Remove-Container 'model-loader'

    docker build -t $modelLoaderImage -f "$rootDir\Dockerfile.model-loader" $rootDir
    if ($LASTEXITCODE -ne 0) {
        FAIL "Build du conteneur Model Loader impossible."
    }

    $args = @(
        'run', '-d',
        '--name', 'model-loader',
        '--network', $dockerNetwork,
        '-p', ("{0}:3002" -f $loaderPort),
        '--add-host', 'host.docker.internal:host-gateway',
        '-e', ("LLAMA_HOST_CONTROL_URL=http://host.docker.internal:{0}" -f $controllerPort),
        '-e', ("LLAMA_SERVER_BASE_URL=http://host.docker.internal:{0}" -f $llamaPort),
        '-e', 'MODEL_STORAGE_DIR=/models',
        '-e', 'PROXY_MODEL_ID=lia-local',
        '-v', ("{0}:/models" -f $modelsDir),
        $modelLoaderImage
    )

    docker @args | Out-Null
    if ($LASTEXITCODE -ne 0) {
        FAIL "Démarrage du conteneur Model Loader impossible."
    }

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$loaderPort/health" -maxTries 30 -delay 2)) {
        FAIL "Le Model Loader ne répond pas."
    }

    OK "Model Loader prêt sur http://localhost:$loaderPort"
}

function Start-AnythingLLMContainer {
    Remove-Container 'anythingllm'

    $args = @(
        'run', '-d',
        '--name', 'anythingllm',
        '--network', $dockerNetwork,
        '-p', ("{0}:3001" -f $anythingPort),
        '--add-host', 'host.docker.internal:host-gateway',
        '-v', 'anythingllm-storage:/app/server/storage',
        '-e', 'STORAGE_DIR=/app/server/storage',
        '-e', 'LLM_PROVIDER=generic-openai',
        '-e', 'GENERIC_OPEN_AI_BASE_PATH=http://model-loader:3002/v1',
        '-e', 'GENERIC_OPEN_AI_MODEL_PREF=lia-local',
        '-e', 'GENERIC_OPEN_AI_API_KEY=not-used',
        '-e', 'GENERIC_OPEN_AI_MODEL_TOKEN_LIMIT=8192',
        '-e', 'EMBEDDING_ENGINE=native',
        '-e', 'NO_PROXY=model-loader,localhost,127.0.0.1,host.docker.internal',
        '-e', 'no_proxy=model-loader,localhost,127.0.0.1,host.docker.internal',
        $anythingllmImage
    )

    docker @args | Out-Null
    if ($LASTEXITCODE -ne 0) {
        FAIL "Démarrage AnythingLLM impossible."
    }

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$anythingPort" -maxTries 40 -delay 3)) {
        WARN "AnythingLLM met plus de temps à répondre."
    } else {
        OK "AnythingLLM prêt sur http://localhost:$anythingPort"
    }

    Sync-AnythingLLMConfiguration
}

function Start-OpenWebUiContainer {
    Remove-Container 'open-webui'

    $args = @(
        'run', '-d',
        '--name', 'open-webui',
        '--network', $dockerNetwork,
        '-p', ("{0}:8080" -f $openWebUiPort),
        '--add-host', 'host.docker.internal:host-gateway',
        '-v', 'open-webui-data:/app/backend/data',
        '-e', 'WEBUI_AUTH=False',
        '-e', 'WEBUI_SECRET_KEY=lia-local-secret',
        '-e', 'ENABLE_OLLAMA_API=false',
        '-e', 'ENABLE_OPENAI_API=true',
        '-e', 'OPENAI_API_BASE_URL=http://model-loader:3002/v1',
        '-e', 'OPENAI_API_BASE_URLS=http://model-loader:3002/v1',
        '-e', 'OPENAI_API_KEYS=not-used',
        '-e', 'OPENAI_API_KEY=not-used',
        $openWebUiImage
    )

    docker @args | Out-Null
    if ($LASTEXITCODE -ne 0) {
        FAIL "Démarrage Open WebUI impossible."
    }

    if (-not (Wait-HttpOk -url "http://127.0.0.1:$openWebUiPort" -maxTries 40 -delay 3)) {
        WARN "Open WebUI met plus de temps à répondre."
    } else {
        OK "Open WebUI prêt sur http://localhost:$openWebUiPort"
    }

    Sync-OpenWebUiConfiguration
}

Ensure-Directory $runtimeDir
Ensure-Directory $modelsDir
Normalize-RuntimeConfig

Step "1/6" "Choix interface"
$interfaceChoice = Get-InterfaceChoice
OK "Selection utilisateur enregistree"

Step "2/6" "Preparation outils Windows"
if (-not (Confirm-Command "winget")) {
    FAIL "winget est requis sur cette machine Windows."
}

if (-not (Confirm-Command "docker")) {
    INFO "Installation Docker Desktop"
    winget install --id Docker.DockerDesktop -e --silent --accept-source-agreements --accept-package-agreements
    if ($LASTEXITCODE -ne 0) {
        FAIL "Installation Docker Desktop impossible."
    }
    FAIL "Docker Desktop a ete installe. Relance le script apres demarrage de Docker."
}

try {
    docker info 2>&1 | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw
    }
} catch {
    FAIL "Docker Desktop n'est pas demarre."
}

OK "Docker operationnel"

Step "3/6" "Detection materiel et preparation llama.cpp"
$hardware = Get-HardwareProfile
INFO "Materiel detecte : $($hardware.label)"
$plan = Get-BackendPlan $hardware
INFO "Backend cible : $($plan.label)"

$buildResult = Build-LlamaCpp $plan
$llamaServerBinary = if ($buildResult.binaryPath) { $buildResult.binaryPath } else { Resolve-LlamaServerBinary $buildResult.buildDir }
Write-RuntimeConfig -backend $buildResult.backend -backendLabel $buildResult.label -binaryPath $llamaServerBinary
if ($buildResult.source -eq 'release') {
    OK "llama.cpp prepare via binaire officiel avec backend $($buildResult.label)"
} else {
    OK "llama.cpp compile avec backend $($buildResult.label)"
}

Step "4/6" "Controleur hote et runtime"
Ensure-ControllerRunning
Start-DefaultRuntime

Step "5/6" "Conteneurs applicatifs"
Ensure-DockerNetwork $dockerNetwork
Start-ModelLoaderContainer

switch ($interfaceChoice) {
    "1" { Start-OpenWebUiContainer }
    "2" { Start-AnythingLLMContainer }
    "3" {
        Start-AnythingLLMContainer
        Start-OpenWebUiContainer
    }
}

Step "6/6" "Ouverture navigateur"
$tabs = @("http://localhost:$loaderPort")
if ($interfaceChoice -in @("2", "3")) {
    $tabs += "http://localhost:$anythingPort"
}
if ($interfaceChoice -in @("1", "3")) {
    $tabs += "http://localhost:$openWebUiPort"
}

Open-Tabs $tabs

$sep = "=" * 64
Write-Host "`n  $sep" -ForegroundColor Cyan
Write-Host "  STACK LLAMA.CPP PRETE" -ForegroundColor Green
Write-Host "  $sep" -ForegroundColor Cyan
Write-Host "  Model Loader -> http://localhost:$loaderPort" -ForegroundColor White
if ($interfaceChoice -in @("2", "3")) {
    Write-Host "  AnythingLLM  -> http://localhost:$anythingPort" -ForegroundColor White
}
if ($interfaceChoice -in @("1", "3")) {
    Write-Host "  Open WebUI   -> http://localhost:$openWebUiPort" -ForegroundColor White
}
Write-Host "  Backend       -> $($buildResult.label)" -ForegroundColor DarkCyan
Write-Host "  Runtime hote  -> http://127.0.0.1:$llamaPort/v1" -ForegroundColor DarkCyan
Write-Host "  Proxy OpenAI  -> http://localhost:$loaderPort/v1" -ForegroundColor DarkCyan
Write-Host "  Modeles GGUF  -> $modelsDir" -ForegroundColor Gray
Write-Host "  $sep" -ForegroundColor Cyan
