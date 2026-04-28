# install-update-lia-gpu-metrics-service.ps1
# Script d'installation et mise à jour du service LIA GPU Metrics
# À exécuter en tant qu'administrateur

param(
    [string]$RootDir = (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))
)

$ErrorActionPreference = 'Stop'

function Get-NssmExecutable {
    return (Get-Command nssm.exe -ErrorAction Stop).Source
}

function Get-PowerShellExecutable {
    $candidates = Get-Command pwsh -All -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source
    if ($candidates) {
        $preferred = $candidates | Where-Object { $_ -match '\\Program Files\\PowerShell\\' } | Select-Object -First 1
        if ($preferred) { return $preferred }
        return $candidates | Select-Object -First 1
    }
    return (Get-Command powershell.exe -ErrorAction Stop).Source
}

function Normalize-Value {
    param([string]$value)
    if ($null -eq $value) { return '' }
    return $value.Trim().Trim('"')
}

function Get-ServiceNssmConfig {
    param([string]$nssm, [string]$serviceName)

    try {
        $app = (& $nssm get $serviceName Application 2>$null | Out-String).Trim()
        $args = (& $nssm get $serviceName AppParameters 2>$null | Out-String).Trim()
        $dir = (& $nssm get $serviceName AppDirectory 2>$null | Out-String).Trim()
        $display = (& $nssm get $serviceName DisplayName 2>$null | Out-String).Trim()
        $description = (& $nssm get $serviceName Description 2>$null | Out-String).Trim()
        $start = (& $nssm get $serviceName Start 2>$null | Out-String).Trim()
        return @{ Application = $app; AppParameters = $args; AppDirectory = $dir; DisplayName = $display; Description = $description; Start = $start }
    } catch {
        return $null
    }
}

function Wait-ServiceRemoved {
    param(
        [string]$serviceName,
        [int]$timeoutSeconds = 30
    )

    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            Get-Service -Name $serviceName -ErrorAction Stop | Out-Null
        } catch {
            return $true
        }
        Start-Sleep -Seconds 1
    }
    return $false
}

function Remove-ServiceIfExists {
    param([string]$nssm, [string]$serviceName)
    
    # 1. Arrêter proprement le service s'il est actif
    try {
        $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
            Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 2
        }
    } catch {}
    
    # 2. Supprimer via NSSM
    try {
        & $nssm remove $serviceName confirm 2>$null | Out-Null
    } catch {}
    
    # 3. Forcer via sc.exe si NSSM échoue
    try {
        sc.exe delete $serviceName 2>$null | Out-Null
    } catch {}
    
    # 4. Tuer tout processus nssm.exe lié à ce service
    try {
        $nssmProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -eq 'nssm.exe' -and $_.CommandLine -match [regex]::Escape($serviceName) }
        foreach ($proc in $nssmProcs) {
            Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
        }
    } catch {}
    
    # 5. Attendre que Windows finalise la suppression dans le SCM
    $removed = Wait-ServiceRemoved -serviceName $serviceName -timeoutSeconds 30
    if (-not $removed) {
        Start-Sleep -Seconds 5
    }
}

function Install-Or-Update-LiaService {
    param(
        [string]$ServiceName,
        [string]$DisplayName,
        [string]$Description,
        [string]$ScriptPath
    )

    $nssm = Get-NssmExecutable
    $pwsh = Get-PowerShellExecutable

    $expectedArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`""
    $expectedAppDir = $RootDir

    $serviceExists = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $installNeeded = $true
    $skipInstall = $false

    if ($serviceExists) {
        $currentConfig = Get-ServiceNssmConfig -nssm $nssm -serviceName $ServiceName
        if ($currentConfig) {
            $sameApp = (Normalize-Value $currentConfig.Application) -ieq (Normalize-Value $pwsh)
            $sameArgs = (Normalize-Value $currentConfig.AppParameters) -ieq (Normalize-Value $expectedArgs)
            $sameDir = (Normalize-Value $currentConfig.AppDirectory) -ieq (Normalize-Value $expectedAppDir)
            $sameDisplay = (Normalize-Value $currentConfig.DisplayName) -ieq (Normalize-Value $DisplayName)
            $sameDesc = (Normalize-Value $currentConfig.Description) -ieq (Normalize-Value $Description)
            $sameStart = (Normalize-Value $currentConfig.Start) -ieq 'SERVICE_AUTO_START'

            if ($sameApp -and $sameArgs -and $sameDir -and $sameDisplay -and $sameDesc -and $sameStart) {
                # Vérifier si le service est running et écoute sur le port 13620
                $svc = Get-Service -Name $ServiceName -ErrorAction Stop
                if ($svc.Status -eq 'Running') {
                    # Vérifier si un processus écoute sur 13620
                    $portUsed = $false
                    try {
                        $tcp = Get-NetTCPConnection -LocalPort 13620 -State Listen -ErrorAction Stop
                        if ($tcp) {
                            $processId = $tcp.OwningProcess
                            $proc = Get-Process -Id $processId -ErrorAction SilentlyContinue
                            if ($proc -and $proc.ProcessName -match 'pwsh') {
                                $portUsed = $true
                            }
                        }
                    } catch {}
                    if ($portUsed) {
                        Write-Host "Service $ServiceName déjà configuré, en cours d'exécution et écoute sur le port 13620. Rien à faire."
                        $skipInstall = $true
                        $installNeeded = $false
                    } else {
                        Write-Host "Service $ServiceName running mais ne semble pas écouter sur le port 13620. Tentative de redémarrage..."
                        try {
                            Restart-Service -Name $ServiceName -Force -ErrorAction Stop
                            Start-Sleep -Seconds 3
                            # Vérifier à nouveau si le port est écouté
                            $tcp2 = $null
                            try {
                                $tcp2 = Get-NetTCPConnection -LocalPort 13620 -State Listen -ErrorAction Stop
                            } catch {}
                            if ($tcp2) {
                                $processId2 = $tcp2.OwningProcess
                                $proc2 = Get-Process -Id $processId2 -ErrorAction SilentlyContinue
                                if ($proc2 -and $proc2.ProcessName -match 'pwsh') {
                                    Write-Host "Redémarrage réussi, le service écoute maintenant sur le port 13620."
                                    $skipInstall = $true
                                    $installNeeded = $false
                                    return
                                }
                            }
                            Write-Host "Après redémarrage, le service n'écoute toujours pas sur le port 13620. Réinstallation nécessaire."
                        } catch {
                            Write-Warning "Redémarrage du service $ServiceName a échoué : $($_.Exception.Message). Réinstallation nécessaire."
                        }
                    }
                } else {
                    Write-Host "Service $ServiceName configuré mais pas en cours d'exécution. Tentative de démarrage..."
                    try {
                        Start-Service -Name $ServiceName -ErrorAction Stop
                        Start-Sleep -Seconds 3
                        # Vérifier si le port est écouté
                        $tcp2 = $null
                        try {
                            $tcp2 = Get-NetTCPConnection -LocalPort 13620 -State Listen -ErrorAction Stop
                        } catch {}
                        if ($tcp2) {
                            $processId2 = $tcp2.OwningProcess
                            $proc2 = Get-Process -Id $processId2 -ErrorAction SilentlyContinue
                            if ($proc2 -and $proc2.ProcessName -match 'pwsh') {
                                Write-Host "Démarrage réussi, le service écoute maintenant sur le port 13620."
                                $skipInstall = $true
                                $installNeeded = $false
                                return
                            }
                        }
                        Write-Host "Après démarrage, le service n'écoute toujours pas sur le port 13620. Réinstallation nécessaire."
                    } catch {
                        Write-Warning "Démarrage du service $ServiceName a échoué : $($_.Exception.Message). Réinstallation nécessaire."
                    }
                }
            } else {
                Write-Host "Reconfiguration du service $ServiceName..."
                Remove-ServiceIfExists -nssm $nssm -serviceName $ServiceName
            }
        } else {
            Write-Host "Service $ServiceName existant mais pas géré par NSSM, on le recrée."
            Remove-ServiceIfExists -nssm $nssm -serviceName $ServiceName
        }
    }

    if ($skipInstall) {
        return
    }
    if ($installNeeded) {
        Remove-ServiceIfExists -nssm $nssm -serviceName $ServiceName

        $attempt = 1
        while ($attempt -le 3) {
            $installOutput = & $nssm install $ServiceName $pwsh $expectedArgs 2>&1 | Out-String
            if ($LASTEXITCODE -eq 0) {
                break
            }
            if ($installOutput -match 'marked for deletion|marqu.*suppression') {
                Write-Warning "Service $ServiceName marqué pour suppression, attente avant nouvelle tentative..."
                Start-Sleep -Seconds 5
                Remove-ServiceIfExists -nssm $nssm -serviceName $ServiceName
                $attempt++
                continue
            }
            throw "Impossible d'installer le service $ServiceName via NSSM : $installOutput"
        }

        & $nssm set $ServiceName DisplayName "$DisplayName"
        & $nssm set $ServiceName Description "$Description"
        & $nssm set $ServiceName AppDirectory $expectedAppDir
        & $nssm set $ServiceName AppParameters $expectedArgs
        & $nssm set $ServiceName Start SERVICE_AUTO_START
        Write-Host "Service $ServiceName installé ou mis à jour."
    }

    try {
        $svc = Get-Service -Name $ServiceName -ErrorAction Stop
        if ($svc.Status -eq 'Running') {
            Write-Host "Service $ServiceName déjà en cours d'exécution."
        } else {
            try {
                Start-Service -Name $ServiceName -ErrorAction Stop
            } catch {
                Write-Warning "Start-Service pour $ServiceName a échoué : $($_.Exception.Message). Tentative avec NSSM..."
                try {
                    & $nssm start $ServiceName 2>$null | Out-Null
                } catch {
                    throw
                }
            }

            Start-Sleep -Seconds 2
            $svc = Get-Service -Name $ServiceName -ErrorAction Stop
            if ($svc.Status -eq 'Running') {
                Write-Host "Service $ServiceName démarré."
            } else {
                throw "Service $ServiceName n'est pas en cours d'exécution après tentative de démarrage (état: $($svc.Status))."
            }
        }
    } catch {
        Write-Warning "Impossible de démarrer le service $ServiceName : $($_.Exception.Message)"
    }
}

# Arrêter les anciens processus du service GPU Metrics
$legacyProcesses = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'gpu-metrics-service\.ps1' }

foreach ($proc in $legacyProcesses) {
    Write-Host "Arrêt du processus legacy PID $($proc.ProcessId) : $($proc.CommandLine)"
    try {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
    } catch {
        Write-Warning "Impossible d'arrêter le processus $($proc.ProcessId) : $($_.Exception.Message)"
    }
}

# LIA GPU Metrics: service de collecte de métriques GPU et système
$metricsScript = Join-Path $RootDir 'scripts\gpu-metrics-service.ps1'
Install-Or-Update-LiaService -ServiceName 'LIA GPU Metrics' -DisplayName 'LIA GPU Metrics' -Description 'Service de collecte de métriques système et GPU pour LIA' -ScriptPath $metricsScript

Write-Host "Installation du service LIA GPU Metrics terminée."