# Script PowerShell pour rebuild + recreate
# Ce script effectue une reconstruction complète du projet

# Configuration
$ErrorActionPreference = "Stop"
$ScriptRoot = $PSScriptRoot
$ModelManagerPath = Join-Path $ScriptRoot "model-manager"

Write-Host "=== REBUILD + RECREATE SCRIPT ===" -ForegroundColor Cyan
Write-Host "Date: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "Working Directory: $ScriptRoot"
Write-Host ""

# Vérification des prérequis
Write-Host "[1/3] Vérification des prérequis..." -ForegroundColor Yellow

if (-not (Test-Path $ModelManagerPath)) {
    Write-Error "Le dossier model-manager n'existe pas : $ModelManagerPath"
    exit 1
}

# Vérifier si Node.js est installé
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "Node.js n'est pas installé. Veuillez installer Node.js avant de continuer."
    exit 1
}

Write-Host "Node.js version : $(node --version)"
Write-Host "npm version : $(npm --version)"
Write-Host ""

# Étape 1 : Build du frontend
Write-Host "[2/3] Reconstruction du frontend..." -ForegroundColor Yellow

try {
    Write-Host "  - Nettoyage du dossier build..." -ForegroundColor Gray
    if (Test-Path "$(Join-Path $ModelManagerPath build)") {
        Remove-Item -Path "$(Join-Path $ModelManagerPath build)" -Recurse -Force
    }

    Write-Host "  - Lancement de npm run build..." -ForegroundColor Gray
    Set-Location $ModelManagerPath
    npm run build
    Set-Location $ScriptRoot
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "La commande npm run build a échoué avec le code d'erreur : $LASTEXITCODE"
        exit $LASTEXITCODE
    }

    Write-Host "  - Build terminé avec succès" -ForegroundColor Green
} catch {
    Write-Error "Erreur lors du build : $_"
    exit 1
}

# Étape 2 : Exécution du script recreate + check
Write-Host ""
Write-Host "[3/3] Exécution du script recreate + check..." -ForegroundColor Yellow

try {
    $recreateScript = Join-Path $ScriptRoot "recreate + check.ps1"
    
    if (-not (Test-Path $recreateScript)) {
        Write-Error "Le script recreate + check.ps1 n'existe pas : $recreateScript"
        exit 1
    }

    Write-Host "  - Exécution de recreate + check.ps1..." -ForegroundColor Gray
    powershell -ExecutionPolicy Bypass -File $recreateScript
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Le script recreate + check.ps1 a échoué avec le code d'erreur : $LASTEXITCODE"
        exit $LASTEXITCODE
    }
} catch {
    Write-Error "Erreur lors de l'exécution de recreate + check.ps1 : $_"
    exit 1
}

Write-Host ""
Write-Host "=== SCRIPT TERMINÉ ===" -ForegroundColor Cyan
Write-Host "Vérifiez le dossier model-manager/build pour les fichiers générés."
