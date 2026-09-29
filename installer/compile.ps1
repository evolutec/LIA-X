$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

Write-Host "Recherche du compilateur Inno Setup..." -ForegroundColor Cyan

$isccPath = $null
$candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 7\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 7\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe'),
    (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe')
)

foreach ($c in $candidates) {
    if (Test-Path -LiteralPath $c) {
        $isccPath = $c
        break
    }
}

if (-not $isccPath) {
    $found = Get-Command ISCC.exe -ErrorAction SilentlyContinue
    if ($found) { $isccPath = $found.Source }
}

if (-not $isccPath) {
    throw "ISCC.exe introuvable dans les chemins standards !"
}

Write-Host "Compilateur trouve : $isccPath" -ForegroundColor Green
$iss = (Resolve-Path '.\installer\LIA-X.iss').Path

Write-Host "Compilation de $iss..." -ForegroundColor Cyan
$p = Start-Process -FilePath $isccPath -ArgumentList "`"$iss`"" -PassThru -Wait -NoNewWindow

if ($p.ExitCode -ne 0) {
    throw "La compilation de l'installateur a echoue avec le code $($p.ExitCode) !"
}

Write-Host "`nCompilation de l'installateur reussie avec succes !" -ForegroundColor Green
$outExe = '.\installer\dist\LIA-X-Setup.exe'
if (Test-Path -LiteralPath $outExe) {
    $item = Get-Item -LiteralPath $outExe
    Write-Host "Fichier genere : $($item.FullName) ($([math]::Round($item.Length / 1MB, 2)) Mo, $($item.LastWriteTime))" -ForegroundColor Cyan
}
