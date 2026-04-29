# modules/hardware.ps1
# Fonctions de détection et gestion du matériel

function Get-HardwareProfile {
    $controllers = Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue
    $names = @()
    foreach ($controller in $controllers) {
        if ($controller.Name) { $names += $controller.Name }
    }

    if ($names.Count -gt 0) {
        $joined = $names -join ' | '
    } else {
        $joined = ''
    }

    if ($joined -match 'NVIDIA') {
        $gpuVendor = 'nvidia'
    } elseif ($joined -match 'Radeon|AMD') {
        $gpuVendor = 'amd'
    } elseif ($joined -match 'Intel') {
        $gpuVendor = 'intel'
    } else {
        $gpuVendor = 'cpu'
    }

    if ($joined) { $gpuLabel = $joined } else { $gpuLabel = 'Aucun GPU détecté' }

    $gpuDevices = @()
    foreach ($controller in $controllers) {
        $name = ''
        if ($controller.Name) { $name = $controller.Name.Trim() }
        $driverVersion = ''
        if ($controller.DriverVersion) { $driverVersion = $controller.DriverVersion.Trim() }
        $adapterRam = 0
        if ($controller.AdapterRAM -ne $null) { $adapterRam = [int64]$controller.AdapterRAM }

        $gpuDevices += @{
            name = $name
            driver_version = $driverVersion
            adapter_ram_bytes = $adapterRam
        }
    }

    $processor = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
    $cpuProfile = $null
    if ($processor) {
        $model = ''
        if ($processor.Name) { $model = $processor.Name.Trim() }
        $manufacturer = ''
        if ($processor.Manufacturer) { $manufacturer = $processor.Manufacturer.Trim() }

        $physicalCores = 0
        if ($processor.NumberOfCores -ne $null) { $physicalCores = [int]$processor.NumberOfCores }
        $logicalProcessors = 0
        if ($processor.NumberOfLogicalProcessors -ne $null) { $logicalProcessors = [int]$processor.NumberOfLogicalProcessors }
        $maxClockSpeedMhz = 0
        if ($processor.MaxClockSpeed -ne $null) { $maxClockSpeedMhz = [int]$processor.MaxClockSpeed }
        $currentClockSpeedMhz = 0
        if ($processor.CurrentClockSpeed -ne $null) { $currentClockSpeedMhz = [int]$processor.CurrentClockSpeed }

        $cpuProfile = @{
            model = $model
            manufacturer = $manufacturer
            architecture = switch ($processor.Architecture) {
                0 { 'x86' }
                1 { 'MIPS' }
                2 { 'Alpha' }
                3 { 'PowerPC' }
                5 { 'ARM' }
                6 { 'Itanium' }
                9 { 'x64' }
                default { [string]$processor.Architecture }
            }
            physical_cores = $physicalCores
            logical_processors = $logicalProcessors
            max_clock_speed_mhz = $maxClockSpeedMhz
            current_clock_speed_mhz = $currentClockSpeedMhz
        }
    }

    $osInfo = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $memoryProfile = $null
    $osProfile = $null
    if ($osInfo) {
        $totalMemory = 0
        if ($osInfo.TotalVisibleMemorySize -ne $null) { $totalMemory = [int64]$osInfo.TotalVisibleMemorySize }
        $freeMemory = 0
        if ($osInfo.FreePhysicalMemory -ne $null) { $freeMemory = [int64]$osInfo.FreePhysicalMemory }

        $memoryProfile = @{
            total_bytes = $totalMemory * 1024
            free_bytes = $freeMemory * 1024
        }
        $caption = ''
        if ($osInfo.Caption) { $caption = $osInfo.Caption.Trim() }
        $version = ''
        if ($osInfo.Version) { $version = $osInfo.Version.Trim() }
        $buildNumber = ''
        if ($osInfo.BuildNumber) { $buildNumber = $osInfo.BuildNumber.Trim() }

        $osProfile = @{
            caption = $caption
            version = $version
            build_number = $buildNumber
        }
    }

    return @{
        vendor = $gpuVendor
        label = $gpuLabel
        gpu = @{
            vendor = $gpuVendor
            label = $gpuLabel
            count = $gpuDevices.Count
            devices = $gpuDevices
        }
        cpu = $cpuProfile
        memory = $memoryProfile
        os = $osProfile
        detected_at = (Get-Date).ToString('o')
    }
}

function Get-RecommendedRuntimeConfig([hashtable]$hardware) {
    $GB = 1024 * 1024 * 1024
    $vendorValue = 'cpu'
    if ($hardware -and $hardware.vendor) { $vendorValue = $hardware.vendor }
    $vendor = [string]$vendorValue.ToLower()

    $totalRam = 0
    if ($hardware -and $hardware.memory -and $hardware.memory.total_bytes) { $totalRam = [int64]$hardware.memory.total_bytes }

    $gpuRam = 0
    if ($hardware -and $hardware.gpu -and $hardware.gpu.devices -and $hardware.gpu.devices.Count -gt 0) { $gpuRam = [int64]$hardware.gpu.devices[0].adapter_ram_bytes }

    $recommended = @{
        backend = 'cpu'
        backend_label = 'CPU'
        context = 4096
        gpu_layers = 0
    }

    if ($vendor -in @('nvidia', 'amd', 'intel')) {
        if ($vendor -eq 'nvidia') {
            $recommended.backend = 'cuda'
            $recommended.backend_label = 'NVIDIA CUDA'
        } else {
            $recommended.backend = 'vulkan'
            $recommended.backend_label = 'Vulkan'
        }
        $recommended.gpu_layers = 999

        if ($gpuRam -ge 24 * $GB) {
            $recommended.context = 8192
        } elseif ($gpuRam -ge 14 * $GB) {
            $recommended.context = 6144
        } elseif ($gpuRam -ge 8 * $GB) {
            $recommended.context = 4096
        } else {
            $recommended.context = 2048
        }
    } else {
        if ($totalRam -ge 32 * $GB) {
            $recommended.context = 8192
        } elseif ($totalRam -ge 16 * $GB) {
            $recommended.context = 4096
        } else {
            $recommended.context = 2048
        }
    }

    return $recommended
}

function Get-BackendPlan($hardware) {
    $recommended = Get-RecommendedRuntimeConfig $hardware
    $vendor = [string]$hardware.vendor

    if ($vendor -eq 'nvidia') {
        return @{
            backend = 'cuda'
            label = 'NVIDIA CUDA'
            recommended_context = $recommended.context
            recommended_gpu_layers = $recommended.gpu_layers
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
            recommended_context = $recommended.context
            recommended_gpu_layers = $recommended.gpu_layers
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
            recommended_context = $recommended.context
            recommended_gpu_layers = $recommended.gpu_layers
            releaseCandidates = @(
                @{ backend = 'vulkan'; label = 'Vulkan'; assetPattern = 'llama-.*-bin-win-vulkan-x64\.zip$' },
                @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
            )
        }
    }

    return @{
        backend = 'cpu'
        label = 'CPU'
        recommended_context = $recommended.context
        recommended_gpu_layers = $recommended.gpu_layers
        releaseCandidates = @(
            @{ backend = 'cpu'; label = 'CPU'; assetPattern = 'llama-.*-bin-win-cpu-x64\.zip$' }
        )
    }
}

function Save-HardwareProfile([hashtable]$Config, [hashtable]$profile) {
    try {
        $hardwareProfilePath = $Config.paths.hardwareProfilePath

        # S'assurer que le répertoire parent existe
        $parentDir = Split-Path $hardwareProfilePath -Parent
        if (-not (Test-Path $parentDir)) {
            New-Item -ItemType Directory -Path $parentDir -Force | Out-Null
        }

        $existing = $null
        if (Test-Path $hardwareProfilePath) {
            try {
                $existing = Get-Content -Path $hardwareProfilePath -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            } catch {
                $existing = $null
            }
        }

        $generationCount = 1
        if ($existing -and $existing.generation_count) {
            $generationCount = [int]$existing.generation_count + 1
        }
        $profile.generation_count = $generationCount
        $profile.generated_at = (Get-Date).ToString('o')

        $jsonContent = $profile | ConvertTo-Json -Depth 6 -Compress
        [System.IO.File]::WriteAllText($hardwareProfilePath, $jsonContent, [System.Text.Encoding]::UTF8)

        OK "Profil matériel sauvegardé : $hardwareProfilePath (generation_count=$($profile.generation_count))"
    } catch {
        WARN "Impossible de sauvegarder le profil matériel: $($_.Exception.Message)"
    }
}