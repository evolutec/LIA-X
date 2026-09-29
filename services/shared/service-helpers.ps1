# (continuation du helpers - fonctions NSSM avancées et arrêt propre)

function Remove-ServiceIfExists {
    param([string]$nssm, [string]$serviceName)
    # 1. Arrêter proprement le service s'il est actif
    try {
        $svc = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
            Write-Host "Stop-Service $serviceName (status actuel : $($svc.Status))..."
            Stop-Service -Name $serviceName -Force -ErrorAction Stop
            Start-Sleep -Seconds 3
        }
    } catch {}

    # 2. Supprimer via NSSM
    & $nssm remove $serviceName confirm 2>$null | Out-Null

    # 3. Forcer via sc.exe si NSSM échoue
    sc.exe delete $serviceName 2>$null | Out-Null

    # 4. Tuer tout processus nssm.exe lié à ce service
    $nssmProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -eq 'nssm.exe' -and $_.CommandLine -match [regex]::Escape($serviceName) }
    foreach ($proc in $nssmProcs) {
        Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }

    # 5. Attendre que Windows finalise la suppression dans le SCM
    Start-Sleep -Seconds 2
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $deadline) {
        try {
            Get-Service -Name $serviceName -ErrorAction Stop | Out-Null
            Start-Sleep -Seconds 1
        } catch {
            return $true  # service supprimé
        }
    }
    return $false  # toujours présent
}

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
        $appArgs = (& $nssm get $serviceName AppParameters 2>$null | Out-String).Trim()
        $dir = (& $nssm get $serviceName AppDirectory 2>$null | Out-String).Trim()
        $display = (& $nssm get $serviceName DisplayName 2>$null | Out-String).Trim()
        $description = (& $nssm get $serviceName Description 2>$null | Out-String).Trim()
        $start = (& $nssm get $serviceName Start 2>$null | Out-String).Trim()
        return @{ Application = $app; AppParameters = $appArgs; AppDirectory = $dir;
                   DisplayName = $display; Description = $description; Start = $start }
    } catch {
        return $null
    }
}

function Test-NssmConfigMatches {
    param(
        [hashtable]$Config,
        [string]$PowerShellPath,
        [string]$ScriptPath,
        [int]$ExpectedPort
    )

    if (-not $Config) { return $false }
    $app = Normalize-Value $Config.Application
    $pwshLeaf = Split-Path $PowerShellPath -Leaf
    $appLeaf = Split-Path $app -Leaf
    if ($appLeaf -ne $pwshLeaf) { return $false }

    $args = [string]$Config.AppParameters
    if ($args -notmatch [regex]::Escape($ScriptPath)) { return $false }
    if ($ExpectedPort -gt 0 -and $args -notmatch "\-Port\s+$ExpectedPort(\s|$)") { return $false }

    return $true
}

function Set-LiaServiceNssmConfig {
    param(
        [string]$Nssm,
        [string]$ServiceName,
        [string]$DisplayName,
        [string]$Description,
        [string]$PowerShellPath,
        [string]$ExpectedArgs,
        [string]$ExpectedAppDir,
        [string]$StdoutLog,
        [string]$StderrLog
    )

    & $Nssm set $ServiceName Application "$PowerShellPath" | Out-Null
    & $Nssm set $ServiceName AppParameters "$ExpectedArgs" | Out-Null
    & $Nssm set $ServiceName DisplayName "$DisplayName" | Out-Null
    & $Nssm set $ServiceName Description "$Description" | Out-Null
    & $Nssm set $ServiceName AppDirectory $ExpectedAppDir | Out-Null
    & $Nssm set $ServiceName AppStdout "$StdoutLog" | Out-Null
    & $Nssm set $ServiceName AppStderr "$StderrLog" | Out-Null
    & $Nssm set $ServiceName AppStdoutCreationDisposition 2 | Out-Null
    & $Nssm set $ServiceName AppStderrCreationDisposition 2 | Out-Null
    & $Nssm set $ServiceName AppRotateFiles 1 | Out-Null
    & $Nssm set $ServiceName AppRotateOnline 1 | Out-Null
    & $Nssm set $ServiceName AppRotateBytes 10485760 | Out-Null
    & $Nssm set $ServiceName AppRotateSeconds 86400 | Out-Null
    & $Nssm set $ServiceName Start SERVICE_AUTO_START | Out-Null
    & $Nssm set $ServiceName AppRestartDelay 30000 | Out-Null
    & $Nssm set $ServiceName AppThrottle 0 | Out-Null
}

function Test-ProcessCommandLineMatches {
    param([int]$ProcessId, [string]$Pattern)
    if (-not $ProcessId -or -not $Pattern) { return $false }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    return ($proc -and $proc.CommandLine -and $proc.CommandLine -match $Pattern)
}

function Get-PortListener {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    return $null
}

function Wait-PortReleased {
    param([int]$Port, [int]$timeoutSeconds = 15)
    if (-not (Get-PortListener -Port $Port)) {
        Write-Host "Port $Port est maintenant libre."
        return $true
    }
    Write-Host "[attente] Port $Port toujours occupé, prière patienter..."
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1
        if (-not (Get-PortListener -Port $Port)) {
            Write-Host "Port $Port est maintenant libre."
            return $true
        }
    }
    Write-Warning "Port $Port n'est pas devenu libre dans les $timeoutSeconds secondes. Le service ne pourra pas se binder."
    return $false
}

function Wait-PortListening {
    param([int]$Port, [int]$timeoutSeconds = 10)
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        $listenerPid = Get-PortListener -Port $Port
        if ($listenerPid) {
            return $listenerPid
        }
        Start-Sleep -Milliseconds 500
    }
    return $null
}

function Install-Or-Update-LiaService {
    param(
        [string]$ServiceName,
        [string]$DisplayName,
        [string]$Description,
        [string]$ScriptPath,
        [int]$ExpectedPort = 0,
        [string]$RootDir,
        [string]$ProcessPattern = ''
    )

    $nssm = Get-NssmExecutable
    $pwsh = Get-PowerShellExecutable
    $expectedArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" -Port $ExpectedPort"
    $expectedAppDir = Split-Path $ScriptPath -Parent
    $logSlug = ($ServiceName -replace '[^\w.-]+', '-').ToLowerInvariant()
    $stdoutLog = Join-Path $RootDir "logs\$logSlug\nssm-stdout.log"
    $stderrLog = Join-Path $RootDir "logs\$logSlug\nssm-stderr.log"
    $logDir = Split-Path $stdoutLog -Parent
    if (-not $ProcessPattern) {
        $ProcessPattern = [regex]::Escape((Split-Path $ScriptPath -Leaf))
    }
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null

    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    $currentConfig = $null
    if ($svc) {
        $currentConfig = Get-ServiceNssmConfig -nssm $nssm -serviceName $ServiceName
    }

    if ($svc -and (Test-NssmConfigMatches -Config $currentConfig -PowerShellPath $pwsh -ScriptPath $ScriptPath -ExpectedPort $ExpectedPort)) {
        Write-Host "Service '$ServiceName' déjà installé : mise à jour légère de la configuration NSSM."
        Set-LiaServiceNssmConfig -Nssm $nssm -ServiceName $ServiceName -DisplayName $DisplayName -Description $Description -PowerShellPath $pwsh -ExpectedArgs $expectedArgs -ExpectedAppDir $expectedAppDir -StdoutLog $stdoutLog -StderrLog $stderrLog

        if ($svc.Status -ne 'Running') {
            Write-Host "Démarrage du service '$ServiceName'..."
            try {
                Start-Service -Name $ServiceName -ErrorAction Stop
            } catch {
                Write-Warning "Start-Service a échoué: $($_.Exception.Message). Tentative via NSSM start..."
                & $nssm start $ServiceName 2>$null | Out-Null
            }
            Start-Sleep -Seconds 2
        } else {
            Write-Host "Service '$ServiceName' déjà en cours d'exécution."
        }

        if ($ExpectedPort -gt 0) {
            $listenerPid = Get-PortListener -Port $ExpectedPort
            if (-not $listenerPid) {
                $listenerPid = Wait-PortListening -Port $ExpectedPort -timeoutSeconds 5
            }

            if ($listenerPid -and (Test-ProcessCommandLineMatches -ProcessId $listenerPid -Pattern $ProcessPattern)) {
                Write-Host "[OK] Le port $ExpectedPort est écouté par '$ServiceName' (PID $listenerPid)."
            } elseif ($listenerPid -eq 4 -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status -eq 'Running') {
                Write-Host "[OK] Le port $ExpectedPort est écouté via HTTP.sys/System pour '$ServiceName'."
            } elseif ($listenerPid) {
                $listenerProc = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue
                Write-Warning "[ATTENTION] Le port $ExpectedPort est écouté par PID $listenerPid ($($listenerProc.Name)), pas par '$ServiceName'."
            } else {
                Write-Warning "[ATTENTION] Aucun processus n'écoute sur le port $ExpectedPort après vérification légère."
            }
        }

        Write-Host "Installation du service '$ServiceName' terminée."
        return
    }

    # === PRÉ-FLIGHT : détection des processus contrôleur existants ===
    Write-Host "=== PRÉ-FLIGHT : détection des processus existants pour '$ServiceName' ==="
    $serviceProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and $_.CommandLine -match $ProcessPattern -and $_.Name -eq 'pwsh.exe'
        }
    if ($serviceProcs) {
        Write-Host "[pre-flight] $($serviceProcs.Count) processus détecté(s) pour '$ServiceName' (legacy ou orphelin):"
        foreach ($p in $serviceProcs) {
            Write-Host "  PID $($p.ProcessId) - $($p.CommandLine)"
        }
    } else {
        Write-Host "[pre-flight] Aucun processus pwsh détecté pour '$ServiceName'."
    }

    # === PRÉ-FLIGHT : vérifier le port attendu ===
    if ($ExpectedPort -gt 0) {
        $existingListener = Get-PortListener -Port $ExpectedPort
        if ($existingListener) {
            $ownerProc = Get-CimInstance Win32_Process -Filter "ProcessId=$existingListener" -ErrorAction SilentlyContinue
            $isExpectedService = $ownerProc -and $ownerProc.CommandLine -and $ownerProc.CommandLine -match $ProcessPattern
            if (-not $isExpectedService) {
                Write-Warning "PRÉ-FLIGHT : le port $ExpectedPort est déjà occupé par le processus PID $existingListener"
                Write-Warning "PRÉ-FLIGHT : Si ce processus n'est PAS '$ServiceName', il convient de l'arrêter avant l'installation."
                Write-Warning "PRÉ-FLIGHT : Cette installation va tenter d'arrêter le service '$ServiceName' (si existant) et ses processus résiduels."
                $null = Wait-PortReleased -Port $ExpectedPort -timeoutSeconds 5
            }
        }
    }

    # === Étape 1 : avertissement avant manipulation ===
    if ($ExpectedPort -gt 0 -and (Get-PortListener -Port $ExpectedPort)) {
        $owner = Get-PortListener -Port $ExpectedPort
        $ownerProc = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
        $isExpectedService = $ownerProc -and $ownerProc.CommandLine -and $ownerProc.CommandLine -match $ProcessPattern
        if (-not $isExpectedService) {
            Write-Warning "PRÉ-FLIGHT : Des processus sont en cours d'exécution sur le port $ExpectedPort."
            Write-Warning "PRÉ-FLIGHT : Le port $ExpectedPort est occupé par PID $owner. Si ce PID n'est PAS '$ServiceName', l'étape d'arrêt ci-dessous ne le touchera pas et le port restera occupé."
        }
        Write-Host ""
    }

    # === Étape 2 : Supprimer d'abord le service NSSM si présent ===
    # CRITIQUE : le service doit être supprimé AVANT de tuer les processus,
    # sinon NSSM (AppThrottle) relance un nouveau controller entre deux kills
    # et le port ne se libère jamais (cause du crash-loop historique).
    $svcExists = $null -ne (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)
    if ($svcExists) {
        Write-Host "Suppression du service '$ServiceName' AVANT l'arrêt des processus (empêche NSSM de les relancer)..."
        $removed = Remove-ServiceIfExists -nssm $nssm -serviceName $ServiceName
        if ($removed) {
            Write-Host "Service '$ServiceName' supprimé du SCM."
        } else {
            Write-Warning "Le service '$ServiceName' est toujours présent dans le SCM. On continue quand même (NSSM pourra le mettre à jour)."
        }
    } else {
        Write-Host "Service '$ServiceName' absent du SCM (première installation ou nettoyage déjà fait)."
    }

    # === Étape 3 : tuer les processus contrôleurs résiduels (orphelins) ===
    # À faire APRÈS la suppression du service : plus aucun respawn NSSM possible.
    Write-Host "Arrêt des processus résiduels pour '$ServiceName' (pwsh orphelins):"
    $legacyProcs = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and $_.CommandLine -match $ProcessPattern
        }
    if (-not $legacyProcs) {
        Write-Host "  Aucun processus résiduel trouvé."
    } else {
        foreach ($p in $legacyProcs) {
            Write-Host "  Arrêt PID $($p.ProcessId) [$($p.Name)]..."
            try {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
                Write-Host "  Terminé PID $($p.ProcessId)"
            } catch {
                Write-Warning "  Impossible de terminer PID $($p.ProcessId) : $($_.Exception.Message)"
            }
        }
    }

    # === Étape 4 : Attendre que le port soit libre ===
    Write-Host "Vérification : port $ExpectedPort doit être libéré..."
    $released = Wait-PortReleased -Port $ExpectedPort -timeoutSeconds 15
    if (-not $released) {
        # Dernier recours : identifier et tuer le propriétaire du port s'il
        # s'agit bien d'un processus contrôleur (llama-host-controller).
        $owner = Get-PortListener -Port $ExpectedPort
        if ($owner) {
            $ownerProc = Get-CimInstance Win32_Process -Filter "ProcessId=$owner" -ErrorAction SilentlyContinue
            if ($ownerProc -and $ownerProc.CommandLine -match $ProcessPattern) {
                Write-Warning "Port $ExpectedPort toujours occupé par '$ServiceName' PID $owner. Arrêt forcé..."
                Stop-Process -Id $owner -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 3
                $released = Wait-PortReleased -Port $ExpectedPort -timeoutSeconds 10
            } else {
                Write-Warning "Port $ExpectedPort occupé par un processus tiers (PID $owner) : $(if ($ownerProc) { $ownerProc.Name } else { 'inconnu' }). L'installation continue malgré tout."
            }
        }
    }
    if (-not $released) {
        Write-Warning "Le port $ExpectedPort n'est pas libre. L'installation du service va malgré tout être tentée."
        Write-Warning "S'il est occupé par un processus tiers, le service ne pourra pas s'y binder."
    }

    # === Étape 6 : Installation du service ===
    Write-Host "Installation du service '$ServiceName' via NSSM..."
    $attempt = 1
    while ($attempt -le 3) {
        $installOutput = & $nssm install $ServiceName $pwsh $expectedArgs 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            break
        }
        if ($installOutput -match 'marked for deletion|marqu.*suppression') {
            Write-Warning "Service marqué pour suppression, attente de la fin de la suppression dans le SCM..."
            try { & $nssm remove $ServiceName confirm 2>$null | Out-Null } catch {}
            try { sc.exe delete $ServiceName 2>$null | Out-Null } catch {}
            $deadline = (Get-Date).AddSeconds(30)
            while ((Get-Date) -lt $deadline) {
                try {
                    Get-Service -Name $ServiceName -ErrorAction Stop | Out-Null
                    Start-Sleep -Milliseconds 500
                } catch {
                    break
                }
            }
            $attempt++
            continue
        }
        throw "Impossible d'installer le service '$ServiceName' via NSSM (tentative $attempt/3)"
    }

    # === Étape 7 : Configuration du service ===
    Set-LiaServiceNssmConfig -Nssm $nssm -ServiceName $ServiceName -DisplayName $DisplayName -Description $Description -PowerShellPath $pwsh -ExpectedArgs $expectedArgs -ExpectedAppDir $expectedAppDir -StdoutLog $stdoutLog -StderrLog $stderrLog
    Write-Host "Anti crash-loop configuré (AppRestartDelay=30s)."
    Write-Host "Service '$ServiceName' installé ou mis à jour."

    # === Étape 8 : Démarrage du service ===
    $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') {
        Write-Host "Service '$ServiceName' déjà en cours d'exécution."
    } else {
        Write-Host "Démarrage du service '$ServiceName'..."
        try {
            Start-Service -Name $ServiceName -ErrorAction Stop
        } catch {
            Write-Warning "Start-Service a échoué: $($_.Exception.Message). Tentative via NSSM start..."
            & $nssm start $ServiceName 2>$null | Out-Null
        }
        Start-Sleep -Seconds 3
        $svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
        if (-not $svc -or $svc.Status -ne 'Running') {
            Write-Warning "Service '$ServiceName' n'est pas Running après démarrage (état: $($svc.Status))."
            Write-Warning "Vérifiez les logs NSSM: stdout=$stdoutLog, stderr=$stderrLog"
            if (Test-Path $stderrLog) {
                Write-Host "--- stderr récent ---"
                Get-Content $stderrLog -Tail 15 | ForEach-Object { Write-Host "  $_" }
            }
        }
    }

    # === Étape 9 : Vérification post-démarrage du port ===
    if ($ExpectedPort -gt 0) {
        Write-Host "Vérification post-installation : le port $ExpectedPort doit être écouté..."
        Start-Sleep -Seconds 4
        $listenerPid = Get-PortListener -Port $ExpectedPort

        # ── Détection crash-loop : > 5 démarrages controller / minute = alerte ─
        $debugLog = Join-Path $RootDir "logs\controller\controller-debug.log"
        if (Test-Path $debugLog) {
            $oneMinuteAgo = (Get-Date).AddMinutes(-1)
            $recentStarts = 0
            try {
                Get-Content $debugLog -Tail 300 -ErrorAction SilentlyContinue | ForEach-Object {
                    if ($_ -match '^\[(.+?)\].*Startup: listener lie') {
                        try { if ([datetime]::Parse($Matches[1]) -gt $oneMinuteAgo) { $recentStarts++ } } catch {}
                    }
                }
            } catch {}
            if ($recentStarts -gt 5) {
                Write-Warning "CRASH-LOOP DÉTECTÉ : $recentStarts démarrages du controller en moins d'une minute !"
                Write-Warning "Le service tourne mais crash immédiatement après démarrage (ParserError, port occupé, etc.)."
                Write-Warning "Consultez $debugLog et $stderrLog pour la cause racine."
            } elseif ($recentStarts -gt 0) {
                Write-Host "Démarrages récents du controller : $recentStarts (normal)."
            }
        }

        if ($listenerPid) {
            # NOTE : avec NSSM, Win32_Service.ProcessId = PID de nssm.exe, alors
            # que le listener est le process enfant (pwsh). On valide donc que le
            # PID à l'écoute est bien un processus contrôleur (llama-host-controller).
            $listenerProc = Get-CimInstance Win32_Process -Filter "ProcessId=$listenerPid" -ErrorAction SilentlyContinue
            if ($listenerProc -and $listenerProc.CommandLine -match $ProcessPattern) {
                Write-Host "[OK] Le port $ExpectedPort est bien écouté par '$ServiceName' (PID $listenerPid)."
            } elseif ($listenerPid -eq 4 -and (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue).Status -eq 'Running') {
                Write-Host "[OK] Le port $ExpectedPort est écouté via HTTP.sys/System pour '$ServiceName'."
            } elseif ($listenerProc) {
                Write-Warning "[ATTENTION] Le port $ExpectedPort est écouté par PID $listenerPid ($($listenerProc.Name)) qui n'est PAS '$ServiceName'. Conflit probable."
            } else {
                Write-Warning "[ATTENTION] Le port $ExpectedPort est écouté par PID $listenerPid introuvable dans le système."
            }
        } else {
            Write-Warning "[ATTENTION] Aucun processus n'écoute sur le port $ExpectedPort après installation."
            Write-Warning "Vérifiez les logs NSSM :"
            Write-Warning "  stdout: $stdoutLog"
            Write-Warning "  stderr: $stderrLog"
            if (Test-Path $stderrLog) {
                Write-Host "Dernières lignes stderr :"
                Get-Content $stderrLog -Tail 20 | ForEach-Object { Write-Host "  $_" }
            }
        }
    }

    # === Étape 10 : Nettoyage des anciens logs trop volumineux ===
    foreach ($logFile in @($stdoutLog, $stderrLog)) {
        if (Test-Path $logFile) {
            $info = Get-Item $logFile
            if ($info.Length -gt 52428800) {
                Write-Host "[nettoyage] Réduction du log $(Split-Path -Leaf $logFile) ($([Math]::Round($info.Length / 1MB, 1)) Mo)"
                $tmp = [System.IO.Path]::GetTempFileName()
                Get-Content $logFile -Tail 200 | Set-Content $tmp -Encoding UTF8
                Move-Item $tmp $logFile -Force
            }
        }
    }

    Write-Host "Installation du service '$ServiceName' terminée."
}
