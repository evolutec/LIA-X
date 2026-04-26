try {
    $content = Get-Content .\scripts\lia.ps1 -Raw
    [scriptblock]::Create($content) | Out-Null
    Write-Host 'PARSE-OK'
} catch {
    Write-Host 'PARSE-ERR'
    Write-Host $_.Exception.Message
    exit 1
}
