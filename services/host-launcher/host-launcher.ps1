$ErrorActionPreference = 'Stop'
$Port = 13580

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ProcessHelper {
    public const int PROCESS_QUERY_INFORMATION = 0x0400;
    public const int TOKEN_DUPLICATE = 0x0002;
    public const int TOKEN_QUERY = 0x0008;
    public const int TOKEN_ASSIGN_PRIMARY = 0x0001;
    public const int TOKEN_ADJUST_DEFAULT = 0x0080;
    public const int TOKEN_ADJUST_SESSIONID = 0x0100;
    public const uint SW_SHOW = 5;
    public const uint SW_RESTORE = 9;

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool OpenProcessToken(IntPtr ProcessHandle, uint DesiredAccess, out IntPtr TokenHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessAsUser(IntPtr hToken, string lpApplicationName, string lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, ref PROCESS_INFORMATION lpProcessInformation);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ShowWindow(IntPtr hWnd, uint nCmdShow);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll")]
    public static extern uint GetLastError();

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }
}
"@

function Get-LastWin32Error {
    return [ProcessHelper]::GetLastError()
}

function Get-InteractiveShellSession {
    foreach ($proc in (Get-Process -Name explorer -ErrorAction SilentlyContinue)) {
        if ($proc.SessionId -gt 0) { return [int]$proc.SessionId }
    }
    return 0
}

function Open-ExplorerInSession([string]$targetPath) {
    $sessionId = Get-InteractiveShellSession
    if ($sessionId -le 0) {
        Start-Process -FilePath 'explorer.exe' -ArgumentList @($targetPath) -ErrorAction Stop | Out-Null
        return $true
    }

    $explorerProc = Get-Process -Name explorer -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $sessionId } | Select-Object -First 1
    if (-not $explorerProc) {
        Start-Process -FilePath 'explorer.exe' -ArgumentList @($targetPath) -ErrorAction Stop | Out-Null
        return $true
    }

    $pi = New-Object ProcessHelper+PROCESS_INFORMATION
    $tokenHandle = [IntPtr]::Zero
    $procHandle = [IntPtr]::Zero
    try {
        $procHandle = [ProcessHelper]::OpenProcess([ProcessHelper]::PROCESS_QUERY_INFORMATION, $false, $explorerProc.Id)
        if ($procHandle -ne [IntPtr]::Zero) {
            $tokenAccess = [ProcessHelper]::TOKEN_DUPLICATE -bor [ProcessHelper]::TOKEN_QUERY -bor [ProcessHelper]::TOKEN_ASSIGN_PRIMARY -bor [ProcessHelper]::TOKEN_ADJUST_DEFAULT -bor [ProcessHelper]::TOKEN_ADJUST_SESSIONID
            if ([ProcessHelper]::OpenProcessToken($procHandle, $tokenAccess, [ref]$tokenHandle)) {
                $si = New-Object ProcessHelper+STARTUPINFO
                $si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
                $si.dwFlags = 0
                $si.wShowWindow = [ProcessHelper]::SW_SHOW
                $si.lpDesktop = 'winsta0\default'

                $cmd = '"C:\Windows\explorer.exe" "' + $targetPath.Replace('"', '""') + '"'
                if ([ProcessHelper]::CreateProcessAsUser($tokenHandle, $null, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $false, 0, [IntPtr]::Zero, $null, [ref]$si, [ref]$pi)) {
                    Start-Sleep -Milliseconds 600
                    $newProc = Get-Process -Id $pi.dwProcessId -ErrorAction SilentlyContinue
                    if ($newProc -and $newProc.MainWindowHandle -ne [IntPtr]::Zero) {
                        [ProcessHelper]::ShowWindow($newProc.MainWindowHandle, [ProcessHelper]::SW_RESTORE) | Out-Null
                        [ProcessHelper]::SetForegroundWindow($newProc.MainWindowHandle) | Out-Null
                    }
                    return $true
                }
            }
        }
    } finally {
        if ($pi.hProcess -ne [IntPtr]::Zero) { [void][ProcessHelper]::CloseHandle($pi.hProcess) }
        if ($pi.hThread -ne [IntPtr]::Zero) { [void][ProcessHelper]::CloseHandle($pi.hThread) }
        if ($tokenHandle -ne [IntPtr]::Zero) { [void][ProcessHelper]::CloseHandle($tokenHandle) }
        if ($procHandle -ne [IntPtr]::Zero) { [void][ProcessHelper]::CloseHandle($procHandle) }
    }

    Start-Process -FilePath 'explorer.exe' -ArgumentList @($targetPath) -ErrorAction Stop | Out-Null
    return $true
}

function Write-JsonResponse([System.Net.HttpListenerResponse]$Response, [int]$StatusCode, [object]$Body) {
    $Response.AddHeader('Access-Control-Allow-Origin', '*')
    $Response.AddHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    $Response.AddHeader('Access-Control-Allow-Headers', '*')
    $Response.StatusCode = $StatusCode
    $Response.ContentType = 'application/json; charset=utf-8'
    $json = $Body | ConvertTo-Json -Depth 10 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    $Response.ContentLength64 = $bytes.Length
    $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    $Response.OutputStream.Close()
}

$listener = New-Object System.Net.HttpListener
$prefix = "http://*:${Port}/"
$listener.Prefixes.Add($prefix)
try {
    $listener.Start()
} catch {
    Write-Warning "Host launcher impossible a demarrer sur le port $Port : $($_.Exception.Message)"
    exit 1
}

while ($true) {
    try {
        $context = $listener.GetContext()
        $request = $context.Request
        $response = $context.Response

        if ($request.HttpMethod -eq 'OPTIONS') {
            Write-JsonResponse -Response $response -StatusCode 200 -Body $null
            continue
        }

        if ($request.HttpMethod -ne 'POST') {
            Write-JsonResponse -Response $response -StatusCode 405 -Body @{ error = 'Method not allowed' }
            continue
        }

        if ($request.Url.AbsolutePath -ne '/open-folder') {
            Write-JsonResponse -Response $response -StatusCode 404 -Body @{ error = 'Endpoint introuvable' }
            continue
        }

        $body = [System.IO.StreamReader]::new($request.InputStream, [System.Text.Encoding]::UTF8).ReadToEnd()
        $data = $body | ConvertFrom-Json -ErrorAction Stop
        $target = if ($data -and $data.path) { [string]$data.path } else { $null }

        if (-not $target) {
            Write-JsonResponse -Response $response -StatusCode 400 -Body @{ ok = $false; message = 'Chemin manquant' }
            continue
        }

        if (-not (Test-Path -LiteralPath $target)) {
            Write-JsonResponse -Response $response -StatusCode 404 -Body @{ ok = $false; path = $target; message = 'Chemin introuvable' }
            continue
        }

        try {
            Open-ExplorerInSession -targetPath $target | Out-Null
            Write-JsonResponse -Response $response -StatusCode 200 -Body @{ ok = $true; path = $target; mode = 'launcher' }
        } catch {
            Write-JsonResponse -Response $response -StatusCode 500 -Body @{ ok = $false; path = $target; message = $_.Exception.Message }
        }
    } catch {
        try {
            Write-JsonResponse -Response $response -StatusCode 500 -Body @{ error = $_.Exception.Message }
        } catch {}
    }
}
