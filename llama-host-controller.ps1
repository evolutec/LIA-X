param(
    [int]$Port = 13579,
    [string]$ConfigPath = "",
    [string]$StatePath = ""
)

$ErrorActionPreference = "Stop"
$Global:RequestCounter = @{}
$Global:LastRequestTime = @{}

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
    $ConfigPath = Join-Path $PSScriptRoot "runtime\host-runtime-config.json"
}

if (-not $StatePath) {
    $StatePath = Join-Path $PSScriptRoot "runtime\host-runtime-state.json"
}

function ConvertTo-Hashtable($value) {
    if ($null -eq $value) {
        return $null
    }

    if ($value -is [System.Collections.IDictionary]) {
        $table = @{}
        foreach ($key in $value.Keys) {
            $table[$key] = ConvertTo-Hashtable $value[$key]
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

    return ConvertTo-Hashtable (Get-Content $StatePath -Raw | ConvertFrom-Json)
}

function Save-State([hashtable]$state) {
    $state | ConvertTo-Json -Depth 6 | Set-Content -Path $StatePath -Encoding UTF8
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

function Ensure-StateConsistency {
    $state = Get-State
    $state = Convert-LegacyState $state
    $changed = $false
    $graceWindowSeconds = 30

    $liveInstances = Discover-LiveInstances (Get-Config)
    if ($liveInstances.Count -gt 0) {
        $state.instances = @($liveInstances)
        Save-State $state
        return Get-State
    }

    # Garantir que instances est toujours un tableau, jamais un objet/hashtable
    if ($state.instances -isnot [System.Array]) {
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

    # Auto nettoyage des logs: supprimer les logs plus vieux que 7 jours
    $runtimeDir = Split-Path -Parent $StatePath
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

function Discover-LiveInstances([hashtable]$config) {
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
    $state = Ensure-StateConsistency
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
    $state = Ensure-StateConsistency
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
    $state = Ensure-StateConsistency

    $existingInstance = $state.instances | Where-Object { $_.model -ieq $record.model -and $_.running } | Select-Object -First 1
    if ($existingInstance -and (Test-TcpEndpoint -HostName '127.0.0.1' -Port ([int]$existingInstance.port) -TimeoutMs 1000)) {
        return $state
    }

    $port = Get-NextAvailablePort $config $state
    if (-not $port) {
        throw "Aucune plage de ports disponible pour démarrer un nouveau modèle."
    }

    $runtimeDir = Split-Path -Parent $StatePath
    if (-not (Test-Path $runtimeDir)) {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    }

    $stdoutLog = Join-Path $runtimeDir "llama-server.$port.stdout.log"
    $stderrLog = Join-Path $runtimeDir "llama-server.$port.stderr.log"

    # Initialiser compteurs pour cette instance
    $Global:RequestCounter[$port] = 0
    $Global:LastRequestTime[$port] = Get-Date

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
    }

    $state.instances = @($state.instances) + @($instance)
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

    return Ensure-StateConsistency
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
    $state = Ensure-StateConsistency
    $instances = @()

    foreach ($instance in $state.instances) {
        $instances += @{
            id = [string]$instance.id
            port = [int]$instance.port
            pid = $instance.pid
            request_count = if ($Global:RequestCounter[[int]$instance.port]) { $Global:RequestCounter[[int]$instance.port] } else { 0 }
            last_request_at = if ($Global:LastRequestTime[[int]$instance.port]) { $Global:LastRequestTime[[int]$instance.port].ToString('o') } else { $null }
            running = [bool]$instance.running
            model = [string]$instance.model
            filename = [string]$instance.filename
            path = [string]$instance.path
            started_at = [string]$instance.started_at
            last_error = [string]$instance.last_error
            stdout_log = [string]$instance.stdout_log
            stderr_log = [string]$instance.stderr_log
            estimated_vram_bytes = if ($instance.estimated_vram_bytes) { [int64]$instance.estimated_vram_bytes } else { $null }
            server_base_url = [string]$instance.server_base_url
            proxy_id = [string]$instance.proxy_id
        }
    }

    $gpu = Get-GpuState

    return @{
        running = [bool]($instances.Count -gt 0)
        pid = if ($instances.Count -gt 0) { $instances[0].pid } else { $null }
        active_model = if ($instances.Count -gt 0) { [string]$instances[0].model } else { '' }
        active_filename = if ($instances.Count -gt 0) { [string]$instances[0].filename } else { '' }
        active_path = if ($instances.Count -gt 0) { [string]$instances[0].path } else { '' }
        started_at = if ($instances.Count -gt 0) { [string]$instances[0].started_at } else { '' }
        last_error = if ($instances.Count -gt 0) { [string]$instances[0].last_error } else { '' }
        stdout_log = if ($instances.Count -gt 0) { [string]$instances[0].stdout_log } else { '' }
        stderr_log = if ($instances.Count -gt 0) { [string]$instances[0].stderr_log } else { '' }
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
        request_counter = $Global:RequestCounter
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

function Write-Json([System.Net.Sockets.NetworkStream]$stream, [int]$statusCode, $payload) {
    $json = $payload | ConvertTo-Json -Depth 8 -Compress
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
        $state = Ensure-StateConsistency
        $config = Get-Config
        $idleTimeoutMinutes = 30

        $now = Get-Date
        foreach ($instance in $state.instances) {
            if (-not $instance.running -or -not $instance.pid) { continue }
            
            $lastRequest = $Global:LastRequestTime[[int]$instance.port]
            if ($lastRequest) {
                $idleTime = ($now - $lastRequest).TotalMinutes
                if ($idleTime -gt $idleTimeoutMinutes) {
                    Write-Host "[Watchdog] Arrêt instance $($instance.port) inactive depuis $($idleTime.ToString('0.0')) minutes"
                    Stop-LlamaProcess @{ port = $instance.port } | Out-Null
                }
            }
        }

        # Persister compteurs dans l'état
        $state.request_counter = $Global:RequestCounter
        $state.last_request_time = @{}
        foreach ($key in $Global:LastRequestTime.Keys) {
            $state.last_request_time[$key] = $Global:LastRequestTime[$key].ToString('o')
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
        $Global:RequestCounter = $state.request_counter
    }
    if ($state.last_request_time) {
        foreach ($key in $state.last_request_time.Keys) {
            $Global:LastRequestTime[$key] = [datetime]$state.last_request_time[$key]
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
        foreach ($instance in (Ensure-StateConsistency).instances) {
            if ($request.raw_body -match "\b$($instance.port)\b" -or $request.path -match "\b$($instance.port)\b") {
                $Global:LastRequestTime[[int]$instance.port] = Get-Date
                $Global:RequestCounter[[int]$instance.port] = if ($Global:RequestCounter[[int]$instance.port]) { $Global:RequestCounter[[int]$instance.port] + 1 } else { 1 }
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

                # Limitation max instances
                $config = Get-Config
                $state = Ensure-StateConsistency
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
                Stop-LlamaProcess $body | Out-Null
                Write-Json $stream 200 (Get-RuntimeStatus)
                continue
            }
            'POST /restart' {
                $body = Read-JsonBody $request
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
