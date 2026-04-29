# modules/services.ps1
# Fonctions de gestion des services Windows

function Start-HostMetricsService([hashtable]$Config) {
    $metricsScript = Join-Path $Config.rootDir $Config.paths.gpuMetricsServiceHelper
    if (-not (Test-Path $metricsScript)) {
        WARN "Service de metriques hôte introuvable : $metricsScript"
        return
    }

    pwsh -NoProfile -ExecutionPolicy Bypass -File $metricsScript
}

function Ensure-ControllerServiceInstalled([hashtable]$Config) {
    if (Test-IsAdministrator) {
        & $Config.paths.controllerServiceHelper -RootDir $Config.rootDir
        return
    }

    INFO "Installation du service LIA Controller: élévation UAC requise."
    $pwshExe = Get-PreferredPowerShellExecutable
    $escapedRoot = $Config.rootDir.Replace("'", "''")
    $escapedHelper = $Config.paths.controllerServiceHelper.Replace("'", "''")
    $elevatedCommand = "& '$escapedHelper' -RootDir '$escapedRoot'"

    try {
        $proc = Start-Process -FilePath $pwshExe -Verb RunAs -Wait -PassThru -ArgumentList @(
            '-NoProfile',
            '-ExecutionPolicy', 'Bypass',
            '-Command', $elevatedCommand
        )
        if ($proc.ExitCode -ne 0) {
            FAIL "Installation du service annulée ou échouée (exit code $($proc.ExitCode))."
        }
    } catch {
        FAIL "Impossible de lancer l'installation service avec élévation UAC: $($_.Exception.Message)"
    }
}

function Ensure-ControllerRunning([hashtable]$Config) {
    $controllerOk = $false
    if (Wait-HttpOk -url "http://127.0.0.1:$($Config.ports.controller)/health" -maxTries 1 -delay 1) {
        try {
            $currentStatus = Invoke-RestMethod -Uri "http://127.0.0.1:$($Config.ports.controller)/status" -Method Get -TimeoutSec 5 -ErrorAction Stop
            $modelsMatch = [string]$currentStatus.models_dir -ieq $Config.modelsDir
            $supportsMulti = $currentStatus.PSObject.Properties['instances'] -ne $null
            if ($modelsMatch -and $supportsMulti) {
                $controllerOk = $true
            } else {
                if (-not $modelsMatch) {
                    $reason = "chemin différent ($($currentStatus.models_dir))"
                } else {
                    $reason = "format legacy (redémarrage requis)"
                }
                INFO "Contrôleur existant incompatible ($reason), redémarrage..."
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
        if (Get-Command pwsh -ErrorAction SilentlyContinue) {
            $pwshExe = 'pwsh'
        } else {
            $pwshExe = 'powershell.exe'
        }
        Start-Process $pwshExe -ArgumentList @(
            '-ExecutionPolicy', 'Bypass',
            '-File', $Config.paths.controllerScript,
            '-Port', $Config.ports.controller,
            '-ConfigPath', $Config.paths.runtimeConfigPath,
            '-StatePath', $Config.paths.runtimeStatePath
        ) -WindowStyle Hidden | Out-Null
    }

    $maxTries = $Config.timeout.serviceStart
    $delay = $Config.timeout.serviceDelay
    if (-not (Wait-HttpOk -url "http://127.0.0.1:$($Config.ports.controller)/health" -maxTries $maxTries -delay $delay)) {
        FAIL "Le contrôleur hôte ne répond pas."
    }

    OK "Contrôleur hôte prêt"
}

function Get-ActiveRuntimeContextConfig([hashtable]$Config) {
    $runtimeStatePath = Join-Path $Config.rootDir $Config.paths.runtimeStatePath
    if (-not (Test-Path $runtimeStatePath)) { return $null }

    try {
        $state = Get-Content -Path $runtimeStatePath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }

    $instances = @($state.instances) | Where-Object { $_ -and $_.running -eq $true }
    if (-not $instances -or $instances.Count -eq 0) { return $null }

    $latest = $instances |
        Sort-Object {
            try { [datetime]::Parse([string]$_.started_at) } catch { [datetime]::MinValue }
        } -Descending |
        Select-Object -First 1

    if (-not $latest) { return $null }

    return @{
        context = if ($latest.context) { [int]$latest.context } else { $null }
        gpu_layers = if ($latest.gpu_layers) { [int]$latest.gpu_layers } else { $null }
    }
}

function Write-RuntimeConfig([hashtable]$Config, [string]$backend, [string]$backendLabel, [string]$binaryPath, [int]$recommendedContext = 8192, [int]$recommendedGpuLayers = 999) {
    $defaultContext = $recommendedContext
    $defaultGpuLayers = 0

    if ($backend -ne 'cpu') { $defaultGpuLayers = $recommendedGpuLayers }

    $stateConfig = Get-ActiveRuntimeContextConfig $Config
    if ($stateConfig) {
        if ($stateConfig.context -and $stateConfig.context -gt 0) {
            $defaultContext = $stateConfig.context
        }
        if ($backend -ne 'cpu' -and $stateConfig.gpu_layers -and $stateConfig.gpu_layers -gt 0) {
            $defaultGpuLayers = $stateConfig.gpu_layers
        }
    }

    $runtimeConfigPath = $Config.paths.runtimeConfigPath
    $config = @{
        controller_port = $Config.ports.controller
        server_port = $Config.ports.llama
        backend = $backend
        backend_label = $backendLabel
        binary_path = $binaryPath
        models_dir = $Config.modelsDir
        proxy_model_id = $Config.proxy.modelId
        default_context = $defaultContext
        default_gpu_layers = $defaultGpuLayers
        sleep_idle_seconds = 60
        server_port_start = 12434
        server_port_end = 12444
        max_instances = 6
    }

    $jsonContent = $config | ConvertTo-Json -Depth 5 -Compress
    [System.IO.File]::WriteAllText($runtimeConfigPath, $jsonContent, [System.Text.Encoding]::UTF8)
}

function Get-DefaultModelFromState([hashtable]$Config) {
    $runtimeStatePath = Join-Path $Config.rootDir $Config.paths.runtimeStatePath
    if (-not (Test-Path $runtimeStatePath)) {
        return $null
    }

    try {
        $state = Get-Content -Path $runtimeStatePath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }

    $instances = @($state.instances) | Where-Object {
        $_ -and $_.filename -and ($_.running -ne $false)
    }

    if (-not $instances -or $instances.Count -eq 0) {
        return $null
    }

    $latestInstance = $instances |
        Sort-Object {
            try {
                [datetime]::Parse([string]$_.started_at)
            } catch {
                [datetime]::MinValue
            }
        } -Descending |
        Select-Object -First 1

    if (-not $latestInstance) {
        return $null
    }

    return [string]$latestInstance.filename
}

function Get-DefaultModel([hashtable]$Config) {
    $stateModel = Get-DefaultModelFromState $Config
    if ($stateModel) {
        return $stateModel
    }

    $candidateModels = Get-ChildItem -Path $Config.modelsDir -Filter *.gguf -File -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -notmatch 'deepseek' } |
        Sort-Object Length, Name

    $smallestModel = $candidateModels | Select-Object -First 1
    if (-not $smallestModel) {
        return $null
    }

    return $smallestModel.Name
}

function Start-DefaultRuntime([hashtable]$Config) {
    $defaultModel = Get-DefaultModel $Config
    if (-not $defaultModel) {
        WARN "Aucun modèle GGUF détecté. Le runtime restera inactif jusqu'au premier import."
        return
    }

    INFO "Chargement initial : $defaultModel"
    $payload = @{ model = $defaultModel } | ConvertTo-Json
    Invoke-RestMethod -Uri "http://127.0.0.1:$($Config.ports.controller)/start" -Method Post -Body $payload -ContentType 'application/json' | Out-Null

    $maxTries = $Config.timeout.httpRetries
    $delay = $Config.timeout.httpDelay
    if (-not (Wait-HttpOk -url "http://127.0.0.1:$($Config.ports.llama)/v1/models" -maxTries $maxTries -delay $delay)) {
        WARN "llama-server ne répond pas encore. Le Model Loader permettra de relancer un modèle."
    } else {
        OK "llama-server répond sur http://127.0.0.1:$($Config.ports.llama)/v1"
    }
}