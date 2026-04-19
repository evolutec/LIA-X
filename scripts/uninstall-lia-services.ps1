# Script de désinstallation des services LIA
# À exécuter en tant qu'administrateur

$services = @(
    'LIA Controller'
)


foreach ($svc in $services) {
    Write-Host "Suppression du service : $svc"
    try {
        $service = Get-Service -Name $svc -ErrorAction Stop
        if ($service.Status -ne 'Stopped') {
            Write-Host "Arrêt du service $svc..."
            try {
                Stop-Service -Name $svc -Force -ErrorAction Stop
            } catch {
                Write-Host "Erreur lors de l'arrêt : $_"
            }
            Start-Sleep -Seconds 2
        }
    } catch {
        Write-Host "Service $svc introuvable ou déjà supprimé."
    }
    $deleteResult = sc.exe delete "$svc" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Erreur suppression $svc : $deleteResult"
    } else {
        Write-Host "Suppression demandée pour $svc. Attente de la disparition..."
        $timeout = 20
        $waited = 0
        while ($waited -lt $timeout) {
            Start-Sleep -Seconds 1
            $waited++
            try {
                Get-Service -Name $svc -ErrorAction Stop | Out-Null
            } catch {
                Write-Host "Service $svc supprimé."
                break
            }
            if ($waited -eq $timeout) {
                Write-Host "Timeout : le service $svc existe toujours après $timeout secondes."
            }
        }
    }
}

Write-Host "Désinstallation terminée. Vérifiez dans les services Windows que tout est bien supprimé."
