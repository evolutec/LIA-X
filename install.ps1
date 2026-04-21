<#
LIA-X Installer - Résout automatiquement le problème de signature numérique PowerShell
Ce script se débloque lui même automatiquement et évite l'erreur "le script n'est pas signé numériquement"
#>
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

# ------------------------------------------------------------------------------
# ✅ CORRECTION AUTOMATIQUE DU PROBLEME DE SIGNATURE NUMERIQUE POWERSHELL
# ------------------------------------------------------------------------------
# Détecte si le script est marqué comme provenant d'internet (Mark Of The Web)
# et se débloque automatiquement ainsi que tous les fichiers du repository
# ------------------------------------------------------------------------------
$isBlocked = (Get-Item $PSCommandPath).AlternateDataStreams | Where-Object { $_.Name -eq 'Zone.Identifier' }

if ($isBlocked) {
    Write-Host "`n⚠️  Ce script a été téléchargé depuis internet et est bloqué par Windows`n" -ForegroundColor Yellow
    Write-Host "🔓 Déblocage automatique de tous les fichiers du repository en cours..." -ForegroundColor Cyan
    
    # Débloquer TOUS les fichiers du repository récursivement
    Get-ChildItem -Path $PSScriptRoot -Recurse -File | Unblock-File
    
    Write-Host "✅ Tous les fichiers ont été débloqués avec succès`n" -ForegroundColor Green
    Write-Host "🔄 Relance du script d'installation...`n" -ForegroundColor Cyan
    
    # Relancer le script automatiquement avec les mêmes arguments
    & $PSCommandPath @RemainingArgs
    
    # Quitter l'instance originale
    exit $LASTEXITCODE
}


$scriptPath = Join-Path $PSScriptRoot 'scripts\lia.ps1'
if (-not (Test-Path $scriptPath)) {
    throw "Le script d'installation est introuvable : $scriptPath"
}

$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
if (-not $pwsh) {
    $pwsh = Get-Command powershell -ErrorAction Stop
}

$arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $scriptPath) + $RemainingArgs
& $pwsh.Path @arguments
