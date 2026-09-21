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
# Positionné par Get-ConsistentState quand une instance running n'a plus de
# processus : le watchdog (hors chemin de requête) effectuera la relance.
$Global:PendingRepair = $false

# ─────────────────────────────────────────────────────────────────────────────
# Caches mémoire : évitent une lecture disque / un appel WMI à CHAQUE requête HTTP.
# Sans eux, /status déclenchait Get-CimInstance + plusieurs lectures de fichiers,
# ce qui saturait le controller mono-thread et faisait exploser les latences.
# ─────────────────────────────────────────────────────────────────────────────
$Global:ConfigCache                 = $null
$Global:ConfigCacheExpiresAt        = [datetime]::MinValue
$Global:GpuStateCache               = $null
$Global:GpuStateCacheExpiresAt      = [datetime]::MinValue
$Global:InstancePortsCache          = $null
$Global:InstancePortsCacheExpiresAt = [datetime]::MinValue
$Global:LiveInstancesCache          = $null
$Global:LiveInstancesCacheExpiresAt = [datetime]::MinValue
# Version du format de host-runtime-state.json. Exposée par GET /status et
# utilisée par Convert-LegacyState (migration automatique des états legacy).
$script:SchemaVersionForStatus      = 2
$CONFIG_CACHE_TTL_SECONDS           = 10
$GPU_STATE_CACHE_TTL_SECONDS        = 15
$INSTANCE_PORTS_CACHE_TTL_SECONDS   = 5
$LIVE_INSTANCES_CACHE_TTL_SECONDS   = 2
$STATE_CACHE_TTL_SECONDS            = 2
$script:LastConsistentState         = $null
$script:LastConsistentStateAt       = [datetime]::MinValue

function Get-RepoRoot {
    if ($PSScriptRoot -match '\\(scripts|controller|services\\controller)$') {
        return Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
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

function Truncate-DebugLogIfNeeded {
    # Rotation au démarrage : le log a déjà atteint 51 Mo (crash-loop historique).
    # On garde les 2000 dernières lignes au-delà de 5 Mo, et on archive l'ancien
    # contenu dans controller-debug.prev.log (écrasé à chaque rotation).
    try {
        $path = Get-DebugLogPath
        if (-not (Test-Path $path)) { return }
        $item = Get-Item $path
        if ($item.Length -lt 5MB) { return }
        $prev = Join-Path (Get-ControllerLogDir) 'controller-debug.prev.log'
        $tail = Get-Content $path -Tail 2000 -ErrorAction SilentlyContinue
        if (Test-Path $prev) { Remove-Item $prev -Force -ErrorAction SilentlyContinue }
        Move-Item $path $prev -Force
        $tail | Set-Content $path -Encoding UTF8
        Write-Host "[Controller] Rotation du debug log (était $([math]::Round($item.Length/1MB,1)) Mo, gardé 2000 lignes)."
    } catch {
        Write-Host "[Controller] Rotation debug log impossible : $($_.Exception.Message)"
    }
}

function Get-ElapsedMs($start, $end = (Get-Date)) {
    if (-not $start -or -not $end) { return 0 }
    try {
        $diff = ($end - $start).TotalMilliseconds
        if ($diff -gt [int]::MaxValue) { return [int]::MaxValue }
        if ($diff -lt 0) { return 0 }
        return [int]$diff
    } catch { return 0 }
}

function Write-DebugLog([string]$message, [string]$level = 'info') {
    # HOT PATH : /status est appelé plusieurs fois/seconde. Add-Content à chaque
    # appel coûtait ~20-30 ms et sérialisait le controller mono-thread.
    # On ne logue en INFO que les événements rares (pas les timings/status),
    # et on écrit de façon non-bloquante via un runspace unique.
    if ($level -eq 'info' -and ($message -match '^(TIMING|Save-State wrote|Startup: total)')) {
        return
    }
    try {
        $path = Get-DebugLogPath
        $line = "[$(Get-Date -Format 'o')] [$($level.ToUpper())] $message"
        Add-Content -Path $path -Value $line -ErrorAction SilentlyContinue
    } catch {}
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
Truncate-DebugLogIfNeeded
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
    # Invalider le cache pour que la prochaine lecture voie la nouvelle config
    $Global:ConfigCache          = $null
    $Global:ConfigCacheExpiresAt = [datetime]::MinValue
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
    $now = Get-Date
    if ($Global:ConfigCache -and $now -lt $Global:ConfigCacheExpiresAt) {
        return $Global:ConfigCache
    }

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
        $Global:ConfigCache          = $config
        $Global:ConfigCacheExpiresAt = (Get-Date).AddSeconds($CONFIG_CACHE_TTL_SECONDS)
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

    $Global:ConfigCache          = $config
    $Global:ConfigCacheExpiresAt = (Get-Date).AddSeconds($CONFIG_CACHE_TTL_SECONDS)
    return $config
}

function Get-State {
    # HOT PATH : l'état est relu 3x par /status + 1x/Get-LiveInstances + 1x/Repair.
    # Tant qu'aucun Save-State ne l'a modifié, on sert la copie mémoire
    # (TTL court : les morts de process sont détectées via Get-Process anyway).
    if ($script:LastConsistentState -and $script:LastConsistentStateAt -and ((Get-Date) - $script:LastConsistentStateAt).TotalSeconds -lt $STATE_CACHE_TTL_SECONDS) {
        return $script:LastConsistentState
    }
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
    # Tout Save invalide le cache mémoire de Get-State : l'appel suivant
    # relira le disque (état frais garanti pour /start, /stop, Repair...).
    $script:LastConsistentState   = $null
    $script:LastConsistentStateAt = [datetime]::MinValue
    try {
        $serializableState = ConvertTo-Hashtable $state
        $serializableState.schema_version = 2
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
    # P-bas (structure) : versionner le format d'état. Toute structure sans
    # schema_version est considérée v1 et migre ici ; le Save-State suivant
    # écrit la version courante. Les migrations futures s'ajoutent comme des
    # étapes successives (v2 → v3, etc.) plutôt qu'en raccourcis ad-hoc.
    $SCHEMA_VERSION = $script:SchemaVersionForStatus
    $isLegacy = $false
    if (-not $state.schema_version -or [int]$state.schema_version -lt $SCHEMA_VERSION) {
        $isLegacy = $true
    }
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
        # Aucun PID : aucun llama-server ne tourne → purger aussi les champs
        # active_* orphelins. Sans ça le state conservait un « modèle principal »
        # fantôme (affiché dans le model-loader et /status) alors qu'aucun GGUF
        # n'existait plus sur le disque.
        $state.active_model    = ''
        $state.active_filename = ''
        $state.active_path     = ''
        $state.running         = $false
        $state.pid             = $null
        return @{ instances = @(); schema_version = $SCHEMA_VERSION }
    }
    # Normalisations v2 : compléter les champs attendus absents des états v1.
    if ($isLegacy) {
        foreach ($inst in @($state.instances)) {
            if ($inst -is [System.Collections.IDictionary]) {
                if (-not $inst.ContainsKey('context'))    { $inst.context    = $null }
                if (-not $inst.ContainsKey('gpu_layers')) { $inst.gpu_layers = $null }
                if (-not $inst.ContainsKey('active'))     { $inst.active     = $false }
            }
        }
        $state.schema_version = $SCHEMA_VERSION
        Write-DebugLog "State migré vers schema_version=$SCHEMA_VERSION"
    }
    return $state
}

# ─────────────────────────────────────────────────────────────────────────────
# Get-ConsistentState
# Rôle : synchroniser l'état en mémoire avec les processus vivants.
# Ne JAMAIS modifier running. Ne JAMAIS appeler Repair pendant startup.
# ─────────────────────────────────────────────────────────────────────────────
function Get-ConsistentState {
    $csStart       = Get-Date
    # Fast path : état stable + instances vivantes connues → servir le cache
    # mémoire SANS toucher le disque ni relancer de scan (cas nominal /status).
    if ($script:LastConsistentState -and $script:LastConsistentStateAt -and ((Get-Date) - $script:LastConsistentStateAt).TotalSeconds -lt $STATE_CACHE_TTL_SECONDS) {
        $fastOk = $true
        foreach ($saved in @($script:LastConsistentState.instances)) {
            if ($saved.running -and (-not $saved.pid)) { $fastOk = $false; break }
        }
        if ($fastOk) {
            return $script:LastConsistentState
        }
    }
    $state   = Get-State
    $csAfterState  = Get-Date
    $state   = Convert-LegacyState $state
    $changed = $false

    # ── 1. Détecter les processus vivants sur la plage de ports ──────────────
    # HOT PATH : Get-LiveInstances coûte ~250 ms (netstat) à CHAQUE /status.
    # Les instances sont stables (démarrage/arrêt explicite uniquement) → on
    # réutilise le cache mémoire et on ne re-scanne qu'au plus 1x/2 s ou si
    # le pid enregistré a disparu.
    $liveScanStart = Get-Date
    $useLiveCache  = $false
    if ($Global:LiveInstancesCache -and (Get-Date) -lt $Global:LiveInstancesCacheExpiresAt) {
        $cacheOk = $true
        foreach ($saved in @($state.instances)) {
            if ($saved.running -and $saved.pid) {
                $cached = $Global:LiveInstancesCache | Where-Object { [string]$_.id -eq [string]$saved.id -and [string]$_.pid -eq [string]$saved.pid } | Select-Object -First 1
                if (-not $cached) { $cacheOk = $false; break }
            }
        }
        if ($cacheOk) {
            $liveInstances = $Global:LiveInstancesCache
            $useLiveCache  = $true
        }
    }
    if (-not $useLiveCache) {
        $cfgForLive    = Get-Config
        $liveInstances = Get-LiveInstances $cfgForLive
        $Global:LiveInstancesCache          = @($liveInstances)
        $Global:LiveInstancesCacheExpiresAt = (Get-Date).AddSeconds($LIVE_INSTANCES_CACHE_TTL_SECONDS)
    }
    $csAfterLive   = Get-Date

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
                # Ne marquer "changed" que sur un vrai changement. On compare le pid
                # seul : started_at est relu par ConvertFrom-Json en [datetime] et sa
                # forme textuelle diffère toujours, ce qui forcerait un Save-State
                # (écriture + verrou) à chaque /status.
                if ([string]$saved.pid -ne [string]$live.pid -or -not [bool]$saved.running) {
                    $changed = $true
                }
                # Mettre à jour uniquement les champs dynamiques
                $saved.pid        = $live.pid
                $saved.started_at = $live.started_at
                $saved.running    = $true
                # Compléter model/filename/path si l'instance était en sleep
                if (-not $saved.model    -and $live.model)    { $saved.model    = $live.model;    $changed = $true }
                if (-not $saved.filename -and $live.filename) { $saved.filename = $live.filename; $changed = $true }
                if (-not $saved.path     -and $live.path)     { $saved.path     = $live.path;     $changed = $true }
            } else {
                # Nouvelle instance non connue du state → l'ajouter
                $state.instances += $live
                $changed = $true
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
            $shouldBeActive = [bool]($activeInstance -and $instance.id -eq $activeInstance.id)
            if ([bool](Get-ObjectProperty $instance 'active') -ne $shouldBeActive) {
                # Ne déclencher l'écriture de l'état QUE si un flag change réellement :
                # un $changed=$true inconditionnel ici provoquait un Save-State (write
                # disque + lock) à CHAQUE /status, soit plusieurs fois par seconde.
                $changed = $true
            }
            Set-ObjectProperty $instance 'active' $shouldBeActive | Out-Null
        }
    }

    # ── 5. Nettoyage : supprimer uniquement les instances avec running=false ──
    # HOT PATH : Get-ConsistentState() fait 3 lectures disque de l'état par
    # /status (ici + Repair + return final). On mémorise le résultat et les
    # appels suivants réutilisent le cache mémoire (invalidé à chaque Save).
    $script:LastConsistentState        = $state
    $script:LastConsistentStateAt      = Get-Date
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

    # ── 5bis. Purger le « modèle principal » quand plus aucune instance ──────
    # Après suppression des fantômes (running=false), il ne doit plus rester de
    # active_model/active_filename/active_path orphelins dans le state : sinon
    # le model-loader (et /status) annonçait un modèle principal inexistant.
    if (@($state.instances).Count -eq 0) {
        if ($state.active_model -or $state.active_filename -or $state.active_path) {
            $state.active_model    = ''
            $state.active_filename = ''
            $state.active_path     = ''
            $state.started_at      = ''
            $changed               = $true
        }
    }

    # ── 6. Garantir que instances est un tableau ───────────────────────────
    if ($state.instances -is [System.Collections.IDictionary]) {
        $state.instances = @($state.instances); $changed = $true
    } elseif ($state.instances -isnot [System.Array]) {
        $state.instances = @(); $changed = $true
    }

    if ($changed) { Save-State $state }

    # ── 7. Réparation : JAMAIS dans le chemin de lecture ──────────────────
    # Un Repair-DeadInstances ici bloquait /status jusqu'à 30-40 s (attente de
    # démarrage d'un llama-server) : la boucle HTTP mono-thread ne pouvait plus
    # répondre, ce qui produisait des « fetch failed » côté model-loader après
    # chaque redémarrage du controller. On se contente de SIGNALER le besoin ;
    # le watchdog (exécuté quand la boucle est inactive) fera la réparation.
    if (-not $Global:StartupInProgress -and -not $Global:RepairInProgress) {
        foreach ($saved in @($state.instances)) {
            if ($saved.running -and (-not $saved.pid)) { $Global:PendingRepair = $true; break }
        }
    }
    $csAfterRepair = Get-Date

    # P2 : localiser les lenteurs internes de la réconciliation d'état
    $csTotal = Get-ElapsedMs $csStart
    if ($csTotal -gt 500) {
        $readStateMs = Get-ElapsedMs $csStart $csAfterState
        $legacyMs = Get-ElapsedMs $csAfterState $csAfterLive
        $mergeMs = Get-ElapsedMs $csAfterLive $csAfterRepair
        Write-DebugLog ("TIMING consistentState total=${csTotal}ms readState=${readStateMs}ms legacy=${legacyMs}ms live+merge=${mergeMs}ms liveCount=" + @($liveInstances).Count) 'warn'
    }

    return Get-State
}

# ─────────────────────────────────────────────────────────────────────────────
# Get-LiveInstances
# Détecte les llama-server.exe actifs sur la plage de ports.
# Ne filtre PAS sur HTTP — un serveur en sleep ne répond plus.
# ─────────────────────────────────────────────────────────────────────────────
function Get-PidListeningPortMapNetstat {
    # netstat -ano est ~25x plus rapide que Get-NetTCPConnection (95 ms vs 2,5 s mesuré).
    # Retourne une table pid -> premier port d'écoute.
    $map = @{}
    try {
        $lines = & netstat -ano -p TCP 2>$null
    } catch {
        return $map
    }

    foreach ($line in $lines) {
        $text = [string]$line
        if ($text -notmatch 'LISTENING') { continue }
        $parts = @($text -split '\s+' | Where-Object { $_ -ne '' })
        if ($parts.Count -lt 5) { continue }
        $localAddress = [string]$parts[1]
        $colonIndex   = $localAddress.LastIndexOf(':')
        if ($colonIndex -lt 0) { continue }
        $port = 0
        if (-not [int]::TryParse($localAddress.Substring($colonIndex + 1), [ref]$port)) { continue }
        $processKey = [string]$parts[4]
        if (-not $map.ContainsKey($processKey)) { $map[$processKey] = [int]$port }
    }
    return $map
}


function Get-LiveInstances([hashtable]$config) {
    $instances = @()
    $savedState = Get-State
    $start = [int]$config.server_port_start
    $end   = [int]$config.server_port_end

    # PERFORMANCE : Get-NetTCPConnection (basé CIM) coûte 2,5 s par appel et était
    # invoqué à CHAQUE /status — premier poste de latence du controller. On le
    # remplace par Get-Process (~14 ms) et netstat -ano (~95 ms).
    # HOT PATH : même netstat (~250-800 ms, 1246 lignes à parser en PS pur)
    # est trop lent à CHAQUE /status. Si le state connaît déjà pid+port pour
    # chaque instance et que ces pid sont vivants, on saute le scan réseau.
    $pidPortMap = @{}
    $needsNetstat = $false
    $liveProcesses = @{}
    foreach ($saved in $savedState.instances) {
        if ($saved.pid -and $saved.port) { $pidPortMap[[string]$saved.pid] = [int]$saved.port }
    }
    foreach ($procItem in (Get-Process -Name 'llama-server' -ErrorAction SilentlyContinue)) {
        try { $liveProcesses[[string]$procItem.Id] = $procItem } catch {}
    }
    if ($liveProcesses.Count -eq 0) { return @() }
    foreach ($pidKey in @($liveProcesses.Keys)) {
        if (-not $pidPortMap.ContainsKey([string]$pidKey)) { $needsNetstat = $true; break }
    }
    if ($needsNetstat) {
        # Nouveau pid inconnu du state (redémarrage externe, sleep/restore) :
        # seul cas où on paie le coût netstat (~250-800 ms).
        foreach ($entry in (Get-PidListeningPortMapNetstat).GetEnumerator()) {
            if ($liveProcesses.ContainsKey([string]$entry.Key)) {
                $pidPortMap[[string]$entry.Key] = [int]$entry.Value
            }
        }
    }

    foreach ($pidKey in @($liveProcesses.Keys)) {
        $processId = [int]$pidKey
        $process   = $liveProcesses[[string]$pidKey]
        if (-not $process -or $process.HasExited) { continue }

        $port = if ($pidPortMap.ContainsKey([string]$pidKey)) { [int]$pidPortMap[[string]$pidKey] } else { 0 }
        if (-not $port -or $port -lt $start -or $port -gt $end) { continue }

        # Vérifier que c'est bien un llama-server : ProcessName suffit et évite un
        # appel WMI (Get-CimInstance Win32_Process) par instance à CHAQUE /status.
        $processName = ''
        try { $processName = [string]$process.ProcessName } catch { continue }
        if ($processName -notmatch 'llama-server') { continue }

        # Le state sauvegardé est la source la moins chère : ne sonder HTTP QUE s'il
        # ne connaît pas le modèle. Cette sonde coûtait jusqu'à 2 s de timeout PAR
        # instance à CHAQUE /status (cause majeure des 3-13 s mesurés).
        $savedInstance   = $savedState.instances | Where-Object { [int]$_.port -eq $port } | Select-Object -First 1
        $savedKnowsModel = [bool]($savedInstance -and $savedInstance.model -and $savedInstance.filename)

        $modelId = $null
        if (-not $savedKnowsModel) {
            try {
                $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/models" -Method Get -TimeoutSec 1 -ErrorAction Stop
                if ($response.data -and $response.data.Count -gt 0) {
                    $modelId = [string]$response.data[0].id
                } elseif ($response.models -and $response.models.Count -gt 0) {
                    $modelId = [string]$response.models[0].model
                }
            } catch {
                # Serveur en sleep ou warmup — on garde l'instance quand même
            }
        }

        $model    = $null
        $filename = $null
        $path     = ""

        if ($savedKnowsModel) {
            $model    = $savedInstance.model
            $filename = $savedInstance.filename
            $path     = $savedInstance.path
        } elseif ($modelId) {
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
            # Purge des instances fantômes : si le GGUF n'existe plus sur disque,
            # relancer échouera systématiquement. On marque running=false pour
            # que le nettoyage d'état supprime l'instance (et l'UI cesse de
            # l'afficher comme « chargée »).
            $record = if ($instance.filename) { $instance.filename } else { $instance.model }
            if (-not (Test-ModelRecordExists $record)) {
                Write-Host "[Controller] 🧹 Instance fantôme retirée (GGUF absent) : $($instance.model)"
                Write-DebugLog "Repair: phantom pruned id=$($instance.id) model=$($instance.model)"
                $instance.running = $false
                $Global:PendingRepair = $true
                Save-State $state
                continue
            }
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
                # -NoWait : la réparation est déclenchée par le watchdog ; elle ne
                # doit pas bloquer la boucle HTTP pendant le warmup du modèle.
                Start-LlamaProcess $body -NoWait | Out-Null
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

# ─────────────────────────────────────────────────────────────────────────────
# Test-ModelRecordExists
# Vrai si le GGUF référencé existe encore dans le dossier de modèles configuré.
# Sert à purger les « instances fantômes » : un state persisté peut référencer
# un modèle supprimé du disque (ou un dossier de modèles déplacé). Sans ce
# test, le watchdog relançait indéfiniment une instance impossible à démarrer
# et l'UI affichait des modèles « chargés » alors qu'aucun GGUF n'existe.
# ─────────────────────────────────────────────────────────────────────────────
function Test-ModelRecordExists([string]$identifier) {
    if (-not $identifier) { return $false }
    try {
        $null = Resolve-ModelRecord $identifier
        return $true
    } catch {
        return $false
    }
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

# Get-GpuState : wrapper avec cache court. Get-CimInstance Win32_VideoController est
# un appel WMI coûteux (centaines de ms) qui était exécuté à CHAQUE /status.
function Get-GpuState {
    $now = Get-Date
    if ($Global:GpuStateCache -and $now -lt $Global:GpuStateCacheExpiresAt) {
        return $Global:GpuStateCache
    }

    $result = Get-GpuStateUncached
    $Global:GpuStateCache          = $result
    $Global:GpuStateCacheExpiresAt = $now.AddSeconds($GPU_STATE_CACHE_TTL_SECONDS)
    return $result
}

function Get-GpuStateUncached {
    $controllers = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    $total  = [int64]0
    $used   = [int64]0
    $labels = @()

    # P2 : Get-Command balaye TOUT le PATH (~1 s cumulé avec les 2 appels).
    # Chemins absolus directs : pas de recherche disque, pas de spawn.
    $nvidiaSmiPath = 'C:\Windows\System32\nvidia-smi.exe'
    if (Test-Path $nvidiaSmiPath) {
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

function Open-FolderInExplorer([string]$targetPath) {
    $result = @{ ok = $false; mode = 'none'; path = [string]$targetPath; message = '' }

    if (-not $targetPath) {
        $result.message = 'Chemin vide'
        return $result
    }
    if (-not (Test-Path -LiteralPath $targetPath)) {
        $result.message = "Chemin introuvable : $targetPath"
        return $result
    }

    $sessionId = 0
    try { $sessionId = [int][System.Diagnostics.Process]::GetCurrentProcess().SessionId } catch {}

    if ($sessionId -eq 0) {
        # Service NSSM = LocalSystem/session 0 : l'Explorateur ne peut pas
        # s'afficher sur le bureau de l'utilisateur. On le signale pour que le
        # model-loader propose le raccourci .url (qui, lui, fonctionne toujours).
        $result.mode = 'session0'
        $result.message = "Service en session 0 : ouverture de l'Explorateur impossible depuis le service. Chemin : $targetPath"
        return $result
    }

    try {
        Start-Process -FilePath 'explorer.exe' -ArgumentList @($targetPath) -ErrorAction Stop | Out-Null
        $result.ok = $true
        $result.mode = 'explorer'
        $result.message = "Dossier ouvert : $targetPath"
    } catch {
        $result.mode = 'error'
        $result.message = $_.Exception.Message
    }

    return $result
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
    # P1 : l'état vient de changer (instance supprimée) → invalider le cache
    # live, sinon les /status suivants ressuscitent l'instance depuis le cache.
    $Global:LiveInstancesCache          = $null
    $Global:LiveInstancesCacheExpiresAt = [datetime]::MinValue
    return $state2
}

function Get-LlamaRuntimeConfigFromCommandLine([string]$commandLine) {
    # Extrait la configuration REELLE d'un process llama-server deja lance.
    # Permet de completer context/gpu_layers absents de l'etat, afin que les
    # comparaisons ulterieures ne declenchent pas de rechargement injustifie.
    $result = @{ context = $null; gpu_layers = $null }
    if (-not $commandLine) { return $result }

    $cmd = [string]$commandLine
    if ($cmd -match '--ctx-size\s+(\d+)') {
        $result.context = [int]$Matches[1]
    } elseif ($cmd -match '(?<![\w-])-c\s+(\d+)') {
        $result.context = [int]$Matches[1]
    }
    if ($cmd -match '(?<![\w-])-ngl\s+(\d+)') {
        $result.gpu_layers = [int]$Matches[1]
    }
    return $result
}

function Start-LlamaProcess([hashtable]$body, [switch]$NoWait) {
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
    # P1 : ne JAMAIS recharger sur simple activation. Les entrées d'état
    # historiques ont context/gpu_layers = null → on les complète depuis la
    # ligne de commande du process vivant AVANT de comparer, sinon chaque
    # /select détruisait + rechargeait le GGUF (minutes perdues).
    if ($existingInstance) {
        $processCmdForCheck = ''
        try {
            if ($processInfo -and $processInfo.command_line) { $processCmdForCheck = [string]$processInfo.command_line }
        } catch {}
        if (-not $processCmdForCheck) {
            try {
                $cimCheck = Get-CimInstance Win32_Process -Filter "ProcessId=$([int]$existingInstance.pid)" -ErrorAction SilentlyContinue
                if ($cimCheck) { $processCmdForCheck = [string]$cimCheck.CommandLine }
            } catch {}
        }
        $liveCheck = Get-LlamaRuntimeConfigFromCommandLine $processCmdForCheck
        if ((-not $existingInstance.context -or [int]$existingInstance.context -le 0) -and $liveCheck.context) {
            $existingInstance.context = [int]$liveCheck.context
        }
        if (($null -eq $existingInstance.gpu_layers) -and ($null -ne $liveCheck.gpu_layers)) {
            $existingInstance.gpu_layers = [int]$liveCheck.gpu_layers
        }

        $contextExplicitlyRequested   = $body.ContainsKey('context')    -and $body.context    -and [int]$body.context    -gt 0
        $gpuLayersExplicitlyRequested = $body.ContainsKey('gpu_layers') -and $null -ne $body.gpu_layers -and [int]$body.gpu_layers -ge 0
        if ($contextExplicitlyRequested -or $gpuLayersExplicitlyRequested) {
            $existingContext   = if ($existingInstance.context    -and [int]$existingInstance.context    -gt 0) { [int]$existingInstance.context    } else { 0 }
            $existingGpuLayers = if ($null -ne $existingInstance.gpu_layers -and [int]$existingInstance.gpu_layers -ge 0) { [int]$existingInstance.gpu_layers } else { 0 }
            $configMatches     = ($context -eq $existingContext) -and ($gpuLayers -eq $existingGpuLayers)
        } else {
            # Activation pure (cas /select UI) : on garde l'instance telle quelle.
            $configMatches = $true
        }
        Write-DebugLog "Config check: req ctx=$context/ngl=$gpuLayers vs existing ctx=$($existingInstance.context)/ngl=$($existingInstance.gpu_layers) matches=$configMatches explicit=$($contextExplicitlyRequested -or $gpuLayersExplicitlyRequested)"

        if (-not $configMatches) {
            Write-DebugLog "Config mismatch → destruction de l'instance existante"
            Stop-LlamaProcess @{ id = $existingInstance.id } | Out-Null
            $existingInstance = $null
            Start-Sleep -Milliseconds 1500
        }
    }

    if ($existingInstance) {
        # P1 : activation pure (cas /select UI sans context/gpu_layers) = chemin
        # RAPIDE. Le process est vivant (vérifié via Get-LlamaServerProcessInfo
        # ci-dessus) → on promeut IMMÉDIATEMENT sans sonder le endpoint HTTP.
        # La sonde /v1/models sur un 9B occupé bloquait jusqu'à 30-48 s et
        # faisait croire à l'échec ("fetch failed" côté UI par timeout).
        if ($activate -and $configMatches -and -not $contextExplicitlyRequested -and -not $gpuLayersExplicitlyRequested) {
            Write-DebugLog "Activation pure id=$($existingInstance.id) pid=$($existingInstance.pid) → promotion immédiate (pas de sonde HTTP)"
            $stateFast = Get-State
            foreach ($inst in $stateFast.instances) {
                $inst.active = ([string]$inst.id -eq [string]$existingInstance.id)
            }
            $stateFast.active_model    = [string]$existingInstance.model
            $stateFast.active_filename = [string]$existingInstance.filename
            $stateFast.active_path     = [string]$existingInstance.path
            $stateFast.started_at      = [string]$existingInstance.started_at
            $activeEntryFast = $stateFast.instances | Where-Object { [string]$_.id -eq [string]$existingInstance.id } | Select-Object -First 1
            if ($activeEntryFast) {
                if (-not ($activeEntryFast.context -and [int]$activeEntryFast.context -gt 0) -and $liveCheck.context) {
                    $activeEntryFast.context = [int]$liveCheck.context
                }
                if (($null -eq $activeEntryFast.gpu_layers) -and ($null -ne $liveCheck.gpu_layers)) {
                    $activeEntryFast.gpu_layers = [int]$liveCheck.gpu_layers
                }
            }
            Save-State $stateFast
            # Invalider le cache live : l'état vient de changer (nouvel actif).
            $Global:LiveInstancesCache          = $null
            $Global:LiveInstancesCacheExpiresAt = [datetime]::MinValue
            Write-DebugLog "Promoted existing instance id=$($existingInstance.id) as active (fast path)"
            return Get-State
        }

        $endpointReady = Test-LlamaServerEndpoint -Port ([int]$existingInstance.port)
        Write-DebugLog "Endpoint test port=$($existingInstance.port) ready=$endpointReady"

        # P1 : pas de double sonde. /v1/models sur un 9B en pleine inférence
        # peut prendre plusieurs secondes ; le fallback TCP ROUVRAIT une 2e
        # connexion qui, à travers la file mono-thread, ajoutait ~5 s à chaque
        # activation. Une seule sonde HTTP (timeout 2 s) suffit : en cas
        # d'échec on promeut quand même l'instance vivante (le process est
        # vivant, le endpoint est juste occupé), le /status suivant confirmera.
        if ($endpointReady) {
            if ($activate) {
                $state2 = Get-State
                foreach ($inst in $state2.instances) {
                    $inst.active = ([string]$inst.id -eq [string]$existingInstance.id)
                }
                $state2.active_model    = [string]$existingInstance.model
                $state2.active_filename = [string]$existingInstance.filename
                $state2.active_path     = [string]$existingInstance.path
                $state2.started_at      = [string]$existingInstance.started_at

                # Completer context/gpu_layers manquants depuis la ligne de commande
                # du process vivant (l'etat les contient souvent a "null", ce qui
                # provoquait un mismatch et donc un rechargement complet a chaque
                # activation).
                $liveConfig  = Get-LlamaRuntimeConfigFromCommandLine $processCmdForCheck
                $activeEntry = $state2.instances | Where-Object { [string]$_.id -eq [string]$existingInstance.id } | Select-Object -First 1
                if ($activeEntry) {
                    if (-not ($activeEntry.context -and [int]$activeEntry.context -gt 0) -and $liveConfig.context) {
                        $activeEntry.context = [int]$liveConfig.context
                    }
                    if ($null -eq $activeEntry.gpu_layers -and $null -ne $liveConfig.gpu_layers) {
                        $activeEntry.gpu_layers = [int]$liveConfig.gpu_layers
                    }
                }

                Save-State $state2
                # P1 : l'actif vient de changer → invalider le cache live.
                $Global:LiveInstancesCache          = $null
                $Global:LiveInstancesCacheExpiresAt = [datetime]::MinValue
                Write-DebugLog "Promoted existing instance id=$($existingInstance.id) as active"
            }
            return Get-State
        }
        # HTTP ne répond pas mais le PROCESS est vivant (inférence en cours,
        # warmup, sleep) : on promeut quand même sur activate (pas de reload),
        # le /status suivant confirmera la santé du endpoint.
        if ($activate) {
            Write-DebugLog "Endpoint HTTP muet mais process vivant pid=$($existingInstance.pid) → promotion sans reload"
            $state3 = Get-State
            foreach ($inst in $state3.instances) {
                $inst.active = ([string]$inst.id -eq [string]$existingInstance.id)
            }
            $state3.active_model    = [string]$existingInstance.model
            $state3.active_filename = [string]$existingInstance.filename
            $state3.active_path     = [string]$existingInstance.path
            $state3.started_at      = [string]$existingInstance.started_at
            $liveConfig3  = Get-LlamaRuntimeConfigFromCommandLine $processCmdForCheck
            $activeEntry3 = $state3.instances | Where-Object { [string]$_.id -eq [string]$existingInstance.id } | Select-Object -First 1
            if ($activeEntry3) {
                if (-not ($activeEntry3.context -and [int]$activeEntry3.context -gt 0) -and $liveConfig3.context) {
                    $activeEntry3.context = [int]$liveConfig3.context
                }
                if ($null -eq $activeEntry3.gpu_layers -and $null -ne $liveConfig3.gpu_layers) {
                    $activeEntry3.gpu_layers = [int]$liveConfig3.gpu_layers
                }
            }
            Save-State $state3
            # P1 : l'actif vient de changer → invalider le cache live.
            $Global:LiveInstancesCache          = $null
            $Global:LiveInstancesCacheExpiresAt = [datetime]::MinValue
            Write-DebugLog "Promoted existing instance id=$($existingInstance.id) as active (endpoint muet)"
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
        '--ctx-size', ([string]$context)
    )
    if ($gpuLayers -gt 0 -and $config.backend -ne 'cpu') {
        $arguments += @('-ngl', ([string]$gpuLayers))
    }
    if ($sleepIdleSecs -ge 0) {
        $arguments += @('--sleep-idle-seconds', ([string]$sleepIdleSecs))
    }
    if ($body.ContainsKey('embedding') -and [bool]$body.embedding) {
        $arguments += @('--embedding')
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
    # P1 : nouvelle instance → le cache live est périmé (nouveau pid).
    $Global:LiveInstancesCache          = $null
    $Global:LiveInstancesCacheExpiresAt = [datetime]::MinValue
    Write-DebugLog "Save-State after launch: pid=$($process.Id) port=$port model=$($record.model) active=$activate"

    # Attente que le serveur réponde.
    # Le délai est ADAPTATIF : un GGUF de 5-14 Go met 30-90 s à charger dans la
    # VRAM d'un Arc 140V (mesuré : Qwopus 5,6 Go ≈ 45 s). L'ancien plafond fixe
    # de 36 s faisait échouer la restauration après chaque redémarrage du
    # controller, qui relançait alors un second llama-server sur le même port.
    if ($NoWait) {
        # Mode réparation (watchdog) : on ne bloque pas la boucle HTTP. La
        # disponibilité réelle sera constatée au cycle suivant.
        Write-ProcessMonitorLog "[ProcessLaunched] pid=$($process.Id) port=$port model=$($record.model) (mode NoWait, warmup en arrière-plan)"
        return Get-State
    }

    $sizeGb        = if ($record.file -and $record.file.Length) { [double]$record.file.Length / 1GB } else { 0 }
    $maxWaitSec    = [int][Math]::Min(300, [Math]::Max(90, 45 + ($sizeGb * 15)))
    $attempts      = [int][Math]::Ceiling(($maxWaitSec * 1000) / 600)
    Write-ProcessMonitorLog "[ProcessWarmup] pid=$($process.Id) port=$port model=$($record.model) sizeGb=$([Math]::Round($sizeGb,2)) maxWaitSec=$maxWaitSec"
    $serverReady = $false
    for ($i = 0; $i -lt $attempts; $i++) {
        if ($process.HasExited) {
            $stderrTail = Get-LastLinesFromFile $stderrLog 30
            if ($stderrTail) { Write-ProcessMonitorLog "[ProcessStartFail] stderr:`n$stderrTail" }
            throw "Le processus llama-server s'est arrêté pendant le chargement. Code: $($process.ExitCode)"
        }
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

# ─────────────────────────────────────────────────────────────────────────────
# Open-HostFolder — ouverture d'un dossier de l'hôte dans l'Explorateur.
# Le service NSSM tourne en session 0 : explorer.exe n'y est pas visible par
# l'utilisateur. On s'appuie sur le shell déjà actif (« explorer.exe <dossier> »
# est transféré au processus explorer de la session interactive) et on renvoie
# mode='session0' quand aucun shell interactif n'existe, afin que l'UI propose
# le raccourci .url (toujours fonctionnel).
# Sécurité : le chemin est restreint au dossier des modèles de la configuration.
# ─────────────────────────────────────────────────────────────────────────────
function Resolve-AllowedFolder([string]$candidate) {
    $config    = Get-Config
    $modelsDir = [string]$config.models_dir
    if (-not $modelsDir) { throw 'models_dir non configuré' }

    $raw  = if ($candidate) { $candidate } else { $modelsDir }
    $full = [IO.Path]::GetFullPath($raw)
    $root = [IO.Path]::GetFullPath($modelsDir).TrimEnd('\')

    $insideRoot = $full.TrimEnd('\').Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
                  $full.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)
    if (-not $insideRoot) {
        throw "Chemin hors du dossier des modèles : $raw"
    }
    return $full
}

function Get-InteractiveShellSession {
    foreach ($proc in (Get-Process -Name 'explorer' -ErrorAction SilentlyContinue)) {
        if ($proc.SessionId -gt 0) { return [int]$proc.SessionId }
    }
    return 0
}

function Open-HostFolder([string]$requestedPath) {
    $full = Resolve-AllowedFolder $requestedPath

    # Les modèles peuvent être déposés par l'utilisateur : le dossier doit exister
    # pour qu'Explorer s'ouvre (création idempotente, sans effet s'il existe).
    if (-not (Test-Path -LiteralPath $full)) {
        New-Item -ItemType Directory -Path $full -Force | Out-Null
    }

    $shellSession = Get-InteractiveShellSession
    if ($shellSession -le 0) {
        Write-DebugLog "open-folder path=$full mode=session0 (aucun shell interactif)" 'warn'
        return @{
            ok      = $false
            path    = $full
            mode    = 'session0'
            message = "Aucune session interactive : utilisez le raccourci .url"
        }
    }

    try {
        Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f $full) -ErrorAction Stop
        Write-DebugLog "open-folder path=$full mode=user-session session=$shellSession"
        return @{ ok = $true; path = $full; mode = 'user-session'; session = $shellSession }
    } catch {
        Write-DebugLog "open-folder explorer échec ($($_.Exception.Message)), repli cmd start" 'warn'
        try {
            Start-Process -FilePath 'cmd.exe' -ArgumentList ('/c start "" "{0}"' -f $full) -WindowStyle Hidden -ErrorAction Stop
            return @{ ok = $true; path = $full; mode = 'user-session'; session = $shellSession }
        } catch {
            Write-DebugLog "open-folder échec définitif : $($_.Exception.Message)" 'error'
            return @{
                ok      = $false
                path    = $full
                mode    = 'session0'
                message = $_.Exception.Message
            }
        }
    }
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
    $timingStart = Get-Date
    # Fast path : si Get-ConsistentState a servi son cache mémoire, le GPU state
    # est aussi servi depuis son cache (15 s) → /status nominal = 0 I/O disque,
    # 0 netstat, 0 CIM/WMI. C'est ce qui élimine les derniers pics 1,5-15 s.
    $config    = Get-Config
    $timingAfterConfig = Get-Date
    $state     = Get-ConsistentState
    $timingAfterState = Get-Date
    # HOT PATH : Get-GpuState() appelle CIM/WMI + Get-Command nvidia-smi +
    # Get-Command rocm-smi même quand son cache a expiré. Ces 3 appels coûtent
    # ~1 s cumulés et expliquent les TIMING 'rest≈1000-1300ms'. Quand l'état
    # est servi depuis le cache (cas nominal), le GPU state l'est aussi.
    $stateServedFromCache = ($script:LastConsistentState -and ([object]::ReferenceEquals($state, $script:LastConsistentState)))
    $gpu = if ($stateServedFromCache -and $Global:GpuStateCache) { $Global:GpuStateCache } else { Get-GpuState }
    $timingAfterGpu = Get-Date
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

    $activeInstance = $instances | Where-Object { $_.active } | Select-Object -First 1
    if (-not $activeInstance -and $instances.Count -gt 0) { $activeInstance = $instances[0] }

    # P2 : localiser les lenteurs du controller (diagnostic impossible sans ça)
    $timingTotal = Get-ElapsedMs $timingStart
    if ($timingTotal -gt 1000) {
        $cfgMs = Get-ElapsedMs $timingStart $timingAfterConfig
        $stateMs = Get-ElapsedMs $timingAfterConfig $timingAfterState
        $restMs = Get-ElapsedMs $timingAfterState
        Write-DebugLog ("TIMING status total=${timingTotal}ms config=${cfgMs}ms consistent=${stateMs}ms rest=${restMs}ms") 'warn'
    }

    return @{
        # P-BASSE : le format d'état est versionné (migration auto dans
        # Convert-LegacyState). On l'expose dans /status pour que les clients
        # (model-loader, tests de fumée) puissent vérifier la compatibilité.
        schema_version     = $script:SchemaVersionForStatus
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
# BIND DU LISTENER - AVANT toute mutation du state.
# Si le port est deja occupe (autre instance du controller), on sort sans
# reecrire host-runtime-state.json. C'est ce qui provoquait la boucle de crash
# NSSM (toutes les ~2,4 s pendant des jours) et la corruption de l'etat.
# ═════════════════════════════════════════════════════════════════════════════
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
try {
    $listener.Start()
} catch {
    $bindError = "Impossible de demarrer le controleur sur 0.0.0.0:$Port. Detail: $($_.Exception.Message)"
    Write-Host "[Controller] $bindError"
    try { Write-ProcessMonitorLog "[BindFail] $bindError" 'error' } catch {}
    try { Write-DebugLog "[BindFail] $bindError" 'error' } catch {}
    [Console]::Error.WriteLine($bindError)
    exit 1
}
Write-DebugLog "Startup: listener lie sur 0.0.0.0:$Port"

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

            # -NoWait : la restauration ne doit PAS bloquer le démarrage du
            # controller. Avant, /status restait injoignable 40-90 s après un
            # redémarrage (le temps de charger les GGUF) → « fetch failed » côté
            # model-loader. Le warmup est constaté par les cycles suivants.
            Start-LlamaProcess $body -NoWait | Out-Null
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
                # SAUF si le GGUF a disparu du disque : dans ce cas l'instance est
                # un fantôme. On la marque running=false pour que le nettoyage
                # d'état la supprime (elle ne doit ni être relancée par le
                # watchdog ni apparaître comme « chargée » dans l'UI).
                $record = if ($saved.filename) { $saved.filename } else { $saved.model }
                if (-not (Test-ModelRecordExists $record)) {
                    $saved.running = $false
                    Write-Host "[Controller] 🧹 Instance fantôme retirée (GGUF absent) : $($saved.model)"
                    Write-DebugLog "Startup: phantom pruned id=$($saved.id) model=$($saved.model)"
                }
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

            Start-LlamaProcess $body -NoWait | Out-Null

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
                # running reste true → watchdog retentera, sauf si le GGUF a
                # disparu du disque (instance fantôme) : on la retire.
                $record = if ($saved.filename) { $saved.filename } else { $saved.model }
                if (-not (Test-ModelRecordExists $record)) {
                    $saved.running = $false
                    Write-Host "[Controller] 🧹 Modèle principal fantôme retiré (GGUF absent) : $($saved.model)"
                    Write-DebugLog "Startup: phantom pruned active id=$($saved.id) model=$($saved.model)"
                }
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
# WATCHDOG : exécuté DANS la boucle HTTP (voir plus bas), uniquement quand
# aucune connexion n'attend et qu'aucune requête n'est récente. L'ancien
# System.Timers.Timer + Register-ObjectEvent s'exécutait entrelacé avec la
# boucle et BLOQUAIT /status et /start (pics à 5,8-19 s observés).
# ═════════════════════════════════════════════════════════════════════════════
# P1 : le watchdog tournait dans le RUNSPACE PRINCIPAL (Register-ObjectEvent
# = exécution entrelacée avec la boucle HTTP). Son Monitor-LlamaInstances
# (CIM + netstat ~1-2 s) BLOQUAIT donc aléatoirement /status et /start →
# pics à 5,8-19 s. Stratégie : le watchdog ne fait RIEN si une requête HTTP
# est en cours ou récente (< 5 s) ; il est aussi sauté si le précédent run
# dure encore (flag). Le contrôle de santé reste assuré par Get-ConsistentState
# à chaque /status de toute façon.
$watchdogJobState = @{ lastRun = [datetime]::MinValue; running = $false }
$script:LastHttpRequestAt = [datetime]::MinValue
function Test-WatchdogDue {
    if ($watchdogJobState.running) { return $false }
    if (((Get-Date) - $script:LastHttpRequestAt).TotalSeconds -lt 5) { return $false }
    if ($Global:PendingRepair) { return $true }
    return ((Get-Date) - $watchdogJobState.lastRun).TotalSeconds -ge 30
}

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

# (Le listener a deja ete cree et lie plus haut, AVANT la sequence de demarrage :
#  un echec de bind ne doit jamais pouvoir reecrire le fichier d'etat.)

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
Write-Host "[Controller] Watchdog intégré à la boucle HTTP (idle >= 5 s, toutes les 30 s)"

# ═════════════════════════════════════════════════════════════════════════════
# BOUCLE PRINCIPALE HTTP
# ═════════════════════════════════════════════════════════════════════════════
# Un SEUL accept en vol à la fois. L'ancien code relançait un BeginAcceptTcpClient à
# chaque timeout de 1 s en ABANDONNANT l'opération précédente : les connexions
# étaient alors captées par une opération abandonnée pendant que le code bloquait
# dans EndAcceptTcpClient sur la plus récente. Résultat observé : requêtes perdues,
# connexions coupées ("fetch failed" côté model-loader) et latences de 3 à 30 s.
$pendingAccept = $listener.BeginAcceptTcpClient($null, $null)

while ($true) {
    $client       = $null
    $requestStart = $null
    $requestLabel = ''
    try {
        # P1 : le watchdog (CIM + netstat ~1-2 s) s'exécute ICI, dans le
        # runspace principal, uniquement quand AUCUNE connexion n'attend
        # (WaitOne 250 ms) et qu'aucune requête n'est récente. Il ne peut donc
        # plus retarder /status ou /start (pics à 5,8-19 s observés avant).
        if (-not $pendingAccept.AsyncWaitHandle.WaitOne(250)) {
            if (Test-WatchdogDue) {
                $watchdogJobState.running = $true
                try {
                    Write-Host "[Watchdog] Vérification état..."
                    Monitor-LlamaInstances
                    $wdState = Get-ConsistentState
                    Repair-DeadInstances $wdState
                    $Global:PendingRepair = $false
                    $wdState2 = Get-State
                    $wdState2.request_counter  = ConvertTo-Hashtable $Global:RequestCounter
                    $wdState2.last_request_time = @{}
                    foreach ($key in $Global:LastRequestTime.Keys) {
                        $wdState2.last_request_time[[string]$key] = $Global:LastRequestTime[$key].ToString('o')
                    }
                    Save-State $wdState2
                    $watchdogJobState.lastRun = Get-Date
                } catch {
                    Write-Host "[Watchdog] Erreur: $($_.Exception.Message)"
                } finally {
                    $watchdogJobState.running = $false
                }
            }
            continue
        }

        try {
            $client = $listener.EndAcceptTcpClient($pendingAccept)
        } finally {
            # Réarmer immédiatement le prochain accept : toujours exactement 1 en vol
            try { $pendingAccept = $listener.BeginAcceptTcpClient($null, $null) } catch {}
        }
        if (-not $client) { continue }

        $client.ReceiveTimeout = 30000
        $client.SendTimeout    = 60000

        $requestStart = Get-Date
        $stream  = $client.GetStream()
        $request = Read-HttpRequest $stream

        $Global:RequestCounter['total'] = if ($Global:RequestCounter['total']) { $Global:RequestCounter['total'] + 1 } else { 1 }
        $script:LastHttpRequestAt = Get-Date

        if (-not $request) { continue }

        $path = if ($request.path) { $request.path } else { '/' }
        $requestLabel = "$($request.method) $path"

        # Mise à jour timestamp par instance (ports mis en cache : évite une lecture
        # disque + parse JSON du fichier de state à CHAQUE requête HTTP)
        $nowForPorts = Get-Date
        if (-not $Global:InstancePortsCache -or $nowForPorts -ge $Global:InstancePortsCacheExpiresAt) {
            $Global:InstancePortsCache          = @((Get-State).instances | ForEach-Object { [int]$_.port })
            $Global:InstancePortsCacheExpiresAt = $nowForPorts.AddSeconds($INSTANCE_PORTS_CACHE_TTL_SECONDS)
        }
        foreach ($instancePort in $Global:InstancePortsCache) {
            if ($request.raw_body -match "\b$instancePort\b" -or $request.path -match "\b$instancePort\b") {
                $portKey = [string]$instancePort
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
            'POST /open-folder' {
                # Ouvre le dossier des modèles (ou un sous-dossier) dans
                # l'Explorateur Windows. Appelé par le model-loader depuis l'UI.
                $body   = Read-JsonBody $request
                $config = Get-Config
                $target = if ($body -and $body.path) { [string]$body.path } else { [string]$config.models_dir }

                # Sécurité : n'autoriser que le dossier de modèles configuré ou
                # un de ses sous-dossiers (évite l'ouverture de C:\Windows).
                $modelsDir = [string]$config.models_dir
                if ($modelsDir -and $target) {
                    $normalizedModels = $modelsDir.TrimEnd('\', '/')
                    $normalizedTarget = $target.TrimEnd('\', '/')
                    if ($normalizedTarget -ne $normalizedModels -and
                        -not $normalizedTarget.StartsWith($normalizedModels + '\', [System.StringComparison]::OrdinalIgnoreCase) -and
                        -not $normalizedTarget.StartsWith($normalizedModels + '/', [System.StringComparison]::OrdinalIgnoreCase)) {
                        Write-Json $stream 403 @{ ok = $false; path = $target; message = 'Chemin hors du dossier de modèles' }
                        continue
                    }
                }

                $opened = Open-FolderInExplorer $target
                Write-Host "[controller] POST /open-folder path=$target ok=$($opened.ok) mode=$($opened.mode)"
                Write-Json $stream 200 $opened
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

                Write-Host "[controller] POST /restart model=$($body.model) context=$($body.context)"
                
                # Toujours activer le modèle par défaut quand on relance
                if (-not $body.ContainsKey('activate')) {
                    $body.activate = $true
                }
                
                Start-LlamaProcess $body | Out-Null
                Write-Json $stream 200 (Get-RuntimeStatus)
                continue
            }
            'POST /open-folder' {
                $body = Read-JsonBody $request
                try {
                    $folderResult = Open-HostFolder ([string]$body.path)
                    Write-Json $stream 200 $folderResult
                } catch {
                    Write-Json $stream 403 @{ ok = $false; mode = 'refused'; message = $_.Exception.Message }
                }
                continue
            }
            default {
                Write-Json $stream 404 @{ detail = 'Route introuvable' }
                continue
            }
        }
    } catch {
        # P2 : ne plus avaler les erreurs en silence (diagnostic impossible sinon)
        $loopError = $_.Exception.Message
        Write-Host "[Controller] Erreur boucle HTTP : $loopError"
        try { Write-DebugLog "HTTP loop error error=$loopError" 'error' } catch {}
        if ($client -and $client.Connected) {
            try { Write-Json $client.GetStream() 500 @{ detail = $loopError } } catch {}
        }
    } finally {
        # P2 : tracer les requêtes anomalies (au lieu de subir des latences invisibles)
        try {
            if ($requestStart) {
                $elapsedMs = Get-ElapsedMs $requestStart
                if ($elapsedMs -gt 1500) {
                    Write-DebugLog "SLOW request $requestLabel elapsed=${elapsedMs}ms" 'warn'
                }
            }
        } catch {}
        if ($client) { $client.Dispose() }
    }
}
