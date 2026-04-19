param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

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
