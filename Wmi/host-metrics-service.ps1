# Host metrics service for containerized Model Loader
# This script listens on a local HTTP port and executes WMI metric scripts on the Windows host.

$port = 13610
$prefix = "http://127.0.0.1:$port/"

function Write-Response {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [int]$StatusCode,
        [string]$Body,
        [string]$ContentType = 'application/json'
    )

    $Response.StatusCode = $StatusCode
    $Response.ContentType = $ContentType
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Body)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

function Invoke-HostScript {
    param(
        [string]$ScriptPath
    )

    if (-not (Test-Path $ScriptPath)) {
        throw "Script not found: $ScriptPath"
    }

    try {
        $output = & $ScriptPath 2>&1 | Out-String
        if (-not $?) {
            throw "Host script failed: $output"
        }
        if (-not $output.Trim()) {
            throw "Host script returned empty output."
        }
        return $output.Trim()
    } catch {
        throw "Host script failed: $($_.Exception.Message)"
    }
}

function Get-HardwareProfile {
    $rootDir = Resolve-Path (Join-Path $PSScriptRoot '..')
    $hardwareProfilePath = Join-Path $rootDir 'runtime\hardware-profile.json'

    if (-not (Test-Path $hardwareProfilePath)) {
        return $null
    }

    try {
        return Get-Content -Path $hardwareProfilePath -Raw | ConvertFrom-Json
    } catch {
        return $null
    }
}

function Determine-GpuTypeFromProfile([psobject]$profile) {
    if (-not $profile -or -not $profile.vendor) {
        return 'SYSTEM'
    }

    switch ($profile.vendor.ToString().ToLower()) {
        'nvidia' { return 'NVIDIA' }
        'amd' { return 'AMD' }
        'intel' { return 'INTEL' }
        default { return 'SYSTEM' }
    }
}

function Get-HostMetrics {
    $scriptsRoot = $PSScriptRoot
    $hardwareProfile = Get-HardwareProfile
    $gpuType = Determine-GpuTypeFromProfile $hardwareProfile
    $detectionSource = 'hardware-profile'

    if (-not $gpuType) {
        $gpuType = 'SYSTEM'
    }

    $systemScript = Join-Path $scriptsRoot 'system-metrics.ps1'
    $systemJson = Invoke-HostScript -ScriptPath $systemScript
    $systemData = $systemJson | ConvertFrom-Json

    $metricsData = @{ System = $systemData }

    if ($gpuType -ne 'SYSTEM') {
        switch ($gpuType) {
            'NVIDIA' { $gpuScript = Join-Path $scriptsRoot 'nvidia-metrics.ps1' }
            'AMD' { $gpuScript = Join-Path $scriptsRoot 'amd-metrics.ps1' }
            'INTEL' { $gpuScript = Join-Path $scriptsRoot 'intel-metrics.ps1' }
            default { $gpuScript = Join-Path $scriptsRoot 'system-metrics.ps1' }
        }

        $gpuJson = Invoke-HostScript -ScriptPath $gpuScript
        $gpuData = $gpuJson | ConvertFrom-Json
        $metricsData.GPU = $gpuData.GPU
        $metricsData.Processes = $gpuData.Processes
    } else {
        $metricsData.GPU = @()
        $metricsData.Processes = @()
    }

    return [pscustomobject]@{
        source     = 'host-wmi'
        gpuType    = $gpuType
        detection  = [pscustomobject]@{
            source = $detectionSource
            vendor = $hardwareProfile?.vendor
            label = $hardwareProfile?.label
        }
        metrics    = $metricsData
        timestamp  = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')
    }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add($prefix)

try {
    $listener.Start()
    Write-Host "Host metrics service listening on $prefix"

    while ($true) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        try {
            if ($request.HttpMethod -eq 'GET' -and $request.Url.AbsolutePath -eq '/metrics/host') {
                $hostMetrics = Get-HostMetrics
                $body = $hostMetrics | ConvertTo-Json -Compress
                Write-Response -Response $response -StatusCode 200 -Body $body
            } else {
                Write-Response -Response $response -StatusCode 404 -Body '{"error":"Not found"}'
            }
        } catch {
            $message = @{ error = $_.Exception.Message; details = $_.Exception.ToString() } | ConvertTo-Json -Compress
            Write-Response -Response $response -StatusCode 500 -Body $message
        }
    }
} catch {
    Write-Error "Failed to start host metrics service: $($_.Exception.Message)"
} finally {
    if ($listener -ne $null -and $listener.IsListening) {
        $listener.Stop()
        $listener.Close()
    }
}
