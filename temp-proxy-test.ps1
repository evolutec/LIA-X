$body = @{ model = 'lia-local'; messages = @(@{ role = 'user'; content = 'Bonjour' }) } | ConvertTo-Json -Compress
try {
    $response = Invoke-RestMethod -Uri 'http://127.0.0.1:3002/v1/chat/completions' -Method Post -ContentType 'application/json' -Body $body -TimeoutSec 30
    $response | ConvertTo-Json -Compress
} catch {
    Write-Host "STATUS: $($_.Exception.Response.StatusCode.Value__)"
    Write-Host "MESSAGE: $($_.Exception.Message)"
    if ($_.Exception.Response -ne $null) {
        $reader = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
        Write-Host "BODY: $($reader.ReadToEnd())"
    }
}
