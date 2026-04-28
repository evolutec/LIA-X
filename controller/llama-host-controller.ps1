param(
    [int]$Port = 13579,
    [string]$ConfigPath = "",
    [string]$StatePath = ""
)

$ErrorActionPreference = "Stop"
$Global:RequestCounter = @{}
$Global:LastRequestTime = @{}
$Global:RepairInProgress = $false
$Global:StartupInProgress = $true

function Get-RepoRoot {
    if ($PSScriptRoot -match '\\(scripts|controller)$') {
        return Split-Path -Parent $PSScriptRoot
    }
    return $PSScriptRoot
}

function Get-LogsRoot {
    return Join-Path (Get-RepoRoot) 'logs'
}

function Get-ControllerLogDir {
    return Join-Path (Get-LogsRoot) 'controller'
}

function Get-RuntimeLogDir {
    return Join-Path (Get-LogsRoot) 'runtime'
}

function Initialize-LogsDirectories {
    $dirs = @((Get-LogsRoot), (Get-ControllerLogDir), (Get-RuntimeLogDir))
    foreach ($dir in $dirs) {
        if (-not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
    }
}

function Get-DebugLogPath {
    return Join-Path (Get-ControllerLogDir) 'controller-debug.log'
}

function Write-DebugLog([string]$message, [string]$level = 'info') {
    $path = Get-DebugLogPath
    if (-not (Test-Path (Split-Path -Parent $path))) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $path) -Force | Out-Null
    }
    $line = "[$(Get-Date -Format 'o')] [$($level.ToUpper())] $message"
    Add-Content -Path $path -Value $line
}

function Get-ProcessMonitorLogPath {
    $dir = Get-ControllerLogDir
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return Join-Path $dir 'process-monitor.log'
}

function Write-ProcessMonitorLog([string]$message, [string]$level = 'info') {
    $path = Get-ProcessMonitorLogPath
    $normalizedLevel = $level.ToLower()
    $line = "[$(Get-Date -Format 'o')] [$($normalizedLevel.ToUpper())] $message"
    Add-Content -Path $path -Value $line
}

function Get-LlamaServerProcessInfo([int]$llamaPid) {
    $process = Get-Process -Id $llamaPid -ErrorAction SilentlyContinue
    if (-not $process) {
        return $null
    }

    $commandLine = ''
    $creationDate = $null
    $executablePath = ''
    try {
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$llamaPid" -ErrorAction SilentlyContinue
        if ($cim) {
            $commandLine    = $cim.CommandLine
            $executablePath = $cim.ExecutablePath
            $creationDate   = [Management.ManagementDateTimeConverter]::ToDateTime($cim.CreationDate)
        }
    } catch {}

    return @{
        pid            = $llamaPid
        process        = $process
        has_exited     = $process.HasExited
        command_line   = $commandLine
        executable_path = $executablePath
        creation_date  = $creationDate
        handle_count   = $process.HandleCount
        working_set_mb = [math]::Round($process.WorkingSet64 / 1MB, 1)
    }
}

function Get-ProcessListeningPorts([int]$llamaPid) {
    try {
        $connections = Get-NetTCPConnection -OwningProcess $llamaPid -State Listen -ErrorAction SilentlyContinue
        if ($connections) {
            return $connections | Select-Object -ExpandProperty LocalPort -Unique
        }
    } catch {}
    return @()
}

function Get-ProcessIdListeningOnPort([int]$port) {
    try {
        $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($connection) {
            return [int]$connection.OwningProcess
        }
    } catch {}
    return $null
}

function Get-ProcessInfoByPort([int]$port) {
    $processId = Get-ProcessIdListeningOnPort $port
    if (-not $processId) {
        return $null
    }
    return Get-LlamaServerProcessInfo $processId
}

function Get-LastLinesFromFile([string]$path, [int]$lineCount = 50) {
    if (-not (Test-Path $path)) {
        return ''
    }
    try {
        return (Get-Content -Path $path -ErrorAction SilentlyContinue | Select-Object -Last $lineCount) -join "`n"
    } catch {
        return ''
    }
}

function Write-LlamaProcessAudit([hashtable]$instance, [string]$event, [string]$details, [string]$level = 'error') {
    $processId = $instance.pid
    $port      = $instance.port
    $model     = $instance.model
    $stderr    = Get-LastLinesFromFile $instance.stderr_log 20
    $message   = "[Audit] $event pid=$processId port=$port model=$model details=$details"
    Write-ProcessMonitorLog $message $level
    if ($stderr) {
        Write-ProcessMonitorLog "[Audit] last stderr for pid=$processId`n$stderr" $level
    }
}

function Monitor-LlamaInstances {
    $state = Get-State
    foreach ($instance in $state.instances) {
        if (-not $instance.running -or -not $instance.pid) { continue }

        $info = Get-LlamaServerProcessInfo ([int]$instance.pid)
        if (-not $info) {
            Write-LlamaProcessAudit $instance 'ProcessMissing' "PID $($instance.pid) absent"
            continue
        }

        if ($info.has_exited) {
            Write-LlamaProcessAudit $instance 'ProcessCrashed' "PID $($instance.pid) a quitté"
            continue
        }

        $ports = Get-ProcessListeningPorts ([int]$instance.pid)
        if (-not ($ports -contains [int]$instance.port)) {
            Write-LlamaProcessAudit $instance 'PortMismatch' "Processus vivant mais port attendu $($instance.port) non trouvé; ports=$(($ports -join ','))"
        }

        if ($instance.path -and $info.command_line -and $info.command_line -notlike "*$($instance.path)*") {
            Write-LlamaProcessAudit $instance 'CommandLineMismatch' "Processus vivant mais CommandLine ne contient pas le modèle attendu"
        }
    }
}

function Register-LlamaServerDeathWatcher {
    Write-ProcessMonitorLog 'WMI death watcher désactivé temporairement' 'info'
}

# Gestionnaire d'arrêt gracieux
Register-EngineEvent PowerShell.Exiting -Action {
    Write-Host "`n[Controller] Arrêt gracieux en cours..."
    Write-Host "[Controller] ✅ LES PROCESSUS llama.server.exe SONT CONSERVÉS et survivent au redémarrage"
    Write-Host "[Controller] ✅ Ils seront automatiquement réattachés au prochain démarrage"
    Write-Host "[Controller] Arrêt terminé."
} | Out-Null

if (-not $ConfigPath) {
    $ConfigPath = Join-Path (Get-RepoRoot) "runtime\host-runtime-config.json"
}

if (-not $StatePath) {
    $StatePath = Join-Path (Get-RepoRoot) "runtime\host-runtime-state.json"
}

Initialize-LogsDirectories
Register-LlamaServerDeathWatcher

function ConvertTo-Hashtable($value) {
    if ($null -eq $value) { return $null }

    if ($value -is [System.Collections.IDictionary]) {
        $table = @{}
        foreach ($key in $value.Keys) {
            $table[[string]$key] = ConvertTo-Hashtable $value[$key]
        }
        return $table
    }

    if ($value -is [System.Management.Automation.PSCustomObject]) {
        $table = @{}
        foreach ($property in $value.PSObject.Properties) {
            $table[$property.Name] = ConvertTo-Hashtable $property.Value
        }
        return $table
    }

    if ($value -is [System.Collections.IEnumerable] -and -not ($value -is [string])) {
        $items = @()
        foreach ($item in $value) {
            $items += ,(ConvertTo-Hashtable $item)
        }
        return $items
    }

    return $value
}

function Save-Config([hashtable]$config) {
    $config | ConvertTo-Json -Depth 6 | Set-Content -Path $ConfigPath -Encoding UTF8
}

function Get-BestAvailableBackend {
    $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($nvidiaSmi) {
        try {
            $result = & nvidia-smi -L 2>$null
            if ($result -and $result -match 'GPU') {
                return @{ backend = "cuda"; label = "CUDA NVIDIA" }
            }
        } catch {}
    }

    $rocmInfo = Get-Command rocm-smi -ErrorAction SilentlyContinue
    if ($rocmInfo) {
        try {
            $result = & rocm-smi --showid 2>$null
            if ($result -and $result -match 'GPU') {
                return @{ backend = "rocm"; label = "ROCm AMD" }
            }
        } catch {}
    }

    $vulkanInfo = Get-Command vulkaninfo -ErrorAction SilentlyContinue
    if ($vulkanInfo) {
        return @{ backend = "vulkan"; label = "Vulkan" }
    }

    return @{ backend = "cpu"; label = "CPU" }
}

function Get-Config {
    if (-not (Test-Path $ConfigPath)) {
        $autoBackend = Get-BestAvailableBackend
        $config = @{
            controller_port    = $Port
            server_port        = 12434
            server_port_start  = 12434
            server_port_end    = 12444
            max_instances      = 6
            backend            = $autoBackend.backend
            backend_label      = $autoBackend.label
            binary_path        = ""
            models_dir         = ""
            proxy_model_id     = "lia-local"
            default_context    = 8192
            default_gpu_layers = 999
            sleep_idle_seconds = 60
        }
        Save-Config $config
        return $config
    }

    $config  = ConvertTo-Hashtable (Get-Content $ConfigPath -Raw | ConvertFrom-Json)
    $changed = $false

    if (-not $config.server_port_start -or [int]$config.server_port_start -eq 0) {
        $config.server_port_start = 12434; $changed = $true
    }
    if (-not $config.server_port_end -or [int]$config.server_port_end -lt [int]$config.server_port_start) {
        $config.server_port_end = 12444; $changed = $true
    }
    if (-not $config.server_port -or [int]$config.server_port -eq 0) {
        $config.server_port = 12434; $changed = $true
    }
    if (-not $config.default_context -or [int]$config.default_context -eq 0) {
        $config.default_context = 1; $changed = $true
    }
    if (-not $config.default_gpu_layers -or [int]$config.default_gpu_layers -eq 0) {
        $config.default_gpu_layers = 999; $changed = $true
    }
    if ($null -eq $config.sleep_idle_seconds) {
        $config.sleep_idle_seconds = -1; $changed = $true
    }

    if ($changed) { Save-Config $config }
    return $config
}

function Get-State {
    if (-not (Test-Path $StatePath)) {
        return @{ instances = @() }
    }

    try {
        $stream = [System.IO.File]::Open($StatePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $reader  = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
            $content = $reader.ReadToEnd()
            $parsed  = $content | ConvertFrom-Json
            if ($parsed -is [System.Array]) {
                if ($parsed.Count -eq 0) { return @{ instances = @() } }
                $parsed = $parsed[0]
            }
            return ConvertTo-Hashtable $parsed
        } finally {
            $reader.Dispose()
            $stream.Dispose()
        }
    } catch {
        Write-Host ('[controller] Get-State failed reading {0}: {1}' -f $StatePath, $_.Exception.Message)
        throw
    }
}

function Save-State([hashtable]$state) {
    try {
        $serializableState = ConvertTo-Hashtable $state
        if ($serializableState.instances -is [System.Collections.IDictionary]) {
            $serializableState.instances = @($serializableState.instances)
        }

        $data   = $serializableState | ConvertTo-Json -Depth 6
        $stream = [System.IO.File]::Open($StatePath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
        try {
            $writer = New-Object System.IO.StreamWriter($stream, [System.Text.Encoding]::UTF8)
            $writer.Write($data)
            $writer.Flush()
        } finally {
            $writer.Dispose()
            $stream.Dispose()
        }
    } catch {
        Write-Host ('[controller] Save-State failed writing {0}: {1}' -f $StatePath, $_.Exception.Message)
        Write-DebugLog "Save-State failed writing path=$StatePath error=$($_.Exception.Message)"
        throw
    }
    Write-DebugLog "Save-State wrote file path=$StatePath instances=$($serializableState.instances.Count)"
}

function Convert-LegacyState([hashtable]$state) {
    if (-not $state.instances) {
        if ($state.pid) {
            return @{
                instances = @(
                    @{
                        id                   = [string](if ($state.server_port) { $state.server_port } else { 12434 })
                        port                 = [int](if ($state.server_port) { $state.server_port } else { 12434 })
                        pid                  = $state.pid
                        running              = [bool]$state.running
                        model                = [string]$state.active_model
                        filename             = [string]$state.active_filename
                        path                 = [string]$state.active_path
                        started_at           = [string]$state.started_at
                        last_error           = [string]$state.last_error
                        stdout_log           = [string]$state.stdout_log
                        stderr_log           = [string]$state.stderr_log
                        estimated_vram_bytes = $null
                        server_base_url      = "http://127.0.0.1:$((if ($state.server_port) { $state.server_port } else { 12434 }))/v1"
                    }
                )
            }
        }
        return @{ instances = @() }
    }
    return $state
}

# ─────────────────────────────────────────────────────────────────────────────
# Get-ConsistentState
# Rôle : synchroniser l'état en mémoire avec les processus vivants.
# Ne JAMAIS modifier running. Ne JAMAIS appeler Repair pendant startup.
# ─────────────────────────────────────────────────────────────────────────────
function Get-ConsistentState {
    $state   = Get-State
    $state   = Convert-LegacyState $state
    $changed = $false

    # ── 1. Détecter les processus vivants sur la plage de ports ──────────────
    $liveInstances = Get-LiveInstances (Get-Config)

    if ($liveInstances.Count -gt 0) {
        # Règle : 1 modèle = 1 instance max (tuer les doublons)
        $seenModels   = @{}
        $filteredLive = @()
        foreach ($live in $liveInstances) {
            $modelKey = if ($live.filename) { $live.filename.ToLowerInvariant() } else { "port_$($live.port)" }
            if (-not $seenModels.ContainsKey($modelKey)) {
                $seenModels[$modelKey] = $true
                $filteredLive += $live
            } else {
                try { Stop-Process -Id $live.pid -Force -ErrorAction SilentlyContinue } catch {}
            }
        }
        $liveInstances = $filteredLive

        # ── 2. Fusionner live → saved (mettre à jour pid/started_at uniquement) ─
        foreach ($live in $liveInstances) {
            $saved = $state.instances | Where-Object { [string]$_.id -eq [string]$live.id } | Select-Object -First 1
            if ($saved) {
                # Mettre à jour uniquement les champs dynamiques
                $saved.pid        = $live.pid
                $saved.started_at = $live.started_at
                $saved.running    = $true
                # Compléter model/filename/path si l'instance était en sleep
                if (-not $saved.model    -and $live.model)    { $saved.model    = $live.model }
                if (-not $saved.filename -and $live.filename) { $saved.filename = $live.filename }
                if (-not $saved.path     -and $live.path)     { $saved.path     = $live.path }
            } else {
                # Nouvelle instance non connue du state → l'ajouter
                $state.instances += $live
            }
        }

        # ── 3. Pour les instances saved sans processus vivant : effacer pid ───
        $liveIds = @{}
        foreach ($live in $liveInstances) { $liveIds[[string]$live.id] = $true }
        foreach ($saved in $state.instances) {
            if (-not $liveIds.ContainsKey([string]$saved.id) -and $saved.pid) {
                $saved.pid        = $null
                $saved.started_at = ""
                $changed          = $true
                # running reste inchangé → Repair pourra relancer si running=true
            }
        }

        # ── 4. Résolution de l'instance active ────────────────────────────────
        $activeInstance = $state.instances | Where-Object { $_.active } | Select-Object -First 1
        if (-not $activeInstance -and $state.active_model) {
            $activeInstance = $state.instances | Where-Object {
                $_.model -ieq $state.active_model -or $_.filename -ieq $state.active_filename
            } | Select-Object -First 1
        }
        if (-not $activeInstance) {
            $activeInstance = $state.instances | Where-Object { $_.running } | Select-Object -First 1
        }
        foreach ($instance in $state.instances) {
            Set-ObjectProperty $instance 'active' ([bool]($activeInstance -and $instance.id -eq $activeInstance.id)) | Out-Null
        }

        $changed = $true
    }

    # ── 5. Nettoyage : supprimer uniquement les instances avec running=false ──
    $newInstances = @()
    foreach ($instance in $state.instances) {
        if ($instance -isnot [hashtable] -and $instance -isnot [System.Collections.IDictionary]) {
            continue
        }
        # Ne supprimer que si running est explicitement false
        if ($instance.ContainsKey('running') -and $instance.running -eq $false) {
            Write-DebugLog "Removing instance id=$($instance.id) model=$($instance.model) because running=false"
            $changed = $true
            continue
        }
        $newInstances += $instance
    }
    $state.instances = $newInstances

    # ── 6. Garantir que instances est un tableau ───────────────────────────
    if ($state.instances -is [System.Collections.IDictionary]) {
        $state.instances = @($state.instances); $changed = $true
    } elseif ($state.instances -isnot [System.Array]) {
        $state.instances = @(); $changed = $true
    }

    if ($changed) { Save-State $state }

    # ── 7. Repair seulement hors startup et hors récursion ────────────────
    if (-not $Global:StartupInProgress -and -not $Global:RepairInProgress) {
        Repair-DeadInstances (Get-State)
    }

    return Get-State
}

# ─────────────────────────────────────────────────────────────────────────────
# Get-LiveInstances
# Détecte les llama-server.exe actifs sur la plage de ports.
# Ne filtre PAS sur HTTP — un serveur en sleep ne répond plus.
# ─────────────────────────────────────────────────────────────────────────────
function Get-LiveInstances([hashtable]$config) {
    $instances = @()
    $savedState = Get-State
    $start = [int]$config.server_port_start
    $end   = [int]$config.server_port_end

    $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -ge $start -and $_.LocalPort -le $end }

    foreach ($listener in $listeners) {
        $port      = [int]$listener.LocalPort
        $processId = [int]$listener.OwningProcess
        $process   = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process -or $process.HasExited) { continue }

        # Vérifier que c'est bien un llama-server
        $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$processId" -ErrorAction SilentlyContinue
        if (-not $cim -or $cim.CommandLine -notmatch 'llama-server') { continue }

        # Essayer HTTP pour récupérer le modelId (peut échouer si sleep)
        $modelId = $null
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/models" -Method Get -TimeoutSec 2 -ErrorAction Stop
            if ($response.data -and $response.data.Count -gt 0) {
                $modelId = [string]$response.data[0].id
            } elseif ($response.models -and $response.models.Count -gt 0) {
                $modelId = [string]$response.models[0].model
            }
        } catch {
            # Serveur en sleep ou warmup — on garde l'instance quand même
        }

        # Compléter les infos depuis le state sauvegardé si HTTP muet
        $savedInstance = $savedState.instances | Where-Object { [int]$_.port -eq $port } | Select-Object -First 1

        $model    = $null
        $filename = $null
        $path     = ""

        if ($modelId) {
            $filename = $modelId
            $model    = [IO.Path]::GetFileNameWithoutExtension($modelId)
        } elseif ($savedInstance) {
            $model    = $savedInstance.model
            $filename = $savedInstance.filename
            $path     = $savedInstance.path
        }

        $instances += @{
            id              = [string]$port
            port            = $port
            pid             = $processId
            running         = $true
            model           = $model
            filename        = $filename
            path            = $path
            started_at      = $process.StartTime.ToString('o')
            last_error      = ""
            server_base_url = "http://127.0.0.1:$port/v1"
            proxy_id        = "$($config.proxy_model_id)-$port"
        }
    }

    return $instances
}

# ─────────────────────────────────────────────────────────────────────────────
# Repair-DeadInstances
# Relance les instances actives (running=true) dont le processus est mort.
# Protégé contre la récursion et désactivé pendant le startup.
# ─────────────────────────────────────────────────────────────────────────────
function Repair-DeadInstances([hashtable]$state) {
    if ($Global:RepairInProgress -or $Global:StartupInProgress) { return }
    if (-not $state) { return }

    $Global:RepairInProgress = $true
    try {
        foreach ($instance in $state.instances) {
            if (-not $instance.running -or -not $instance.model) { continue }

            $process = $null
            if ($instance.pid) {
                $process = Get-Process -Id ([int]$instance.pid) -ErrorAction SilentlyContinue
            }

            if ($process -and -not $process.HasExited) { continue }

            if ($process -and $process.HasExited) {
                Write-LlamaProcessAudit $instance 'RepairDeadInstance' "Processus arrêté avec code $($process.ExitCode)"
            } else {
                Write-LlamaProcessAudit $instance 'RepairDeadInstance' "Processus absent pour PID $($instance.pid)"
            }

            Write-Host "[Controller] Processus mort détecté pour $($instance.model) (port $($instance.port)). Redémarrage..."
            try {
                $ctx       = if ($instance.context       -and [int]$instance.context       -gt 0) { [int]$instance.context       } else { [int](Get-Config).default_context }
                $ngl       = if ($null -ne $instance.gpu_layers -and [int]$instance.gpu_layers -ge 0) { [int]$instance.gpu_layers } else { [int](Get-Config).default_gpu_layers }
                $sleepSecs = if ($instance.ContainsKey('sleep_idle_seconds')) { [int]$instance.sleep_idle_seconds } else { [int](Get-Config).sleep_idle_seconds }

                $body = @{
                    model              = if ($instance.filename) { $instance.filename } else { $instance.model }
                    port               = [int]$instance.port
                    context            = $ctx
                    gpu_layers         = $ngl
                    sleep_idle_seconds = $sleepSecs
                    activate           = [bool]$instance.active
                }
                if ($instance.estimated_vram_bytes) {
                    $body.estimated_vram_bytes = [int64]$instance.estimated_vram_bytes
                }
                Start-LlamaProcess $body | Out-Null
            } catch {
                Write-Host "[Controller] Échec redémarrage $($instance.model) : $($_.Exception.Message)"
                $instance.last_error = $_.Exception.Message
                # running reste true → on réessaiera au prochain cycle watchdog
            }
        }
    } finally {
        $Global:RepairInProgress = $false
    }
}

function Resolve-ModelRecord([string]$identifier) {
    $config    = Get-Config
    $modelsDir = [string]$config.models_dir
    if (-not $modelsDir -or -not (Test-Path $modelsDir)) {
        throw "Répertoire des modèles introuvable : $modelsDir"
    }

    $files = Get-ChildItem -Path $modelsDir -Filter *.gguf -File -ErrorAction SilentlyContinue
    if (-not $files) {
        throw "Aucun modèle GGUF trouvé dans $modelsDir"
    }

    $needle    = [string]$identifier
    $exactFile = $files | Where-Object { $_.Name -ieq $needle } | Select-Object -First 1
    if ($exactFile) {
        return @{ file = $exactFile; model = [IO.Path]::GetFileNameWithoutExtension($exactFile.Name) }
    }

    $exactStem = $files | Where-Object { [IO.Path]::GetFileNameWithoutExtension($_.Name) -ieq $needle } | Select-Object -First 1
    if ($exactStem) {
        return @{ file = $exactStem; model = [IO.Path]::GetFileNameWithoutExtension($exactStem.Name) }
    }

    throw "Modèle introuvable : $identifier"
}

function Get-NextAvailablePort([hashtable]$config, [hashtable]$state) {
    $start    = [int]$config.server_port_start
    $end      = [int]$config.server_port_end
    $occupied = @{}
    foreach ($instance in $state.instances) {
        if ($instance.port) { $occupied[[int]$instance.port] = $true }
    }

    for ($p = $start; $p -le $end; $p++) {
        if (-not $occupied.ContainsKey($p)) { return $p }
    }
    return $null
}

function Resolve-InstanceRecord([string]$identifier) {
    $state = Get-ConsistentState
    if (-not $state.instances) { return $null }

    $needle = [string]$identifier
    if (-not $needle) { return $null }

    $lower = $needle.ToLower()
    foreach ($instance in $state.instances) {
        if ([string]$instance.model    -and [string]$instance.model.ToLower()    -eq $lower) { return $instance }
        if ([string]$instance.filename -and [string]$instance.filename.ToLower() -eq $lower) { return $instance }
        if ([string]$instance.id       -and [string]$instance.id.ToLower()       -eq $lower) { return $instance }
        if ([string]$instance.port     -and [string]$instance.port               -eq $needle) { return $instance }
        if ([string]$instance.proxy_id -and [string]$instance.proxy_id.ToLower() -eq $lower) { return $instance }
    }
    return $null
}

function Get-GpuState {
    $controllers = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    $total  = [int64]0
    $used   = [int64]0
    $labels = @()

    $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($nvidiaSmi) {
        try {
            $gpuData = & nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits 2>$null
            if ($gpuData) {
                foreach ($line in $gpuData) {
                    $parts   = $line.Split(',').Trim()
                    $labels += $parts[0]
                    $total  += [int64]$parts[1] * 1024 * 1024
                    $used   += [int64]$parts[2] * 1024 * 1024
                }
                return @{
                    total_bytes     = $total
                    used_bytes      = $used
                    available_bytes = $total - $used
                    label           = if ($labels) { ($labels -join ' | ') } else { 'NVIDIA GPU' }
                    vendor          = "nvidia"
                }
            }
        } catch {}
    }

    $rocmSmi = Get-Command rocm-smi -ErrorAction SilentlyContinue
    if ($rocmSmi) {
        try {
            $amdData = & rocm-smi --showproductname --showmeminfo vram --json 2>$null | ConvertFrom-Json
            if ($amdData) {
                foreach ($gpu in $amdData.PSObject.Properties) {
                    $labels += $gpu.Value.ProductName
                    $total  += [int64]$gpu.Value.VRAM.Total
                    $used   += [int64]$gpu.Value.VRAM.Used
                }
                return @{
                    total_bytes     = $total
                    used_bytes      = $used
                    available_bytes = $total - $used
                    label           = if ($labels) { ($labels -join ' | ') } else { 'AMD GPU' }
                    vendor          = "amd"
                }
            }
        } catch {}
    }

    foreach ($controller in $controllers) {
        $reported = if ($controller.AdapterRAM) { [int64]$controller.AdapterRAM } else { [int64]0 }
        $nameVram = [int64]0
        if ($controller.Name -match '\((\d+)\s*GB\)') {
            $nameVram = [int64]$Matches[1] * [int64]1073741824
        }
        if ($nameVram -gt 0 -and $reported -lt [int64]6442450944) {
            $total += $nameVram
        } else {
            $total += $reported
        }
        if ($controller.Name) { $labels += [string]$controller.Name }
    }

    return @{
        total_bytes     = $total
        used_bytes      = $null
        available_bytes = $null
        label           = if ($labels) { ($labels -join ' | ') } else { 'GPU inconnu' }
        vendor          = "generic"
    }
}

function Stop-LlamaProcess([hashtable]$body) {
    $state  = Get-ConsistentState
    $target = $null

    if ($body -and $body.model)    { $target = Resolve-InstanceRecord([string]$body.model) }
    elseif ($body -and $body.id)   { $target = Resolve-InstanceRecord([string]$body.id) }
    elseif ($body -and $body.proxy_id) { $target = Resolve-InstanceRecord([string]$body.proxy_id) }
    elseif ($body -and $body.port) { $target = Resolve-InstanceRecord([string]$body.port) }
    elseif ($state.instances.Count -eq 1) { $target = $state.instances[0] }

    if (-not $target) { return $state }

    if ($target.pid) {
        try {
            Stop-Process -Id ([int]$target.pid) -ErrorAction Stop
            Start-Sleep -Milliseconds 2000
            $process = Get-Process -Id ([int]$target.pid) -ErrorAction SilentlyContinue
            if ($process -and -not $process.HasExited) {
                Stop-Process -Id ([int]$target.pid) -Force -ErrorAction Stop
            }
        } catch {
            $target.last_error = $_.Exception.Message
        }
    }

    # Mettre à jour uniquement pid et started_at, marquer running=false pour nettoyage
    $target.pid        = $null
    $target.started_at = ""
    $target.running    = $false   # ← seul cas où on met running=false : arrêt explicite

    # Résolution de l'instance active restante
    $state2 = Get-State
    if ($state2.active_model -and $state2.active_model -ieq $target.model) {
        $remaining = $state2.instances | Where-Object { $_.running -and $_.id -ne $target.id } | Select-Object -First 1
        if ($remaining) {
            $state2.active_model    = [string]$remaining.model
            $state2.active_filename = [string]$remaining.filename
            $state2.active_path     = [string]$remaining.path
            $state2.started_at      = [string]$remaining.started_at
            foreach ($inst in $state2.instances) { $inst.active = ($inst.id -eq $remaining.id) }
        } else {
            $state2.active_model    = ''
            $state2.active_filename = ''
            $state2.active_path     = ''
            $state2.started_at      = ''
        }
    }

    # Persister running=false dans le fichier pour que Get-ConsistentState nettoie
    $savedTarget = $state2.instances | Where-Object { $_.id -eq $target.id } | Select-Object -First 1
    if ($savedTarget) {
        $savedTarget.pid        = $null
        $savedTarget.started_at = ""
        $savedTarget.running    = $false
    }
    Save-State $state2
    return $state2
}

function Start-LlamaProcess([hashtable]$body) {
    $config = Get-Config
    if (-not $config.binary_path -or -not (Test-Path $config.binary_path)) {
        throw "Binaire llama-server introuvable : $($config.binary_path)"
    }

    $record        = Resolve-ModelRecord([string]$body.model)
    $context       = if ($body.context    -and [int]$body.context    -gt 0) { [int]$body.context    } else { [int]$config.default_context }
    $gpuLayers     = if ($null -ne $body.gpu_layers -and [int]$body.gpu_layers -ge 0) { [int]$body.gpu_layers } else { [int]$config.default_gpu_layers }
    $sleepIdleSecs = if ($body.ContainsKey('sleep_idle_seconds')) { [int]$body.sleep_idle_seconds } elseif ($config.ContainsKey('sleep_idle_seconds')) { [int]$config.sleep_idle_seconds } else { -1 }

    $state = Get-State
    $port  = if ($body.port) { [int]$body.port } else { Get-NextAvailablePort $config $state }
    if (-not $port) {
        throw "Aucune plage de ports disponible pour démarrer un nouveau modèle."
    }

    if ($body.port) {
        $portRangeStart = [int]$config.server_port_start
        $portRangeEnd   = [int]$config.server_port_end
        if ($port -lt $portRangeStart -or $port -gt $portRangeEnd) {
            throw "Port demandé $port en dehors de la plage autorisée ($portRangeStart-$portRangeEnd)."
        }
        $listenerPid = Get-ProcessIdListeningOnPort $port
        if ($listenerPid) {
            $conflicting = $state.instances | Where-Object { $_.port -eq $port -and $_.pid -and [int]$_.pid -ne $listenerPid }
            if ($conflicting) {
                throw "Le port demandé $port est déjà occupé par un autre processus."
            }
        }
    }

    Write-DebugLog "Start-LlamaProcess model=$($body.model) resolved=$($record.model) ctx=$context ngl=$gpuLayers sleep=$sleepIdleSecs port=$port"

    # ── Vérifier si une instance vivante existe déjà sur ce port/modèle ──────
    $existingInstance = $null
    if ($body.port) {
        $existingInstance = $state.instances | Where-Object {
            [int]$_.port -eq [int]$body.port -and $_.running -and $_.pid
        } | Select-Object -First 1
    }
    if (-not $existingInstance) {
        $existingInstance = $state.instances | Where-Object {
            ($_.model -ieq $record.model -or $_.filename -ieq $body.model -or $_.filename -ieq $record.file.Name) -and $_.running -and $_.pid
        } | Select-Object -First 1
    }

    if ($existingInstance) {
        Write-DebugLog "Found existingInstance id=$($existingInstance.id) pid=$($existingInstance.pid)"
        # Vérifier que le processus est vraiment vivant
        $processInfo = Get-LlamaServerProcessInfo ([int]$existingInstance.pid)
        if (-not $processInfo -or $processInfo.has_exited -or $processInfo.command_line -notmatch 'llama-server') {
            Write-DebugLog "Existing instance pid=$($existingInstance.pid) is stale. Recreating."
            $existingInstance = $null
        }
    }

    $activate = $body.ContainsKey('activate') -and $body.activate -eq $true

    # ── Vérifier si la configuration correspond ────────────────────────────
    if ($existingInstance) {
        $existingContext   = if ($existingInstance.context    -and [int]$existingInstance.context    -gt 0) { [int]$existingInstance.context    } else { 0 }
        $existingGpuLayers = if ($null -ne $existingInstance.gpu_layers -and [int]$existingInstance.gpu_layers -ge 0) { [int]$existingInstance.gpu_layers } else { 0 }
        $configMatches     = ($context -eq $existingContext) -and ($gpuLayers -eq $existingGpuLayers)
        Write-DebugLog "Config check: req ctx=$context/ngl=$gpuLayers vs existing ctx=$existingContext/ngl=$existingGpuLayers matches=$configMatches"

        if (-not $configMatches) {
            Write-DebugLog "Config mismatch → destruction de l'instance existante"
            Stop-LlamaProcess @{ id = $existingInstance.id } | Out-Null
            $existingInstance = $null
            Start-Sleep -Milliseconds 1500
        }
    }

    if ($existingInstance) {
        $endpointReady = Test-LlamaServerEndpoint -Port ([int]$existingInstance.port)
        Write-DebugLog "Endpoint test port=$($existingInstance.port) ready=$endpointReady"

        if ($endpointReady -or (Test-TcpEndpoint '127.0.0.1' ([int]$existingInstance.port) 500)) {
            if ($activate) {
                $state2 = Get-State
                foreach ($inst in $state2.instances) {
                    $inst.active = ([string]$inst.id -eq [string]$existingInstance.id)
                }
                $state2.active_model    = [string]$existingInstance.model
                $state2.active_filename = [string]$existingInstance.filename
                $state2.active_path     = [string]$existingInstance.path
                $state2.started_at      = [string]$existingInstance.started_at
                Save-State $state2
                Write-DebugLog "Promoted existing instance id=$($existingInstance.id) as active"
            }
            return Get-State
        }
        # TCP ne répond plus → recréer
        $existingInstance = $null
    }

    # ── Lancer un nouveau processus ────────────────────────────────────────
    $runtimeDir = Get-RuntimeLogDir
    if (-not (Test-Path $runtimeDir)) {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    }

    $stdoutLog = Join-Path $runtimeDir "llama-server.$port.stdout.log"
    $stderrLog = Join-Path $runtimeDir "llama-server.$port.stderr.log"

    $portKey = [string]$port
    $Global:RequestCounter[$portKey]  = 0
    $Global:LastRequestTime[$portKey] = Get-Date

    $arguments = @(
        '--host', '0.0.0.0',
        '--port', ([string]$port),
        '-m', ('"{0}"' -f $record.file.FullName),
        '--ctx-size', ([string]$context),
        '-c', ([string]$context),
        '--cache-ram', '512'
    )
    if ($gpuLayers -gt 0 -and $config.backend -ne 'cpu') {
        $arguments += @('-ngl', ([string]$gpuLayers))
    }
    if ($sleepIdleSecs -ge 0) {
        $arguments += @('--sleep-idle-seconds', ([string]$sleepIdleSecs))
    }

    $pi                      = New-Object System.Diagnostics.ProcessStartInfo
    $pi.FileName             = $config.binary_path
    $pi.Arguments            = $arguments -join ' '
    $pi.WindowStyle          = [System.Diagnostics.ProcessWindowStyle]::Hidden
    $pi.CreateNoWindow       = $true
    $pi.RedirectStandardOutput = $true
    $pi.RedirectStandardError  = $true
    $pi.UseShellExecute      = $false
    $pi.WorkingDirectory     = Split-Path -Parent $config.binary_path

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $pi
    $process.Start() | Out-Null

    $stdoutWriter           = New-Object System.IO.StreamWriter $stdoutLog, $false
    $stderrWriter           = New-Object System.IO.StreamWriter $stderrLog, $false
    $stdoutWriter.AutoFlush = $true
    $stderrWriter.AutoFlush = $true

    Register-ObjectEvent -InputObject $process -EventName OutputDataReceived -Action {
        param($sender, $e)
        if ($e.Data) { $stdoutWriter.WriteLine($e.Data) }
    } | Out-Null

    Register-ObjectEvent -InputObject $process -EventName ErrorDataReceived -Action {
        param($sender, $e)
        if ($e.Data) { $stderrWriter.WriteLine($e.Data) }
    } | Out-Null

    $process.BeginOutputReadLine()
    $process.BeginErrorReadLine()

    $commandLine = $arguments -join ' '
    Write-DebugLog "Launched llama-server pid=$($process.Id) port=$port model=$($record.model) cmd='$commandLine'"
    Write-ProcessMonitorLog "[ProcessStart] pid=$($process.Id) port=$port model=$($record.model)"

    # Watchdog immédiat : crash au démarrage ?
    Start-Sleep -Milliseconds 2000
    if ($process.HasExited) {
        $stderrTail = Get-LastLinesFromFile $stderrLog 30
        Write-ProcessMonitorLog "[ProcessStartFail] pid=$($process.Id) port=$port exitCode=$($process.ExitCode)"
        if ($stderrTail) { Write-ProcessMonitorLog "[ProcessStartFail] stderr:`n$stderrTail" }
        throw "Le processus llama-server s'est arrêté immédiatement. Code: $($process.ExitCode)"
    }

    # ── Mettre à jour le state : pid + started_at uniquement ──────────────
    $state2 = Get-State
    $savedEntry = $state2.instances | Where-Object {
        [string]$_.id -eq [string]$port -or [int]$_.port -eq $port
    } | Select-Object -First 1

    if ($savedEntry) {
        # Mettre à jour l'entrée existante sans l'écraser
        $savedEntry.pid        = $process.Id
        $savedEntry.started_at = (Get-Date).ToString('o')
        $savedEntry.running    = $true
        $savedEntry.stdout_log = $stdoutLog
        $savedEntry.stderr_log = $stderrLog
        $savedEntry.last_error = ""
        $savedEntry.context    = $context
        $savedEntry.gpu_layers = $gpuLayers
        $savedEntry.sleep_idle_seconds = $sleepIdleSecs
        $savedEntry.server_base_url    = "http://127.0.0.1:$port/v1"
        $savedEntry.proxy_id           = "$($config.proxy_model_id)-$port"
        if ($body.estimated_vram_bytes) { $savedEntry.estimated_vram_bytes = [int64]$body.estimated_vram_bytes }
        if (-not $savedEntry.path -and $record.file.FullName) { $savedEntry.path = $record.file.FullName }
    } else {
        # Nouvelle entrée
        $newEntry = @{
            id                   = [string]$port
            port                 = [int]$port
            pid                  = $process.Id
            running              = $true
            model                = $record.model
            filename             = $record.file.Name
            path                 = $record.file.FullName
            started_at           = (Get-Date).ToString('o')
            last_error           = ""
            stdout_log           = $stdoutLog
            stderr_log           = $stderrLog
            estimated_vram_bytes = if ($body.estimated_vram_bytes) { [int64]$body.estimated_vram_bytes } else { $null }
            sleep_idle_seconds   = $sleepIdleSecs
            server_base_url      = "http://127.0.0.1:$port/v1"
            proxy_id             = "$($config.proxy_model_id)-$port"
            active               = $activate
            context              = $context
            gpu_layers           = $gpuLayers
        }
        $state2.instances = @($newEntry) + $state2.instances
    }

    if ($activate) {
        foreach ($inst in $state2.instances) {
            $inst.active = ([string]$inst.id -eq [string]$port)
        }
        $activeSaved = $state2.instances | Where-Object { $_.active } | Select-Object -First 1
        if ($activeSaved) {
            $state2.active_model    = [string]$activeSaved.model
            $state2.active_filename = [string]$activeSaved.filename
            $state2.active_path     = [string]$activeSaved.path
            $state2.started_at      = [string]$activeSaved.started_at
        }
    }

    Save-State $state2
    Write-DebugLog "Save-State after launch: pid=$($process.Id) port=$port model=$($record.model) active=$activate"

    # Attente que le serveur réponde (60 × 600ms = 36s max)
    $serverReady = $false
    for ($i = 0; $i -lt 60; $i++) {
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/models" -Method Get -TimeoutSec 2 -ErrorAction Stop
            if ($response.data -or $response.models) { $serverReady = $true; break }
        } catch {}
        Start-Sleep -Milliseconds 600
    }

    if (-not $serverReady) {
        try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
        throw "Timeout attente llama-server sur le port ${port}"
    }

    Write-ProcessMonitorLog "[ProcessStarted] pid=$($process.Id) port=$port model=$($record.model) ready"
    return Get-State
}

function Test-TcpEndpoint([string]$HostName, [int]$Port, [int]$TimeoutMs = 1000) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Test-LlamaServerEndpoint([int]$Port) {
    try {
        $response = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/v1/models" -Method Get -TimeoutSec 2 -ErrorAction Stop
        return ($response.data -or $response.models)
    } catch {
        return $false
    }
}

function Get-ObjectProperty($object, [string]$name) {
    if ($null -eq $object) { return $null }
    if ($object -is [System.Collections.IDictionary]) { return $object[$name] }
    if ($object.PSObject.Properties.Match($name).Count -gt 0) { return $object.$name }
    return $null
}

function Set-ObjectProperty($object, [string]$name, $value) {
    if ($null -eq $object) { return $object }
    if ($object -is [System.Collections.IDictionary]) { $object[$name] = $value; return $object }
    $object | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
    return $object
}

function ConvertTo-SerializableObject($value) {
    if ($null -eq $value) { return $null }

    if ($value -is [System.Collections.IDictionary]) {
        $obj = [PSCustomObject]@{}
        foreach ($key in $value.Keys) {
            $obj | Add-Member -NotePropertyName ([string]$key) -NotePropertyValue (ConvertTo-SerializableObject $value[$key]) -Force
        }
        return $obj
    }

    if ($value -is [System.Collections.IEnumerable] -and -not ($value -is [string])) {
        $items = @()
        foreach ($item in $value) { $items += ,(ConvertTo-SerializableObject $item) }
        return $items
    }

    return $value
}

function Get-HttpStatusText([int]$statusCode) {
    switch ($statusCode) {
        200 { return 'OK' }
        400 { return 'Bad Request' }
        404 { return 'Not Found' }
        429 { return 'Too Many Requests' }
        500 { return 'Internal Server Error' }
        default { return 'OK' }
    }
}

function Write-Json([System.Net.Sockets.NetworkStream]$stream, [int]$statusCode, $payload) {
    $serializable = ConvertTo-SerializableObject $payload
    $json         = $serializable | ConvertTo-Json -Depth 8 -Compress
    $bodyBytes    = [System.Text.Encoding]::UTF8.GetBytes($json)
    $statusText   = Get-HttpStatusText $statusCode
    $headerText   = "HTTP/1.1 {0} {1}`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: {2}`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: *`r`nConnection: close`r`n`r`n" -f $statusCode, $statusText, $bodyBytes.Length
    $headerBytes  = [System.Text.Encoding]::ASCII.GetBytes($headerText)
    $stream.Write($headerBytes, 0, $headerBytes.Length)
    $stream.Write($bodyBytes, 0, $bodyBytes.Length)
    $stream.Flush()
}

function Read-HttpRequest([System.Net.Sockets.NetworkStream]$stream) {
    $reader      = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $false, 1024, $true)
    $requestLine = $reader.ReadLine()
    if (-not $requestLine) { return $null }

    $parts = $requestLine.Split(' ')
    if ($parts.Count -lt 2) { throw 'Ligne de requete HTTP invalide.' }

    $headers = @{}
    while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line -or $line -eq '') { break }
        $separator = $line.IndexOf(':')
        if ($separator -gt 0) {
            $headers[$line.Substring(0, $separator).Trim()] = $line.Substring($separator + 1).Trim()
        }
    }

    $rawBody       = ''
    $contentLength = 0
    if ($headers.ContainsKey('Content-Length')) {
        [void][int]::TryParse([string]$headers['Content-Length'], [ref]$contentLength)
    }
    if ($contentLength -gt 0) {
        $buffer = New-Object char[] $contentLength
        $offset = 0
        while ($offset -lt $contentLength) {
            $read = $reader.Read($buffer, $offset, $contentLength - $offset)
            if ($read -le 0) { break }
            $offset += $read
        }
        if ($offset -gt 0) { $rawBody = -join $buffer[0..($offset - 1)] }
    }

    return @{
        method   = $parts[0].ToUpperInvariant()
        path     = ([Uri]('http://localhost' + $parts[1])).AbsolutePath.TrimEnd('/')
        raw_body = $rawBody
        headers  = $headers
    }
}

function Read-JsonBody($request) {
    if (-not $request.raw_body) { return @{} }
    return ConvertTo-Hashtable (ConvertFrom-Json $request.raw_body)
}

function Get-RuntimeStatus {
    $config    = Get-Config
    $state     = Get-ConsistentState
    $instances = @()
    $requestCounter = ConvertTo-Hashtable $Global:RequestCounter

    $rawInstances = if ($state.instances -is [System.Collections.IDictionary]) { @($state.instances) } else { $state.instances }

    foreach ($instance in $rawInstances) {
        $portKey = [string]$instance.port
        $instances += @{
            id                   = [string]$instance.id
            port                 = [int]$instance.port
            pid                  = $instance.pid
            request_count        = if ($requestCounter[$portKey]) { $requestCounter[$portKey] } else { 0 }
            last_request_at      = if ($Global:LastRequestTime[$portKey]) { $Global:LastRequestTime[$portKey].ToString('o') } else { $null }
            running              = [bool]$instance.running
            model                = [string]$instance.model
            filename             = [string]$instance.filename
            path                 = [string]$instance.path
            started_at           = [string]$instance.started_at
            last_error           = [string]$instance.last_error
            stdout_log           = [string]$instance.stdout_log
            stderr_log           = [string]$instance.stderr_log
            active               = [bool]$instance.active
            estimated_vram_bytes = if ($instance.estimated_vram_bytes) { [int64]$instance.estimated_vram_bytes } else { $null }
            server_base_url      = [string]$instance.server_base_url
            proxy_id             = [string]$instance.proxy_id
            context              = if ($instance.context    -and [int]$instance.context    -gt 0) { [int]$instance.context    } else { $null }
            gpu_layers           = if ($null -ne $instance.gpu_layers -and [int]$instance.gpu_layers -ge 0) { [int]$instance.gpu_layers } else { $null }
        }
    }

    $gpu            = Get-GpuState
    $activeInstance = $instances | Where-Object { $_.active } | Select-Object -First 1
    if (-not $activeInstance -and $instances.Count -gt 0) { $activeInstance = $instances[0] }

    return @{
        running            = [bool]($instances.Count -gt 0)
        pid                = if ($activeInstance) { $activeInstance.pid } else { $null }
        active_model       = if ($activeInstance) { [string]$activeInstance.model } else { '' }
        active_filename    = if ($activeInstance) { [string]$activeInstance.filename } else { '' }
        active_path        = if ($activeInstance) { [string]$activeInstance.path } else { '' }
        started_at         = if ($activeInstance) { [string]$activeInstance.started_at } else { '' }
        last_error         = if ($activeInstance) { [string]$activeInstance.last_error } else { '' }
        stdout_log         = if ($activeInstance) { [string]$activeInstance.stdout_log } else { '' }
        stderr_log         = if ($activeInstance) { [string]$activeInstance.stderr_log } else { '' }
        backend            = [string]$config.backend
        backend_label      = [string]$config.backend_label
        binary_path        = [string]$config.binary_path
        models_dir         = [string]$config.models_dir
        server_port        = [int]$config.server_port
        server_port_start  = [int]$config.server_port_start
        server_port_end    = [int]$config.server_port_end
        proxy_model_id     = [string]$config.proxy_model_id
        default_context    = [int]$config.default_context
        default_gpu_layers = [int]$config.default_gpu_layers
        instances          = $instances
        request_counter    = $requestCounter
        gpu                = $gpu
    }
}

# ═════════════════════════════════════════════════════════════════════════════
# DÉMARRAGE : restaurer TOUTES les instances running=true, quel que soit active.
# active=true signifie "modèle principal" — pas un état d'activité réelle.
# Le fichier state est conservé tel quel — seuls pid et started_at sont mis à jour.
# Ordre : inactifs en premier, actif (le principal) en dernier.
# ═════════════════════════════════════════════════════════════════════════════
try {
    $state  = Get-State
    $config = Get-Config

    Write-DebugLog "Startup: total instances in state=$($state.instances.Count)"

    $toRestore = @()
    foreach ($instance in $state.instances) {
        # Ignorer uniquement les instances explicitement arrêtées
        if (-not $instance.running) {
            Write-DebugLog "Startup: skip id=$($instance.id) model=$($instance.model) running=false"
            continue
        }

        if ($instance.pid) {
            $process = Get-Process -Id ([int]$instance.pid) -ErrorAction SilentlyContinue
            if ($process -and -not $process.HasExited) {
                # Processus encore vivant → réattacher sans relancer
                Write-Host "[Controller] Réattachement processus vivant PID=$($instance.pid) port=$($instance.port) model=$($instance.model)"
                Write-DebugLog "Startup: reattach live pid=$($instance.pid) port=$($instance.port)"
                $instance.started_at = $process.StartTime.ToString('o')
                continue
            }
        }

        # Processus mort ou absent → à relancer
        $instance.pid        = $null
        $instance.started_at = ""
        $toRestore          += $instance
        Write-DebugLog "Startup: queued restore id=$($instance.id) model=$($instance.model) port=$($instance.port) active=$($instance.active)"
    }

    # Sauvegarder l'état nettoyé avant de lancer les processus
    Save-State $state
    Write-DebugLog "Startup: state saved before restore, toRestore=$($toRestore.Count)"

    # Lancer les inactifs en premier (ils ne sont pas le modèle principal)
    foreach ($instance in ($toRestore | Where-Object { -not $_.active })) {
        try {
            $ctx       = if ($instance.context       -and [int]$instance.context       -gt 0) { [int]$instance.context       } else { [int]$config.default_context }
            $ngl       = if ($null -ne $instance.gpu_layers -and [int]$instance.gpu_layers -ge 0) { [int]$instance.gpu_layers } else { [int]$config.default_gpu_layers }
            $sleepSecs = if ($instance.ContainsKey('sleep_idle_seconds')) { [int]$instance.sleep_idle_seconds } else { [int]$config.sleep_idle_seconds }

            Write-Host "[Controller] Restauration instance : $($instance.model) port=$($instance.port) ctx=$ctx ngl=$ngl active=false"
            Write-DebugLog "Startup: restoring inactive id=$($instance.id) model=$($instance.model) port=$($instance.port) ctx=$ctx ngl=$ngl"

            $body = @{
                model              = if ($instance.filename) { $instance.filename } else { $instance.model }
                context            = $ctx
                gpu_layers         = $ngl
                port               = [int]$instance.port
                activate           = $false
                sleep_idle_seconds = $sleepSecs
            }
            if ($instance.estimated_vram_bytes) { $body.estimated_vram_bytes = [int64]$instance.estimated_vram_bytes }

            Start-LlamaProcess $body | Out-Null
            Write-Host "[Controller] ✅ Instance restaurée : $($instance.model) port=$($instance.port)"
        } catch {
            Write-Host "[Controller] ❌ Echec restauration $($instance.model) port=$($instance.port) : $($_.Exception.Message)"
            Write-DebugLog "Startup: restore failure id=$($instance.id) error=$($_.Exception.Message)"
            $state2 = Get-State
            $saved  = $state2.instances | Where-Object { [string]$_.id -eq [string]$instance.id } | Select-Object -First 1
            if ($saved) {
                $saved.pid        = $null
                $saved.last_error = [string]$_.Exception.Message
                $saved.started_at = ""
                # running reste true → watchdog retentera
            }
            Save-State $state2
        }
    }

    # Lancer le modèle principal (active=true) en dernier
    $activeInstance = $toRestore | Where-Object { $_.active } | Select-Object -First 1
    if ($activeInstance) {
        try {
            $ctx       = if ($activeInstance.context       -and [int]$activeInstance.context       -gt 0) { [int]$activeInstance.context       } else { [int]$config.default_context }
            $ngl       = if ($null -ne $activeInstance.gpu_layers -and [int]$activeInstance.gpu_layers -ge 0) { [int]$activeInstance.gpu_layers } else { [int]$config.default_gpu_layers }
            $sleepSecs = if ($activeInstance.ContainsKey('sleep_idle_seconds')) { [int]$activeInstance.sleep_idle_seconds } else { [int]$config.sleep_idle_seconds }

            Write-Host "[Controller] Restauration modèle principal : $($activeInstance.model) port=$($activeInstance.port) ctx=$ctx ngl=$ngl"
            Write-DebugLog "Startup: restoring active id=$($activeInstance.id) model=$($activeInstance.model) port=$($activeInstance.port) ctx=$ctx ngl=$ngl"

            $body = @{
                model              = if ($activeInstance.filename) { $activeInstance.filename } else { $activeInstance.model }
                context            = $ctx
                gpu_layers         = $ngl
                port               = [int]$activeInstance.port
                activate           = $false   # active est préservé depuis le state, pas besoin de re-promouvoir
                sleep_idle_seconds = $sleepSecs
            }
            if ($activeInstance.estimated_vram_bytes) { $body.estimated_vram_bytes = [int64]$activeInstance.estimated_vram_bytes }

            Start-LlamaProcess $body | Out-Null

            # Restaurer le flag active=true et les champs active_* du state
            $state2     = Get-State
            $savedActive = $state2.instances | Where-Object { [string]$_.id -eq [string]$activeInstance.id } | Select-Object -First 1
            if ($savedActive) {
                $savedActive.active         = $true
                $state2.active_model        = [string]$savedActive.model
                $state2.active_filename     = [string]$savedActive.filename
                $state2.active_path         = [string]$savedActive.path
                $state2.started_at          = [string]$savedActive.started_at
            }
            Save-State $state2
            Write-Host "[Controller] ✅ Modèle principal restauré : $($activeInstance.model) port=$($activeInstance.port)"
        } catch {
            Write-Host "[Controller] ❌ Echec restauration modèle principal $($activeInstance.model) : $($_.Exception.Message)"
            Write-DebugLog "Startup: active restore failure id=$($activeInstance.id) error=$($_.Exception.Message)"
            $state2 = Get-State
            $saved  = $state2.instances | Where-Object { [string]$_.id -eq [string]$activeInstance.id } | Select-Object -First 1
            if ($saved) {
                $saved.pid        = $null
                $saved.last_error = [string]$_.Exception.Message
                $saved.started_at = ""
                # running reste true → watchdog retentera
            }
            Save-State $state2
        }
    }
} catch {
    Write-Host "[Controller] Erreur relance auto : $($_.Exception.Message)"
    Write-DebugLog "Startup: fatal error $($_.Exception.Message)"
} finally {
    # Libérer le verrou startup dans tous les cas
    $Global:StartupInProgress = $false
    Write-DebugLog "Startup: sequence terminée, StartupInProgress=false"
}

# ═════════════════════════════════════════════════════════════════════════════
# WATCHDOG : vérification toutes les 30 secondes
# ═════════════════════════════════════════════════════════════════════════════
$watchdogTimer          = New-Object System.Timers.Timer
$watchdogTimer.Interval = 30000
$watchdogTimer.AutoReset = $true
Register-ObjectEvent -InputObject $watchdogTimer -EventName Elapsed -Action {
    try {
        Write-Host "[Watchdog] Vérification état..."
        Monitor-LlamaInstances
        $state = Get-ConsistentState
        Repair-DeadInstances $state

        # Persister compteurs
        $state2 = Get-State
        $state2.request_counter  = ConvertTo-Hashtable $Global:RequestCounter
        $state2.last_request_time = @{}
        foreach ($key in $Global:LastRequestTime.Keys) {
            $state2.last_request_time[[string]$key] = $Global:LastRequestTime[$key].ToString('o')
        }
        Save-State $state2
    } catch {
        Write-Host "[Watchdog] Erreur: $($_.Exception.Message)"
    }
} | Out-Null
$watchdogTimer.Start()

try {
    Register-ObjectEvent -InputObject [Microsoft.Win32.SystemEvents] -EventName PowerModeChanged -Action {
        try {
            $mode = $Event.SourceEventArgs.Mode
            if ($mode -eq [Microsoft.Win32.PowerModes]::Resume) {
                Write-Host "[Controller] Sortie de veille, restauration des instances..."
                $state = Get-State
                Monitor-LlamaInstances
                Repair-DeadInstances $state
                Get-ConsistentState | Out-Null
            }
        } catch {
            Write-Host "[Controller] Erreur PowerModeChanged : $($_.Exception.Message)"
        }
    } | Out-Null
} catch {
    Write-Host "[Controller] Impossible d'enregistrer PowerModeChanged : $($_.Exception.Message)"
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
try {
    $listener.Start()
} catch {
    throw "Impossible de demarrer le controleur sur 0.0.0.0:$Port. Detail: $($_.Exception.Message)"
}

# Restaurer compteurs depuis l'état
try {
    $state = Get-State
    if ($state.request_counter) { $Global:RequestCounter = ConvertTo-Hashtable $state.request_counter }
    if ($state.last_request_time) {
        foreach ($key in $state.last_request_time.Keys) {
            $Global:LastRequestTime[[string]$key] = [datetime]$state.last_request_time[$key]
        }
    }
} catch {}

Write-Host "[Controller] Démarré sur le port $Port"
Write-Host "[Controller] Watchdog actif toutes les 30s"

# ═════════════════════════════════════════════════════════════════════════════
# BOUCLE PRINCIPALE HTTP
# ═════════════════════════════════════════════════════════════════════════════
while ($true) {
    $client = $null
    try {
        $asyncResult = $listener.BeginAcceptTcpClient($null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne(1000)) { continue }

        $client                = $listener.EndAcceptTcpClient($asyncResult)
        $client.ReceiveTimeout = 30000
        $client.SendTimeout    = 60000

        $stream  = $client.GetStream()
        $request = Read-HttpRequest $stream

        $Global:RequestCounter['total'] = if ($Global:RequestCounter['total']) { $Global:RequestCounter['total'] + 1 } else { 1 }

        if (-not $request) { continue }

        $path = if ($request.path) { $request.path } else { '/' }

        # Mise à jour timestamp par instance
        foreach ($instance in (Get-State).instances) {
            if ($request.raw_body -match "\b$($instance.port)\b" -or $request.path -match "\b$($instance.port)\b") {
                $portKey = [string]$instance.port
                $Global:LastRequestTime[$portKey] = Get-Date
                $Global:RequestCounter[$portKey]  = if ($Global:RequestCounter[$portKey]) { $Global:RequestCounter[$portKey] + 1 } else { 1 }
            }
        }

        switch ("$($request.method) $path") {
            'OPTIONS /' {
                Write-Json $stream 200 @{ ok = $true }
                continue
            }
            'GET /health' {
                Write-Json $stream 200 @{ ok = $true; controller = 'lia-host-controller' }
                continue
            }
            'GET /status' {
                Write-Json $stream 200 (Get-RuntimeStatus)
                continue
            }
            'POST /start' {
                $body = Read-JsonBody $request
                if (-not $body.model) {
                    Write-Json $stream 400 @{ detail = 'model requis' }
                    continue
                }

                Write-Host "[controller] POST /start model=$($body.model) context=$($body.context)"

                $config = Get-Config
                $state  = Get-ConsistentState
                $existingInstance = $state.instances | Where-Object { $_.model -ieq $body.model -and $_.running } | Select-Object -First 1
                if ($existingInstance) {
                    if ($body.ContainsKey('activate') -and $body.activate -eq $true) {
                        if (-not $existingInstance.active -or $body.ContainsKey('context') -or $body.ContainsKey('gpu_layers')) {
                            Write-Host "[controller] model déjà chargé, vérification activation/reload : $($body.model)"
                            Start-LlamaProcess $body | Out-Null
                        } else {
                            Write-Host "[controller] model déjà chargé et actif : $($body.model)"
                        }
                    } else {
                        Write-Host "[controller] model déjà chargé, pas de promotion : $($body.model)"
                    }
                    Write-Json $stream 200 (Get-RuntimeStatus)
                    continue
                }

                $runningCount = ($state.instances | Where-Object { $_.running } | Measure-Object).Count
                if ($runningCount -ge $config.max_instances) {
                    Write-Json $stream 429 @{ detail = "Limite maximum de $($config.max_instances) instances atteinte" }
                    continue
                }

                Start-LlamaProcess $body | Out-Null
                Write-Json $stream 200 (Get-RuntimeStatus)
                continue
            }
            'POST /stop' {
                $body = Read-JsonBody $request
                Write-Host "[controller] POST /stop model=$($body.model) id=$($body.id) port=$($body.port)"
                Stop-LlamaProcess $body | Out-Null
                Write-Json $stream 200 (Get-RuntimeStatus)
                continue
            }
            'POST /restart' {
                $body = Read-JsonBody $request

                Write-Host "[controller] POST /start model=$($body.model) context=$($body.context)"
                
                # Toujours activer le modèle par défaut quand on lance depuis /start
                if (-not $body.ContainsKey('activate')) {
                    $body.activate = $true
                }
                
                $result = Start-LlamaProcess $body
                $state = Get-ConsistentState

                Write-JsonResponse $listener $state
                continue
            }
            default {
                Write-Json $stream 404 @{ detail = 'Route introuvable' }
                continue
            }
        }
    } catch {
        if ($client -and $client.Connected) {
            try { Write-Json $client.GetStream() 500 @{ detail = $_.Exception.Message } } catch {}
        }
    } finally {
        if ($client) { $client.Dispose() }
    }
}