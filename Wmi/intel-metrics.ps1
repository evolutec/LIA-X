# Intel GPU Metrics Collection
# Utilise WMI Win32_PerfFormattedData_WDI_GPUAdapter pour Intel

function Get-IntelMetrics {
    $metrics = @()
    
    try {
        $gpuCounters = [WMICIMVS.WmiObject].Create().ExecQuery(
            "SELECT * FROM Win32_PerfFormattedData_WDI_GPUAdapter where AdapterCompatibility IS NOT NULL AND AdapterCompatibility LIKE 'Intel%'"
        )
        
        foreach ($gpu in $gpuCounters) {
            $metrics += @{
                Adapter = $gpu.AdapterCompatibility
                Description = $gpu.Description
                CurrentFrequency = [math]::Round($gpu.CurrentFrequency / 1000000, 2)  # MHz
                MaxFrequency = [math]::Round($gpu.MaxFrequency / 1000000, 2)  # MHz
                PowerUsage = $gpu.PowerConsumption  # Watts
                Temperature = [math]::Round($gpu.CurrentTemperature, 2)  # °C
                Workload = [math]::Round($gpu.AdapterWorkloadPercentage, 2)  # %
                MemoryUsed = [math]::Round($gpu.AdapterMemoryUsage / 1024, 2)  # GB
                MemoryTotal = [math]::Round($gpu.AdapterMemoryTotal / 1024, 2)  # GB
                DriverVersion = $gpu.DriverVersion
                DeviceId = [int]::Parse($gpu.AdapterDeviceId, 16)
                Status = $gpu.AdapterStatus
            }
        }
    } catch {
        Write-Warning "Intel WMI query failed: $($_.Exception.Message)"
    }
    
    return $metrics
}

function Get-IntelProcessMetrics {
    # Métriques des processus Intel
    $processes = Get-CimInstance -ClassName Win32_Process -Filter "Name LIKE 'igxcmd64*%' OR Name LIKE 'igxg10cmd64*%'"
    
    $processMetrics = @()
    foreach ($proc in $processes) {
        $processMetrics += @{
            ProcessName = $proc.Name
            ProcessId = $proc.ProcessId
            CPUUsed = [math]::Round($proc.CpuUsage, 2)
            MemoryUsed = [math]::Round($proc.WorkingSet / 1MB, 2)
        }
    }
    
    return $processMetrics
}

# Collecter toutes les métriques
$metrics = @{
    GPU = Get-IntelMetrics
    Processes = Get-IntelProcessMetrics
    Timestamp = (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss')
}

$output = $metrics | ConvertTo-Json -Compress
Write-Output $output