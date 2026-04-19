param(
    [int]$Port = 13579,
    [string]$ConfigPath = "",
    [string]$StatePath = ""
)

$ErrorActionPreference = "Stop"
$Global:RequestCounter = @{}
$Global:LastRequestTime = @{}

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

# Gestionnaire d'arrêt gracieux pour Windows Service
Register-EngineEvent PowerShell.Exiting -Action {
    Write-Host "`n[Controller] Arrêt gracieux en cours..."
    $state = Get-State
    foreach ($instance in $state.instances) {
        if ($instance.pid -and $instance.running) {
            try {
                $process = Get-Process -Id $instance.pid -ErrorAction SilentlyContinue
                if ($process -and -not $process.HasExited) {
                    Write-Host "[Controller] Arrêt llama-server PID $($instance.pid)"
                    Stop-Process -Id $instance.pid -ErrorAction SilentlyContinue
                    Start-Sleep -Milliseconds 1500
                    if (-not $process.HasExited) {
                        Stop-Process -Id $instance.pid -Force -ErrorAction SilentlyContinue
                    }
                }
            } catch {}
        }
    }
    Write-Host "[Controller] Arrêt terminé."
} | Out-Null

if (-not $ConfigPath) {
    $ConfigPath = Join-Path (Get-RepoRoot) "runtime\host-runtime-config.json"
}

if (-not $StatePath) {
    $StatePath = Join-Path (Get-RepoRoot) "runtime\host-runtime-state.json"
}

Initialize-LogsDirectories

function ConvertTo-Hashtable($value) {
    if ($null -eq $value) {
        return $null
    }

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
    # Détection automatique du meilleur backend disponible avec fallback
    # 1. NVIDIA CUDA en premier
    $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($nvidiaSmi) {
        try {
            $result = & nvidia-smi -L 2>$null
            if ($result -and $result -match 'GPU') {
                return @{ backend = "cuda"; label = "CUDA NVIDIA" }
            }
        } catch {}
    }

    # 2. AMD ROCm
    $rocmInfo = Get-Command rocm-smi -ErrorAction SilentlyContinue
    if ($rocmInfo) {
        try {
            $result = & rocm-smi --showid 2>$null
            if ($result -and $result -match 'GPU') {
                return @{ backend = "rocm"; label = "ROCm AMD" }
            }
        } catch {}
    }

    # 3. Intel Arc / Vulkan générique
    $vulkanInfo = Get-Command vulkaninfo -ErrorAction SilentlyContinue
    if ($vulkanInfo) {
        return @{ backend = "vulkan"; label = "Vulkan" }
    }

    # Fallback final CPU
    return @{ backend = "cpu"; label = "CPU" }
}

function Get-Config {
    if (-not (Test-Path $ConfigPath)) {
        $autoBackend = Get-BestAvailableBackend
        $config = @{
            controller_port = $Port
            server_port = 12434
            server_port_start = 12434
            server_port_end = 12444
            max_instances = 6
            backend = $autoBackend.backend
            backend_label = $autoBackend.label
            binary_path = ""
            models_dir = ""
            proxy_model_id = "lia-local"
            default_context = 8192
            default_gpu_layers = 999
        }
        Save-Config $config
        return $config
    }

    $config = ConvertTo-Hashtable (Get-Content $ConfigPath -Raw | ConvertFrom-Json)
    $changed = $false

    if (-not $config.server_port_start -or [int]$config.server_port_start -eq 0) {
        $config.server_port_start = 12434
        $changed = $true
    }

    if (-not $config.server_port_end -or [int]$config.server_port_end -lt [int]$config.server_port_start) {
        $config.server_port_end = 12444
        $changed = $true
    }

    if (-not $config.server_port -or [int]$config.server_port -eq 0) {
        $config.server_port = 12434
        $changed = $true
    }

    if (-not $config.default_context -or [int]$config.default_context -eq 0) {
        $config.default_context = 8192
        $changed = $true
    }

    if (-not $config.default_gpu_layers -or [int]$config.default_gpu_layers -eq 0) {
        $config.default_gpu_layers = 999
        $changed = $true
    }

    if ($changed) {
        Save-Config $config
    }

    return $config
}

function Get-State {
    if (-not (Test-Path $StatePath)) {
        return @{
            instances = @()
        }
    }

    try {
        $stream = [System.IO.File]::Open($StatePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::UTF8)
            $content = $reader.ReadToEnd()
            $parsed = $content | ConvertFrom-Json
            if ($parsed -is [System.Array]) {
                if ($parsed.Count -eq 0) {
                    return @{ instances = @() }
                }

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

        $data = $serializableState | ConvertTo-Json -Depth 6
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
        throw
    }
}

function Convert-LegacyState([hashtable]$state) {
    if (-not $state.instances) {
        if ($state.pid) {
            return @{
                instances = @(
                    @{
                        id = [string](if ($state.server_port) { $state.server_port } else { 12434 })
                        port = [int](if ($state.server_port) { $state.server_port } else { 12434 })
                        pid = $state.pid
                        running = [bool]$state.running
                        model = [string]$state.active_model
                        filename = [string]$state.active_filename
                        path = [string]$state.active_path
                        started_at = [string]$state.started_at
                        last_error = [string]$state.last_error
                        stdout_log = [string]$state.stdout_log
                        stderr_log = [string]$state.stderr_log
                        estimated_vram_bytes = $null
                        server_base_url = "http://127.0.0.1:$((if ($state.server_port) { $state.server_port } else { 12434 }))/v1"
                    }
                )
            }
        }

        return @{ instances = @() }
    }

    return $state
}

function Get-ConsistentState {
    $state = Get-State
    $state = Convert-LegacyState $state
    $changed = $false
    $graceWindowSeconds = 30

    $liveInstances = Get-LiveInstances (Get-Config)
    if ($liveInstances.Count -gt 0) {
        $state.instances = @($liveInstances)

        $activeInstance = $state.instances | Where-Object { $_.active } | Select-Object -First 1
        if (-not $activeInstance) {
            $activeInstance = $state.instances | Where-Object { $_.running } | Select-Object -First 1
        }
        foreach ($instance in $state.instances) {
            Set-ObjectProperty $instance 'active' ([bool]($activeInstance -and $instance.id -eq $activeInstance.id)) | Out-Null
        }

        Save-State $state
        return Get-State
    }

    # Garantir que instances est toujours un tableau, jamais un objet/hashtable
    if ($state.instances -is [System.Collections.IDictionary]) {
        $state.instances = @($state.instances)
        $changed = $true
    } elseif ($state.instances -isnot [System.Array]) {
        $state.instances = @()
        $changed = $true
    }

    $newInstances = @()
    foreach ($instance in $state.instances) {
        if ($instance -isnot [hashtable] -and $instance -isnot [System.Collections.IDictionary]) {
            $changed = $true
            continue
        }

        if ($instance.pid) {
            $process = Get-Process -Id ([int]$instance.pid) -ErrorAction SilentlyContinue
            if (-not $process -or $process.HasExited) {
                $startedAt = [datetime]::MinValue
                $startedOk = [datetime]::TryParse([string]$instance.started_at, [ref]$startedAt)
                $isWithinGracePeriod = $startedOk -and ((Get-Date) - $startedAt).TotalSeconds -lt $graceWindowSeconds

                if ($isWithinGracePeriod) {
                    $newInstances += $instance
                    continue
                }

                $instance.running = $false
                $instance.pid = $null
                $instance.started_at = ""
                $changed = $true
            }
        }

        $newInstances += $instance
    }
    $state.instances = $newInstances

    $activeInstance = $state.instances | Where-Object { $_.active } | Select-Object -First 1
    if (-not $activeInstance -and $state.active_model) {
        $activeInstance = $state.instances | Where-Object { $_.model -ieq $state.active_model } | Select-Object -First 1
    }
    if (-not $activeInstance) {
        $activeInstance = $state.instances | Where-Object { $_.running } | Select-Object -First 1
    }
    foreach ($instance in $state.instances) {
        $shouldBeActive = $activeInstance -and ($instance.id -eq $activeInstance.id)
        $activeValue = Get-ObjectProperty $instance 'active'
        if ($activeValue -ne $shouldBeActive) {
            Set-ObjectProperty $instance 'active' ([bool]$shouldBeActive) | Out-Null
            $changed = $true
        }
    }

    # Auto nettoyage des logs: supprimer les logs plus vieux que 7 jours
    $runtimeDir = Get-RuntimeLogDir
    Get-ChildItem -Path $runtimeDir -Filter *.log -File -ErrorAction SilentlyContinue | Where-Object {
        $_.LastWriteTime -lt (Get-Date).AddDays(-7)
    } | Remove-Item -Force -ErrorAction SilentlyContinue

    if ($changed) {
        Save-State $state
    }

    return Get-State
}

function Resolve-ModelRecord([string]$identifier) {
    $config = Get-Config
    $modelsDir = [string]$config.models_dir
    if (-not $modelsDir -or -not (Test-Path $modelsDir)) {
        throw "Répertoire des modèles introuvable : $modelsDir"
    }

    $files = Get-ChildItem -Path $modelsDir -Filter *.gguf -File -ErrorAction SilentlyContinue
    if (-not $files) {
        throw "Aucun modèle GGUF trouvé dans $modelsDir"
    }

    $needle = [string]$identifier
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
    $start = [int]$config.server_port_start
    $end = [int]$config.server_port_end
    $occupied = @{}
    foreach ($instance in $state.instances) {
        if ($instance.port) { $occupied[[int]$instance.port] = $true }
    }

    for ($port = $start; $port -le $end; $port++) {
        if (-not $occupied.ContainsKey($port)) {
            return $port
        }
    }

    return $null
}

function Get-LiveInstances([hashtable]$config) {
    $instances = @()
    $start = [int]$config.server_port_start
    $end = [int]$config.server_port_end
    $listeners = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
        Where-Object { $_.LocalPort -ge $start -and $_.LocalPort -le $end }

    foreach ($listener in $listeners) {
        $port = [int]$listener.LocalPort
        $processId = [int]$listener.OwningProcess
        $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
        if (-not $process -or $process.HasExited) {
            continue
        }

        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$port/v1/models" -Method Get -TimeoutSec 2 -ErrorAction Stop
        } catch {
            continue
        }

        $modelId = $null
        if ($response.data -and $response.data.Count -gt 0) {
            $modelId = [string]$response.data[0].id
        } elseif ($response.models -and $response.models.Count -gt 0) {
            $modelId = [string]$response.models[0].model
        }

        if (-not $modelId) {
            continue
        }

        $instances += @{
            id = [string]$port
            port = $port
            pid = $processId
            running = $true
            model = [IO.Path]::GetFileNameWithoutExtension($modelId)
            filename = $modelId
            path = ""
            started_at = $process.StartTime.ToString('o')
            last_error = ""
            stdout_log = ""
            stderr_log = ""
            estimated_vram_bytes = $null
            server_base_url = "http://127.0.0.1:$port/v1"
            proxy_id = "$($config.proxy_model_id)-$port"
        }
    }

    return $instances
}

function Resolve-InstanceRecord([string]$identifier) {
    $state = Get-ConsistentState
    if (-not $state.instances) { return $null }

    $needle = [string]$identifier
    if (-not $needle) { return $null }

    $lower = $needle.ToLower()
    foreach ($instance in $state.instances) {
        if ([string]$instance.model -and [string]$instance.model.ToLower() -eq $lower) {
            return $instance
        }
        if ([string]$instance.filename -and [string]$instance.filename.ToLower() -eq $lower) {
            return $instance
        }
        if ([string]$instance.id -and [string]$instance.id.ToLower() -eq $lower) {
            return $instance
        }
        if ([string]$instance.port -and [string]$instance.port -eq $needle) {
            return $instance
        }
        if ([string]$instance.proxy_id -and [string]$instance.proxy_id.ToLower() -eq $lower) {
            return $instance
        }
    }

    return $null
}

function Get-GpuState {
    $controllers = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    $total = [int64]0
    $used = [int64]0
    $labels = @()

    # Tentative détection précise NVIDIA
    $nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
    if ($nvidiaSmi) {
        try {
            $gpuData = & nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits 2>$null
            if ($gpuData) {
                foreach ($line in $gpuData) {
                    $parts = $line.Split(',').Trim()
                    $labels += $parts[0]
                    $total += [int64]$parts[1] * 1024 * 1024
                    $used += [int64]$parts[2] * 1024 * 1024
                }
                return @{
                    total_bytes = $total
                    used_bytes = $used
                    available_bytes = $total - $used
                    label = if ($labels) { ($labels -join ' | ') } else { 'NVIDIA GPU' }
                    vendor = "nvidia"
                }
            }
        } catch {}
    }

    # Tentative détection AMD
    $rocmSmi = Get-Command rocm-smi -ErrorAction SilentlyContinue
    if ($rocmSmi) {
        try {
            $amdData = & rocm-smi --showproductname --showmeminfo vram --json 2>$null | ConvertFrom-Json
            if ($amdData) {
                foreach ($gpu in $amdData.PSObject.Properties) {
                    $labels += $gpu.Value.ProductName
                    $total += [int64]$gpu.Value.VRAM.Total
                    $used += [int64]$gpu.Value.VRAM.Used
                }
                return @{
                    total_bytes = $total
                    used_bytes = $used
                    available_bytes = $total - $used
                    label = if ($labels) { ($labels -join ' | ') } else { 'AMD GPU' }
                    vendor = "amd"
                }
            }
        } catch {}
    }

    # Fallback WMI pour Intel et autres
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

        if ($controller.Name) {
            $labels += [string]$controller.Name
        }
    }

    return @{
        total_bytes = $total
        used_bytes = $null
        available_bytes = $null
        label = if ($labels) { ($labels -join ' | ') } else { 'GPU inconnu' }
        vendor = "generic"
    }
}

function Stop-LlamaProcess([hashtable]$body) {
    $state = Get-ConsistentState
    $target = $null

    if ($body -and $body.model) {
        $target = Resolve-InstanceRecord([string]$body.model)
    } elseif ($body -and $body.id) {
        $target = Resolve-InstanceRecord([string]$body.id)
    } elseif ($body -and $body.proxy_id) {
        $target = Resolve-InstanceRecord([string]$body.proxy_id)
    } elseif ($body -and $body.port) {
        $target = Resolve-InstanceRecord([string]$body.port)
    } elseif ($state.instances.Count -eq 1) {
        $target = $state.instances[0]
    }

    if (-not $target) {
        return $state
    }

    if ($target.pid) {
        try {
            # Arrêt gracieux d'abord
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

    $target.pid = $null
    $target.running = $false
    $target.started_at = ""

    $state.instances = @($state.instances | Where-Object {
        ($_.id -ne $target.id) -and ($_.port -ne $target.port) -and ($_.model -ne $target.model)
    })

    if ($state.active_model -and $state.active_model -ieq $target.model) {
        $remainingActive = $state.instances | Where-Object { $_.running } | Select-Object -First 1
        if ($remainingActive) {
            $state.active_model = [string]$remainingActive.model
            $state.active_filename = [string]$remainingActive.filename
            $state.active_path = [string]$remainingActive.path
            $state.started_at = [string]$remainingActive.started_at
            $state.instances = $state.instances | ForEach-Object { $_.active = ($_.id -eq $remainingActive.id); $_ }
        } else {
            $state.active_model = ''
            $state.active_filename = ''
            $state.active_path = ''
            $state.started_at = ''
        }
    }

    Save-State $state
    return $state
}

function Start-LlamaProcess([hashtable]$body) {
    $config = Get-Config
    if (-not $config.binary_path -or -not (Test-Path $config.binary_path)) {
        throw "Binaire llama-server introuvable : $($config.binary_path)"
    }

    $record = Resolve-ModelRecord([string]$body.model)
    $context = if ($body.context) { [int]$body.context } else { [int]$config.default_context }
    $gpuLayers = if ($body.gpu_layers) { [int]$body.gpu_layers } else { [int]$config.default_gpu_layers }
    $state = Get-ConsistentState

    $debugLog = Join-Path (Get-ControllerLogDir) 'controller-debug.log'
    if (-not (Test-Path (Split-Path -Parent $debugLog))) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $debugLog) -Force | Out-Null
    }
    Add-Content -Path $debugLog -Value "[$(Get-Date -Format 'o')] Start-LlamaProcess called for model=$($body.model) resolved=$($record.model)"
    $existingInstance = $state.instances | Where-Object { $_.model -ieq $record.model -and $_.running } | Select-Object -First 1
    if ($existingInstance) {
        Add-Content -Path $debugLog -Value "[$(Get-Date -Format 'o')] Found existingInstance id=$($existingInstance.id) model=$($existingInstance.model) port=$($existingInstance.port) active=$($existingInstance.active)"
    }
    $activate = $true
    if ($body.ContainsKey('activate') -and $body.activate -eq $false) {
        $activate = $false
    }

    if ($existingInstance -and (Test-TcpEndpoint -HostName '127.0.0.1' -Port ([int]$existingInstance.port) -TimeoutMs 1000)) {
        if ($activate) {
            Write-Host "[controller] Activating existing model instance: $($record.model) on port $($existingInstance.port)"
            Add-Content -Path $debugLog -Value "[$(Get-Date -Format 'o')] Promoting existing instance id=$($existingInstance.id)"
            for ($i = 0; $i -lt $state.instances.Count; $i++) {
                $instance = $state.instances[$i]
                if ($null -ne $instance) {
                    $state.instances[$i]['active'] = ([string]$instance.id -eq [string]$existingInstance.id)
                }
            }
            $state.active_model = [string]$existingInstance.model
            $state.active_filename = [string]$existingInstance.filename
            $state.active_path = [string]$existingInstance.path
            $state.started_at = [string]$existingInstance.started_at
            Save-State $state
            Add-Content -Path $debugLog -Value "[$(Get-Date -Format 'o')] Save-State called for active_model=$($state.active_model)"
            foreach ($instance in $state.instances) {
                Add-Content -Path $debugLog -Value "[$(Get-Date -Format 'o')] instance $($instance.id) active=$($instance.active) model=$($instance.model)"
            }
            return $state
        }

        return $state
    }

    $port = Get-NextAvailablePort $config $state
    if (-not $port) {
        throw "Aucune plage de ports disponible pour démarrer un nouveau modèle."
    }

    $runtimeDir = Get-RuntimeLogDir
    if (-not (Test-Path $runtimeDir)) {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    }

    $stdoutLog = Join-Path $runtimeDir "llama-server.$port.stdout.log"
    $stderrLog = Join-Path $runtimeDir "llama-server.$port.stderr.log"

    # Initialiser compteurs pour cette instance
    $portKey = [string]$port
    $Global:RequestCounter[$portKey] = 0
    $Global:LastRequestTime[$portKey] = Get-Date

    $arguments = @(
        '--host', '0.0.0.0',
        '--port', ([string]$port),
        '-m', $record.file.FullName,
        '-c', ([string]$context),
        '--cache-ram', '512'
    )

    if ($gpuLayers -gt 0 -and $config.backend -ne 'cpu') {
        $arguments += @('-ngl', ([string]$gpuLayers))
    }

    $process = Start-Process -FilePath $config.binary_path -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

    # Watchdog: Vérifier que le processus ne crash pas immédiatement
    Start-Sleep -Milliseconds 2000
    if ($process.HasExited) {
        throw "Le processus llama-server s'est arrêté immédiatement. Code de sortie: $($process.ExitCode)"
    }

    $instance = @{
        id = [string]$port
        port = [int]$port
        pid = $process.Id
        running = $true
        model = $record.model
        filename = $record.file.Name
        path = $record.file.FullName
        started_at = (Get-Date).ToString('o')
        last_error = ""
        stdout_log = $stdoutLog
        stderr_log = $stderrLog
        estimated_vram_bytes = if ($body.estimated_vram_bytes) { [int64]$body.estimated_vram_bytes } else { $null }
        server_base_url = "http://127.0.0.1:$port/v1"
        proxy_id = "$($config.proxy_model_id)-$port"
        active = $activate
    }

    if ($activate) {
        $state.instances = @($instance) + ($state.instances | ForEach-Object { Set-ObjectProperty $_ 'active' $false; $_ } | Where-Object { $_.id -ne $instance.id })
        $state.active_model = [string]$instance.model
        $state.active_filename = [string]$instance.filename
        $state.active_path = [string]$instance.path
        $state.started_at = [string]$instance.started_at
    } else {
        $state.instances = @($instance) + $state.instances
    }
    Save-State $state

    for ($i = 0; $i -lt 15; $i++) {
        if (Test-TcpEndpoint -Host '127.0.0.1' -Port ([int]$port) -TimeoutMs 1000) {
            break
        }
        Start-Sleep -Milliseconds 700
    }

    if ($i -ge 15) {
        try { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } catch {}
        throw "Timeout attente llama-server sur le port $port"
    }

    return Get-ConsistentState
}

function Test-TcpEndpoint([string]$HostName, [int]$Port, [int]$TimeoutMs = 1000) {
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return $false
        }

        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Get-RuntimeStatus {
    $config = Get-Config
    $state = Get-ConsistentState
    $instances = @()
    $requestCounter = ConvertTo-Hashtable $Global:RequestCounter

    foreach ($instance in $state.instances) {
        $portKey = [string]$instance.port
        $instances += @{
            id = [string]$instance.id
            port = [int]$instance.port
            pid = $instance.pid
            request_count = if ($requestCounter[$portKey]) { $requestCounter[$portKey] } else { 0 }
            last_request_at = if ($Global:LastRequestTime[$portKey]) { $Global:LastRequestTime[$portKey].ToString('o') } else { $null }
            running = [bool]$instance.running
            model = [string]$instance.model
            filename = [string]$instance.filename
            path = [string]$instance.path
            started_at = [string]$instance.started_at
            last_error = [string]$instance.last_error
            stdout_log = [string]$instance.stdout_log
            stderr_log = [string]$instance.stderr_log
            active = [bool]$instance.active
            estimated_vram_bytes = if ($instance.estimated_vram_bytes) { [int64]$instance.estimated_vram_bytes } else { $null }
            server_base_url = [string]$instance.server_base_url
            proxy_id = [string]$instance.proxy_id
        }
    }

    $gpu = Get-GpuState
    $activeInstance = $instances | Where-Object { $_.active } | Select-Object -First 1
    if (-not $activeInstance -and $instances.Count -gt 0) {
        $activeInstance = $instances[0]
    }

    return @{
        running = [bool]($instances.Count -gt 0)
        pid = if ($activeInstance) { $activeInstance.pid } else { $null }
        active_model = if ($activeInstance) { [string]$activeInstance.model } else { '' }
        active_filename = if ($activeInstance) { [string]$activeInstance.filename } else { '' }
        active_path = if ($activeInstance) { [string]$activeInstance.path } else { '' }
        started_at = if ($activeInstance) { [string]$activeInstance.started_at } else { '' }
        last_error = if ($activeInstance) { [string]$activeInstance.last_error } else { '' }
        stdout_log = if ($activeInstance) { [string]$activeInstance.stdout_log } else { '' }
        stderr_log = if ($activeInstance) { [string]$activeInstance.stderr_log } else { '' }
        backend = [string]$config.backend
        backend_label = [string]$config.backend_label
        binary_path = [string]$config.binary_path
        models_dir = [string]$config.models_dir
        server_port = [int]$config.server_port
        server_port_start = [int]$config.server_port_start
        server_port_end = [int]$config.server_port_end
        proxy_model_id = [string]$config.proxy_model_id
        default_context = [int]$config.default_context
        default_gpu_layers = [int]$config.default_gpu_layers
        instances = $instances
        request_counter = $requestCounter
        gpu = $gpu
    }
}

function Get-HttpStatusText([int]$statusCode) {
    switch ($statusCode) {
        200 { return 'OK' }
        400 { return 'Bad Request' }
        404 { return 'Not Found' }
        500 { return 'Internal Server Error' }
        default { return 'OK' }
    }
}

function Read-HttpRequest([System.Net.Sockets.NetworkStream]$stream) {
    $reader = [System.IO.StreamReader]::new($stream, [System.Text.Encoding]::UTF8, $false, 1024, $true)

    $requestLine = $reader.ReadLine()
    if (-not $requestLine) {
        return $null
    }

    $parts = $requestLine.Split(' ')
    if ($parts.Count -lt 2) {
        throw 'Ligne de requete HTTP invalide.'
    }

    $headers = @{}
    while ($true) {
        $line = $reader.ReadLine()
        if ($null -eq $line -or $line -eq '') {
            break
        }

        $separator = $line.IndexOf(':')
        if ($separator -gt 0) {
            $headerName = $line.Substring(0, $separator).Trim()
            $headerValue = $line.Substring($separator + 1).Trim()
            $headers[$headerName] = $headerValue
        }
    }

    $rawBody = ''
    $contentLength = 0
    if ($headers.ContainsKey('Content-Length')) {
        [void][int]::TryParse([string]$headers['Content-Length'], [ref]$contentLength)
    }

    if ($contentLength -gt 0) {
        $buffer = New-Object char[] $contentLength
        $offset = 0
        while ($offset -lt $contentLength) {
            $read = $reader.Read($buffer, $offset, $contentLength - $offset)
            if ($read -le 0) {
                break
            }
            $offset += $read
        }
        if ($offset -gt 0) {
            $rawBody = -join $buffer[0..($offset - 1)]
        }
    }

    return @{
        method = $parts[0].ToUpperInvariant()
        path = ([Uri]('http://localhost' + $parts[1])).AbsolutePath.TrimEnd('/')
        raw_body = $rawBody
        headers = $headers
    }
}

function Read-JsonBody($request) {
    if (-not $request.raw_body) {
        return @{}
    }

    return ConvertTo-Hashtable (ConvertFrom-Json $request.raw_body)
}

function Get-ObjectProperty($object, [string]$name) {
    if ($null -eq $object) { return $null }
    if ($object -is [System.Collections.IDictionary]) {
        return $object[$name]
    }
    if ($object.PSObject.Properties.Match($name).Count -gt 0) {
        return $object.$name
    }
    return $null
}

function Set-ObjectProperty($object, [string]$name, $value) {
    if ($null -eq $object) { return $object }
    if ($object -is [System.Collections.IDictionary]) {
        $object[$name] = $value
        return $object
    }
    $object | Add-Member -NotePropertyName $name -NotePropertyValue $value -Force
    return $object
}

function ConvertTo-SerializableObject($value) {
    if ($null -eq $value) {
        return $null
    }

    if ($value -is [System.Collections.IDictionary]) {
        $obj = [PSCustomObject]@{}
        foreach ($key in $value.Keys) {
            $stringKey = [string]$key
            $obj | Add-Member -NotePropertyName $stringKey -NotePropertyValue (ConvertTo-SerializableObject $value[$key]) -Force
        }
        return $obj
    }

    if ($value -is [System.Collections.IEnumerable] -and -not ($value -is [string])) {
        $items = @()
        foreach ($item in $value) {
            $items += ,(ConvertTo-SerializableObject $item)
        }
        return $items
    }

    return $value
}

function Write-Json([System.Net.Sockets.NetworkStream]$stream, [int]$statusCode, $payload) {
    $serializable = ConvertTo-SerializableObject $payload
    $json = $serializable | ConvertTo-Json -Depth 8 -Compress
    $bodyBytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $statusText = Get-HttpStatusText $statusCode
    $headerText = "HTTP/1.1 {0} {1}`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: {2}`r`nAccess-Control-Allow-Origin: *`r`nAccess-Control-Allow-Methods: GET, POST, OPTIONS`r`nAccess-Control-Allow-Headers: *`r`nConnection: close`r`n`r`n" -f $statusCode, $statusText, $bodyBytes.Length
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)

    $stream.Write($headerBytes, 0, $headerBytes.Length)
    $stream.Write($bodyBytes, 0, $bodyBytes.Length)
    $stream.Flush()
}

# Watchdog background timer qui tourne toutes les 30 secondes
$watchdogTimer = New-Object System.Timers.Timer
$watchdogTimer.Interval = 30000
$watchdogTimer.AutoReset = $true
Register-ObjectEvent -InputObject $watchdogTimer -EventName Elapsed -Action {
    try {
        Write-Host "[Watchdog] Exécution vérification état..."
        $state = Get-ConsistentState
        $idleTimeoutMinutes = 30

        $now = Get-Date
        foreach ($instance in $state.instances) {
            if (-not $instance.running -or -not $instance.pid) { continue }
            
            $lastRequest = $Global:LastRequestTime[[string]$instance.port]
            if ($lastRequest) {
                $idleTime = ($now - $lastRequest).TotalMinutes
                if ($idleTime -gt $idleTimeoutMinutes) {
                    Write-Host "[Watchdog] Arrêt instance $($instance.port) inactive depuis $($idleTime.ToString('0.0')) minutes"
                    Stop-LlamaProcess @{ port = $instance.port } | Out-Null
                }
            }
        }

        # Persister compteurs dans l'état
        $state.request_counter = ConvertTo-Hashtable $Global:RequestCounter
        $state.last_request_time = @{}
        foreach ($key in $Global:LastRequestTime.Keys) {
            $state.last_request_time[[string]$key] = $Global:LastRequestTime[$key].ToString('o')
        }
        Save-State $state
    }
    catch {
        Write-Host "[Watchdog] Erreur: $($_.Exception.Message)"
    }
} | Out-Null
$watchdogTimer.Start()

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
try {
    $listener.Start()
} catch {
    throw "Impossible de demarrer le controleur hote sur 0.0.0.0:$Port. Detail: $($_.Exception.Message)"
}

# Restaurer compteurs depuis l'état si existant
try {
    $state = Get-State
    if ($state.request_counter) {
        $Global:RequestCounter = ConvertTo-Hashtable $state.request_counter
    }
    if ($state.last_request_time) {
        foreach ($key in $state.last_request_time.Keys) {
            $Global:LastRequestTime[[string]$key] = [datetime]$state.last_request_time[$key]
        }
    }
} catch {}

Write-Host "[Controller] Démarré sur le port $Port"
Write-Host "[Controller] Watchdog actif toutes les 30s"

while ($true) {
    $client = $null
    try {
        # Connexion asynchrone avec timeout pour ne pas bloquer indéfiniment
        $asyncResult = $listener.BeginAcceptTcpClient($null, $null)
        if (-not $asyncResult.AsyncWaitHandle.WaitOne(1000)) {
            continue
        }

        $client = $listener.EndAcceptTcpClient($asyncResult)
        $client.ReceiveTimeout = 5000
        $client.SendTimeout = 10000

        $stream = $client.GetStream()
        $request = Read-HttpRequest $stream

        # Incrémenter compteur de requêtes globales
        $Global:RequestCounter['total'] = if ($Global:RequestCounter['total']) { $Global:RequestCounter['total'] + 1 } else { 1 }

        if (-not $request) {
            continue
        }

        $path = $request.path
        if (-not $path) {
            $path = '/'
        }

        # Mettre à jour timestamp dernière requête pour chaque instance appelée
        foreach ($instance in (Get-ConsistentState).instances) {
            if ($request.raw_body -match "\b$($instance.port)\b" -or $request.path -match "\b$($instance.port)\b") {
                $portKey = [string]$instance.port
                $Global:LastRequestTime[$portKey] = Get-Date
                $Global:RequestCounter[$portKey] = if ($Global:RequestCounter[$portKey]) { $Global:RequestCounter[$portKey] + 1 } else { 1 }
            }
        }

        switch ("$($request.method) $path") {
            'OPTIONS *' {
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
                $state = Get-ConsistentState
                $existingInstance = $state.instances | Where-Object { $_.model -ieq $body.model -and $_.running } | Select-Object -First 1
                if ($existingInstance) {
                    Write-Host "[controller] model déjà chargé, promotion en actif : $($body.model)"
                    $body.activate = $true
                    Start-LlamaProcess $body | Out-Null
                    Write-Json $stream 200 (Get-RuntimeStatus)
                    continue
                }

                # Limitation max instances
                $runningInstances = $state.instances | Where-Object { $_.running } | Measure-Object | Select-Object -ExpandProperty Count
                if ($runningInstances -ge $config.max_instances) {
                    Write-Json $stream 429 @{ detail = "Limite maximum de $($config.max_instances) instances atteinte" }
                    continue
                }

                Start-LlamaProcess $body | Out-Null
                Write-Json $stream 200 (Get-RuntimeStatus)
                continue
            }
            'POST /stop' {
                $body = Read-JsonBody $request
                Write-Host "[controller] POST /stop model=$($body.model) id=$($body.id) proxy_id=$($body.proxy_id) port=$($body.port)"
                Stop-LlamaProcess $body | Out-Null
                Write-Json $stream 200 (Get-RuntimeStatus)
                continue
            }
            'POST /restart' {
                $body = Read-JsonBody $request
                Write-Host "[controller] POST /restart model=$($body.model) id=$($body.id) proxy_id=$($body.proxy_id) port=$($body.port)"
                Stop-LlamaProcess $body | Out-Null
                Start-Sleep -Milliseconds 1000
                Start-LlamaProcess $body | Out-Null
                Write-Json $stream 200 (Get-RuntimeStatus)
                continue
            }
            default {
                Write-Json $stream 404 @{ detail = 'Route introuvable' }
                continue
            }
        }
    } catch {
        if ($client -and $client.Connected) {
            try {
                Write-Json $client.GetStream() 500 @{ detail = $_.Exception.Message }
            } catch {}
        }
    } finally {
        if ($client) {
            $client.Dispose()
        }
    }
}
