# GPU Collector - lia.ps1
# Collecteur de métriques hôte via PowerShell.HardwareMonitor

param(
    [string]$OutputJson,
    [int]$Interval = 1,
    [string]$Mode = 'collection'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$toolsDir = Join-Path $repoRoot 'tools'
$moduleName = 'HardwareMonitor'

function Ensure-Directory([string]$path) {
    if (-not (Test-Path $path)) {
        New-Item -ItemType Directory -Path $path -Force | Out-Null
    }
}

function Get-HardwareMonitorModulePath {
    return Join-Path $toolsDir 'HardwareMonitor'
}

function Install-HardwareMonitorModule {
    if (-not (Get-Command -Name Install-Module -ErrorAction SilentlyContinue)) {
        return $false
    }

    try {
        Write-Verbose '[HardwareMonitor] Installation du module depuis le repository PowerShell.'
        Install-Module -Name $moduleName -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
        return $true
    } catch {
        Write-Warning "Échec de l'installation du module HardwareMonitor depuis PowerShell Gallery : $($_.Exception.Message)"
        return $false
    }
}

function Download-HardwareMonitorModule {
    Ensure-Directory $toolsDir
    $moduleDir = Get-HardwareMonitorModulePath
    Ensure-Directory $moduleDir

    $baseUrl = 'https://raw.githubusercontent.com/Lifailon/PowerShell.HardwareMonitor/rsa/Module/HardwareMonitor/0.4'
    $files = @('HardwareMonitor.psd1', 'HardwareMonitor.psm1')

    foreach ($file in $files) {
        $target = Join-Path $moduleDir $file
        if (-not (Test-Path $target)) {
            Write-Verbose "[HardwareMonitor] Téléchargement de $file..."
            Invoke-WebRequest -Uri "$baseUrl/$file" -OutFile $target -TimeoutSec 60
        }
    }

    return $moduleDir
}

function Import-HardwareMonitorModule {
    if (Get-Module -ListAvailable -Name $moduleName) {
        Import-Module -Name $moduleName -ErrorAction Stop | Out-Null
        return $true
    }

    $moduleDir = Get-HardwareMonitorModulePath
    if (Test-Path $moduleDir) {
        try {
            Import-Module -Name $moduleDir -ErrorAction Stop | Out-Null
            return $true
        } catch {
            Write-Warning "[HardwareMonitor] Import local failed: $($_.Exception.Message)"
        }
    }

    if (Install-HardwareMonitorModule) {
        try {
            Import-Module -Name $moduleName -ErrorAction Stop | Out-Null
            return $true
        } catch {
            Write-Warning "[HardwareMonitor] Import après installation PSGallery failed: $($_.Exception.Message)"
        }
    }

    try {
        $moduleDir = Download-HardwareMonitorModule
        Import-Module -Name $moduleDir -ErrorAction Stop | Out-Null
        return $true
    } catch {
        Write-Warning "[HardwareMonitor] Import failed: $($_.Exception.Message)"
        return $false
    }
}

function Ensure-HardwareMonitorModule {
    if (Import-HardwareMonitorModule) { return $true }
    Write-Warning 'HardwareMonitor unavailable.'
    return $false
}

function Get-HardwareMonitorSensors {
    if (-not (Ensure-HardwareMonitorModule)) { return @() }

    try {
        if (-not (Get-Command -Name Get-Sensor -ErrorAction SilentlyContinue)) {
            throw 'Get-Sensor command introuvable dans le module HardwareMonitor.'
        }

        try {
            return Get-Sensor -Library -ErrorAction Stop
        } catch {
            Write-Warning "Get-Sensor -Library a échoué : $($_.Exception.Message)"
            return Get-Sensor -ErrorAction Stop
        }
    } catch {
        Write-Warning "Impossible de collecter les capteurs : $($_.Exception.Message)"
        if (Get-Command -Name Install-LibreHardwareMonitor -ErrorAction SilentlyContinue) {
            try {
                Write-Verbose '[HardwareMonitor] Installation de LibreHardwareMonitor en local...'
                Install-LibreHardwareMonitor
                return Get-Sensor -Library -ErrorAction Stop
            } catch {
                Write-Warning "Installation LibreHardwareMonitor échouée : $($_.Exception.Message)"
            }
        }
    }

    return @()
}

function Get-GpuVendor {
    $controllers = Get-CimInstance -ClassName Win32_VideoController -ErrorAction SilentlyContinue
    foreach ($controller in $controllers) {
        if ($controller.AdapterCompatibility -match 'NVIDIA') { return 'NVIDIA' }
        if ($controller.AdapterCompatibility -match 'AMD|ATI|Radeon') { return 'AMD' }
        if ($controller.AdapterCompatibility -match 'Intel') { return 'INTEL' }
    }
    return 'SYSTEM'
}

function Parse-HardwareMonitorSensors($sensors) {
    $gpuGroups = [ordered]@{}

    foreach ($sensor in $sensors) {
        if (-not $sensor.HardwareName) { continue }
        $name = $sensor.HardwareName
        if ($name -notmatch 'GPU|Radeon|NVIDIA|Intel|Iris|UHD|Xe|gfx') { continue }

        if (-not $gpuGroups.ContainsKey($name)) {
            $vendor = if ($name -match 'NVIDIA') { 'NVIDIA' } elseif ($name -match 'Radeon|AMD' ) { 'AMD' } elseif ($name -match 'Intel|Iris|UHD|Xe' ) { 'INTEL' } else { 'GPU' }
            $gpuGroups[$name] = [ordered]@{
                Vendor = $vendor
                Name = $name
                usage_percent = $null
                memory_total_bytes = $null
                memory_used_bytes = $null
                driver = ''
                sensors = @()
            }
        }

        $entry = $gpuGroups[$name]
        $value = $sensor.Value
        if ($value -isnot [double] -and $value -isnot [int]) {
            if ($value -match '^[\d\.]+$') { $value = [double]$matches[0] } else { $value = $sensor.Value }
        }

        $entry.sensors += [ordered]@{
            sensor_type = $sensor.SensorType
            sensor_name = $sensor.SensorName
            value = $value
            min = $sensor.Min
            max = $sensor.Max
        }

        if ($entry.usage_percent -eq $null -and $sensor.SensorType -match 'Load|Utilization') {
            if ($value -is [double] -or $value -is [int]) { $entry.usage_percent = [double]$value }
        }

        if ($entry.memory_used_bytes -eq $null -and $sensor.SensorName -match 'Memory.*Used|Used.*Memory|GPU Memory Used') {
            if ($value -is [double] -or $value -is [int]) { $entry.memory_used_bytes = [math]::Round([double]$value * 1024 * 1024) }
        }

        if ($entry.memory_total_bytes -eq $null -and $sensor.SensorName -match 'Memory.*Total|Total.*Memory|GPU Memory Total') {
            if ($value -is [double] -or $value -is [int]) { $entry.memory_total_bytes = [math]::Round([double]$value * 1024 * 1024) }
        }

        if ([string]$sensor.SensorName -match 'Driver') {
            $entry.driver = [string]$value
        }
    }

    return [array]$gpuGroups.Values
}

function Get-MainMetrics {
    $vendor = Get-GpuVendor
    $sensors = Get-HardwareMonitorSensors
    $gpuMetrics = Parse-HardwareMonitorSensors $sensors

    return [ordered]@{
        source = 'PowerShell.HardwareMonitor'
        vendor = $vendor
        GPU = $gpuMetrics
        tool = $moduleName
        tool_path = if (Get-Module -Name $moduleName -ListAvailable) { (Get-Module -Name $moduleName -ListAvailable | Select-Object -First 1).Path } else { Get-HardwareMonitorModulePath }
        timestamp = (Get-Date).ToString('o')
    }
}

if ($Mode -eq 'collection') {
    $result = Get-MainMetrics
    $json = $result | ConvertTo-Json -Compress -Depth 6
    if ($OutputJson) {
        $outputPath = Join-Path $OutputJson ((Get-Date).ToString('yyyy-MM-dd-HH-mm-ss') + '.json')
        $json | Out-File -FilePath $outputPath -Encoding UTF8
        Write-Verbose "[Output] Saved to $outputPath"
    }
    Write-Host $json
} else {
    while ($true) {
        $result = Get-MainMetrics
        $json = $result | ConvertTo-Json -Compress -Depth 6
        Write-Host $json
        Start-Sleep -Seconds $Interval
    }
}

