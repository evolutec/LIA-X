param(
    [int]$Port = 13579,
    [string]$ConfigPath = "",
    [string]$StatePath = ""
)

$ErrorActionPreference = "Stop"

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

function Get-Config {
    if (-not (Test-Path $ConfigPath)) {
        return @{
            controller_port = $Port
            server_port = 12434
            backend = "cpu"
            backend_label = "CPU"
            binary_path = ""
            models_dir = ""
            proxy_model_id = "lia-local"
            default_context = 8192
            default_gpu_layers = 999
        }
    }

    return ConvertTo-Hashtable (Get-Content $ConfigPath -Raw | ConvertFrom-Json)
}

function Get-State {
    if (-not (Test-Path $StatePath)) {
        return @{
            pid = $null
            running = $false
            active_model = ""
            active_filename = ""
            active_path = ""
            started_at = ""
            last_error = ""
            stdout_log = ""
            stderr_log = ""
        }
    }

    return ConvertTo-Hashtable (Get-Content $StatePath -Raw | ConvertFrom-Json)
}

function Save-State([hashtable]$state) {
    $state | ConvertTo-Json -Depth 6 | Set-Content -Path $StatePath -Encoding UTF8
}

function Ensure-StateConsistency {
    $state = Get-State
    if ($state.pid) {
        $process = Get-Process -Id ([int]$state.pid) -ErrorAction SilentlyContinue
        if (-not $process -or $process.HasExited) {
            $state.running = $false
            $state.pid = $null
            $state.started_at = ""
            Save-State $state
        }
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

function Stop-LlamaProcess {
    $state = Ensure-StateConsistency
    if (-not $state.pid) {
        $state.running = $false
        Save-State $state
        return $state
    }

    try {
        Stop-Process -Id ([int]$state.pid) -Force -ErrorAction Stop
    } catch {
        $state.last_error = $_.Exception.Message
    }

    $state.pid = $null
    $state.running = $false
    $state.started_at = ""
    Save-State $state
    return $state
}

function Start-LlamaProcess([hashtable]$body) {
    $config = Get-Config
    if (-not $config.binary_path -or -not (Test-Path $config.binary_path)) {
        throw "Binaire llama-server introuvable : $($config.binary_path)"
    }

    $record = Resolve-ModelRecord ([string]$body.model)
    $context = if ($body.context) { [int]$body.context } else { [int]$config.default_context }
    $gpuLayers = if ($body.gpu_layers) { [int]$body.gpu_layers } else { [int]$config.default_gpu_layers }
    $currentState = Ensure-StateConsistency

    if ($currentState.running -and $currentState.active_filename -ieq $record.file.Name -and (Test-TcpEndpoint -HostName '127.0.0.1' -Port ([int]$config.server_port) -TimeoutMs 1000)) {
        return $currentState
    }

    $runtimeDir = Split-Path -Parent $StatePath
    if (-not (Test-Path $runtimeDir)) {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    }

    $stdoutLog = Join-Path $runtimeDir "llama-server.stdout.log"
    $stderrLog = Join-Path $runtimeDir "llama-server.stderr.log"

    Stop-LlamaProcess | Out-Null

    $arguments = @(
        '--host', '0.0.0.0',
        '--port', ([string]$config.server_port),
        '-m', $record.file.FullName,
        '-c', ([string]$context)
    )

    if ($gpuLayers -gt 0 -and $config.backend -ne 'cpu') {
        $arguments += @('-ngl', ([string]$gpuLayers))
    }

    $process = Start-Process -FilePath $config.binary_path -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutLog -RedirectStandardError $stderrLog

    $state = Get-State
    $state.pid = $process.Id
    $state.running = $true
    $state.active_model = $record.model
    $state.active_filename = $record.file.Name
    $state.active_path = $record.file.FullName
    $state.started_at = (Get-Date).ToString('o')
    $state.last_error = ""
    $state.stdout_log = $stdoutLog
    $state.stderr_log = $stderrLog
    Save-State $state

    for ($i = 0; $i -lt 30; $i++) {
        if (Test-TcpEndpoint -Host '127.0.0.1' -Port ([int]$config.server_port) -TimeoutMs 1000) {
            break
        }
        Start-Sleep -Milliseconds 500
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
    $health = $false

    if ($state.running) {
        $health = Test-TcpEndpoint -Host '127.0.0.1' -Port ([int]$config.server_port) -TimeoutMs 1000
    }

    return @{
        running = [bool]($state.running -and $health)
        pid = $state.pid
        active_model = [string]$state.active_model
        active_filename = [string]$state.active_filename
        active_path = [string]$state.active_path
        started_at = [string]$state.started_at
        last_error = [string]$state.last_error
        stdout_log = [string]$state.stdout_log
        stderr_log = [string]$state.stderr_log
        backend = [string]$config.backend
        backend_label = [string]$config.backend_label
        binary_path = [string]$config.binary_path
        models_dir = [string]$config.models_dir
        server_port = [int]$config.server_port
        server_base_url = ("http://127.0.0.1:{0}/v1" -f $config.server_port)
        proxy_model_id = [string]$config.proxy_model_id
        default_context = [int]$config.default_context
        default_gpu_layers = [int]$config.default_gpu_layers
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
    $headerText = "HTTP/1.1 {0} {1}`r`nContent-Type: application/json; charset=utf-8`r`nContent-Length: {2}`r`nConnection: close`r`n`r`n" -f $statusCode, $statusText, $bodyBytes.Length
    $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($headerText)

    $stream.Write($headerBytes, 0, $headerBytes.Length)
    $stream.Write($bodyBytes, 0, $bodyBytes.Length)
    $stream.Flush()
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Any, $Port)
try {
    $listener.Start()
} catch {
    throw "Impossible de demarrer le controleur hote sur 0.0.0.0:$Port. Detail: $($_.Exception.Message)"
}

while ($true) {
    $client = $null
    try {
        $client = $listener.AcceptTcpClient()
        $stream = $client.GetStream()
        $request = Read-HttpRequest $stream

        if (-not $request) {
            continue
        }

        $path = $request.path
        if (-not $path) {
            $path = '/'
        }

        switch ("$($request.method) $path") {
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

                Start-LlamaProcess $body | Out-Null
                Write-Json $stream 200 (Get-RuntimeStatus)
                continue
            }
            'POST /stop' {
                Stop-LlamaProcess | Out-Null
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