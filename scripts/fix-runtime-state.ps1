# fix-runtime-state.ps1 - Nettoie les instances orphelines dans host-runtime-state.json
# Exécutez: powershell -ExecutionPolicy Bypass -File .\FIX-RUNTIME-STATE.ps1

$StatePath = '.\runtime\host-runtime-state.json'
$state = Get-Content $StatePath -Raw | ConvertFrom-Json

Write-Host "Nettoyage des instances orphelines (PID null mais running=true)..."
$newInstances = @()
$livePid = 21072  # Seul PID live détecté

foreach ($inst in $state.instances) {
    if ($inst.pid -eq $livePid) {
        $inst.active = $true
        $newInstances += $inst
        Write-Host "✓ Garde instance PID $livePid (port $($inst.port), $($inst.model))"
    } elseif ($inst.pid -eq $null -or $inst.pid -eq 0) {
        Write-Host "- Supprime instance orpheline port $($inst.port) PID null ($($inst.model))"
    } else {
        Write-Host "- Supprime instance morte PID $($inst.pid) (port $($inst.port))"
    }
}

$state.instances = $newInstances
if ($newInstances.Count -gt 0) {
    $state.active_model = $newInstances[0].model
    $state.active_filename = $newInstances[0].filename
}

$state | ConvertTo-Json -Depth 10 | Set-Content $StatePath -Encoding UTF8

Write-Host "`n✅ État nettoyé ! Seule l'instance PID $livePid reste."
Write-Host "Vérifiez: Get-Content $StatePath | ConvertFrom-Json | ConvertTo-Json -Depth 10"
Write-Host "`nPuis redémarrez l'interface model-manager ou rafraîchissez."

