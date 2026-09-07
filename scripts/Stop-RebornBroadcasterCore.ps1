$ErrorActionPreference = 'Stop'
$hostName = '127.0.0.1'
$port = 8010

function Send-CoreCommand([string]$command) {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $client.Connect($hostName, $port)
        $stream = $client.GetStream()
        $stream.ReadTimeout = 5000
        $writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false), 1024, $true)
        $reader = [IO.StreamReader]::new($stream, [Text.UTF8Encoding]::new($false), $false, 1024, $true)
        $requestId = [Guid]::NewGuid().ToString('N')
        $writer.WriteLine((@{ id = $requestId; type = $command } | ConvertTo-Json -Compress))
        $writer.Flush()
        while ($true) {
            $line = $reader.ReadLine()
            if (-not $line) {
                throw 'The RebornBroadcaster core closed the connection before replying.'
            }
            try { $message = $line | ConvertFrom-Json } catch { continue }
            if ([string]$message.id -eq $requestId) {
                return $line
            }
        }
    } finally {
        $client.Dispose()
    }
}

try {
    $response = Send-CoreCommand 'stop-core'
    if ($response -and $response -notmatch '"type":"error"') {
        Write-Host 'The RebornBroadcaster core accepted the shutdown request.'
        exit 0
    }
} catch {
    Write-Verbose $_
}

try {
    $response = Send-CoreCommand 'close-app'
    if ($response -and $response -notmatch '"type":"error"') {
        Write-Host 'The legacy RebornBroadcaster core accepted the shutdown request.'
        exit 0
    }
} catch {
    Write-Verbose $_
}

$listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') } |
    Select-Object -First 1
if (-not $listener) {
    Write-Host 'No RebornBroadcaster core is listening on port 8010.'
    exit 0
}

$process = Get-CimInstance Win32_Process -Filter "ProcessId = $($listener.OwningProcess)"
$packagedCore = $process -and $process.Name -eq 'RebornBroadcaster.exe'
$developmentCore = $process -and $process.Name -in @('python.exe', 'pythonw.exe') -and
    $process.CommandLine -match '(?i)(^|\s)-m\s+reborn_broadcaster\.core_main(\s|$)'
if (-not $packagedCore -and -not $developmentCore) {
    throw "Refusing to stop PID $($listener.OwningProcess): port 8010 is not owned by a verified packaged or development RebornBroadcaster core."
}

Stop-Process -Id $listener.OwningProcess -Force
Write-Host "Stopped stranded RebornBroadcaster core PID $($listener.OwningProcess)."
