$lines = Get-Content .\scripts\lia.ps1
for ($i = 467; $i -le 480; $i++) {
    $line = $lines[$i]
    Write-Host "Line $($i+1): $line"
    $chars = $line.ToCharArray()
    for ($j = 0; $j -lt $chars.Length; $j++) {
        $c = $chars[$j]
        Write-Host " $($j+1): [$( [int][char]$c)] '$c'"
    }
    Write-Host ''
}
