# controller-launcher.ps1
# Simple Windows HTTP service to start/restart llama-host-controller.ps1 from localhost.
# Usage:
#   pwsh -File controller-launcher.ps1
# Then use http://127.0.0.1:13580/health and POST http://127.0.0.1:13580/restart

param(
    [string]$ControllerScriptPath = "$PSScriptRoot\llama-host-controller.ps1",
    [int]$ListenPort = 13580,
    [int]$ControllerPort = 13579
)

function Get-ControllerStatus {
    try {
        $uri = "http://127.0.0.1:$ControllerPort/status"
        $response = Invoke-RestMethod -Uri $uri -Method Get -TimeoutSec 3 -ErrorAction Stop
        return @{ ok = $true; controller_ok = $true; runtime = $response }
    } catch {
        return @{ ok = $true; controller_ok = $false; detail = $_.Exception.Message }
    }
}

function Get-RunningControllerProcess {
    $processes = Get-Process -Name pwsh,powershell -ErrorAction SilentlyContinue
    foreach ($proc in $processes) {
        try {
            $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($proc.Id)").CommandLine
            if ($cmd -and $cmd -like '*llama-host-controller.ps1*') {
                return $proc
            }
        } catch {
            # ignore failures when reading command line
        }
    }
    return $null
}

function Start-Controller {
    if (-not (Test-Path $ControllerScriptPath)) {
        throw "Controller script not found: $ControllerScriptPath"
    }

    $existing = Get-RunningControllerProcess
    if ($existing) {
        return @{ started = $false; message = "Le contrôleur est déjà en cours d'exécution." }
    }

    $pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
    if (-not $pwsh) {
        $pwsh = Get-Command powershell -ErrorAction Stop
    }

    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $ControllerScriptPath)
    $proc = Start-Process -FilePath $pwsh.Path -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput "$PSScriptRoot\controller-launcher.stdout.log" -RedirectStandardError "$PSScriptRoot\controller-launcher.stderr.log"
    Start-Sleep -Seconds 2
    return @{ started = $true; pid = $proc.Id; message = 'Contrôleur démarré.' }
}

function Stop-Controller {
    $existing = Get-RunningControllerProcess
    if (-not $existing) {
        return @{ stopped = $false; message = 'Aucun processus de contrôleur en cours.' }
    }

    Stop-Process -Id $existing.Id -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 1
    return @{ stopped = $true; pid = $existing.Id; message = 'Contrôleur arrêté.' }
}

function Write-JsonResponse {
    param(
        [Parameter(Mandatory = $true)] $Body,
        [int]$StatusCode = 200,
        [System.Net.HttpListenerResponse]$Response
    )

    $json = $Body | ConvertTo-Json -Depth 5
    $buffer = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.StatusCode = $StatusCode
    $Response.ContentType = 'application/json'
    $Response.ContentLength64 = $buffer.Length
    $Response.OutputStream.Write($buffer, 0, $buffer.Length)
    $Response.OutputStream.Close()
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://127.0.0.1:$ListenPort/"
$listener.Prefixes.Add($prefix)
$listener.Start()
Write-Host "Controller launcher listening on $prefix"

try {
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        try {
            if ($request.HttpMethod -eq 'GET' -and $request.Url.AbsolutePath -eq '/health') {
                Write-JsonResponse (Get-ControllerStatus) -Response $response
                continue
            }

            if ($request.HttpMethod -eq 'POST') {
                switch ($request.Url.AbsolutePath) {
                    '/start' {
                        Write-JsonResponse (Start-Controller) -Response $response
                        continue
                    }
                    '/stop' {
                        Write-JsonResponse (Stop-Controller) -Response $response
                        continue
                    }
                    '/restart' {
                        Stop-Controller | Out-Null
                        Write-JsonResponse (Start-Controller) -Response $response
                        continue
                    }
                }
            }

            Write-JsonResponse @{ error = 'Route inconnue'; path = $request.Url.AbsolutePath } 404 -Response $response
        } catch {
            Write-JsonResponse @{ error = $_.Exception.Message } 500 -Response $response
        }
    }
} finally {
    $listener.Stop()
    $listener.Close()
}
