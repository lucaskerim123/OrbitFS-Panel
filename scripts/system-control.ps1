param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("hive", "tunnel", "panel")]
  [string]$Target,

  [ValidateSet("start", "stop", "restart")]
  [string]$Action = "restart"
)

[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

function Stop-HiveProcess {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*mcp-hive-server*server.js*" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

function Start-HiveProcess {
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -like "*mcp-hive-server*server.js*" }
  if (-not $running) {
    Start-Process -FilePath "node" -ArgumentList "C:\mcp-hive-server\server.js" `
      -WorkingDirectory "C:\mcp-hive-server" `
      -RedirectStandardOutput "C:\mcp-hive-server\out.log" `
      -RedirectStandardError "C:\mcp-hive-server\err.log" -WindowStyle Hidden
  }
}

function Stop-TunnelProcess {
  Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
}

function Start-TunnelProcess {
  $running = Get-Process cloudflared -ErrorAction SilentlyContinue
  if (-not $running) {
    Start-Process -FilePath "C:\cloudflared\cloudflared.exe" `
      -ArgumentList '--config "C:\Users\Lucas\.cloudflared\config.yml" tunnel run master-hive' `
      -RedirectStandardOutput "C:\cloudflared\tunnel_out.log" `
      -RedirectStandardError "C:\cloudflared\tunnel_err.log" -WindowStyle Hidden
  }
}

# panel stop/restart are called detached from server.js after it has already
# responded to the HTTP request, since both kill the very process serving
# that request. panel start is called synchronously - the service is already
# stopped in that case, so there's no request to lose.
switch ("$Target.$Action") {
  "hive.start"     { Start-HiveProcess }
  "hive.stop"      { Stop-HiveProcess }
  "hive.restart"   { Stop-HiveProcess; Start-Sleep -Seconds 1; Start-HiveProcess }

  "tunnel.start"   { Start-TunnelProcess }
  "tunnel.stop"    { Stop-TunnelProcess }
  "tunnel.restart" { Stop-TunnelProcess; Start-Sleep -Seconds 1; Start-TunnelProcess }

  "panel.start"    { Start-Service -Name MasterBrainPanel }
  "panel.stop"     { Start-Sleep -Seconds 1; Stop-Service -Name MasterBrainPanel -Force }
  "panel.restart"  { Start-Sleep -Seconds 1; Restart-Service -Name MasterBrainPanel -Force }
}

Write-Output '{"ok":true}'
