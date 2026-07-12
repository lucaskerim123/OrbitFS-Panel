<#
.SYNOPSIS
  The one script to run on a brand new machine that has nothing on it yet.
  Clones both repos onto C:\, then builds the shared file-store folder and
  wires the panel and server together.

.DESCRIPTION
  Three steps:
    1. Clone (or, if already present, `git pull`) orbitfs-mcp-server to
       F:\orbitfs-mcp-server.
    2. Clone (or pull) the panel repo to F:\orbitfs.
    3. Hand off to deploy\Install-BaseStructure.ps1, which creates the
       Project FireStorm folder tree and generates .env for both repos
       with a matching HIVE_API_KEY, so the panel is already pointed at
       the right server and the right file store.

  Safe to re-run. Existing repo checkouts are pulled instead of
  re-cloned, and Install-BaseStructure.ps1 never touches an existing
  .env or an existing folder.

.PARAMETER InstallDrive
  Where both repos get installed. Defaults to C:\, giving
  F:\orbitfs-mcp-server and F:\orbitfs.

.PARAMETER HiveRoot
  Where the shared FireStorm file store lives. This is the one thing
  most worth changing - point it at a data drive, a different folder
  name, whatever your box looks like. Defaults to
  "<InstallDrive>\Project FireStorm\The Master Hive". Whatever you set
  here is automatically written into the Hive server's .env, so the
  panel and server both agree on it - you only set this in one place.

.PARAMETER HiveRepoUrl
.PARAMETER PanelRepoUrl
  Git remotes to clone from. Override if you're working from a fork.

.EXAMPLE
  .\Install-MasterHive.ps1

.EXAMPLE
  # Keep the code on C:\ but put the file store on a data drive
  .\Install-MasterHive.ps1 -HiveRoot "D:\Project FireStorm\The Master Hive"

.EXAMPLE
  # Install everything under D:\ instead of C:\
  .\Install-MasterHive.ps1 -InstallDrive "D:\"
#>
[CmdletBinding()]
param(
  [string]$InstallDrive = "C:\",
  [string]$HiveRoot,
  [string]$HiveRepoUrl = "https://github.com/lucaskerim123/mcp-hive-server.git",
  [string]$PanelRepoUrl = "https://github.com/lucaskerim123/the-master-brain.git"
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "    skip: $msg" -ForegroundColor DarkGray }

function Invoke-Git([string[]]$GitArgs, [string]$WorkDir = $null) {
  $prevLoc = $null
  if ($WorkDir) { $prevLoc = Get-Location; Set-Location $WorkDir }
  try {
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
      throw "git $($GitArgs -join ' ') failed (exit $LASTEXITCODE). If this is a private repo, make sure git credentials (a PAT or SSH key) are set up on this machine first."
    }
  } finally {
    if ($prevLoc) { Set-Location $prevLoc }
  }
}

function Get-OrUpdateRepo([string]$Url, [string]$Dest) {
  if (Test-Path -LiteralPath (Join-Path $Dest ".git")) {
    Write-Skip "$Dest already a git repo, pulling latest instead of cloning"
    Invoke-Git -GitArgs @("pull", "--ff-only") -WorkDir $Dest
    Write-Ok "$Dest up to date"
  } elseif (Test-Path -LiteralPath $Dest) {
    throw "$Dest already exists and isn't a git repo. Move it aside, or pass a different -InstallDrive."
  } else {
    Invoke-Git -GitArgs @("clone", $Url, $Dest)
    Write-Ok "cloned $Url to $Dest"
  }
}

Write-Step "Checking prerequisites"
foreach ($cmd in @("git", "node", "npm")) {
  try { & $cmd --version | Out-Null } catch { throw "$cmd is not installed or not on PATH. Install it and re-run this script." }
}
Write-Ok "git, node, npm all found"

$HiveServerDir = Join-Path $InstallDrive "orbitfs-mcp-server"
$PanelDir = Join-Path $InstallDrive "orbitfs"
if (-not $HiveRoot) { $HiveRoot = Join-Path $InstallDrive "Project FireStorm\The Master Hive" }

Write-Step "Getting orbitfs-mcp-server onto this machine"
Get-OrUpdateRepo -Url $HiveRepoUrl -Dest $HiveServerDir

Write-Step "Getting orbitfs onto this machine"
Get-OrUpdateRepo -Url $PanelRepoUrl -Dest $PanelDir

Write-Step "Building the FireStorm folder tree and linking the panel to the server"
$baseInstaller = Join-Path $PanelDir "deploy\Install-BaseStructure.ps1"
if (-not (Test-Path -LiteralPath $baseInstaller)) {
  throw "$baseInstaller not found - orbitfs checkout looks incomplete."
}
& $baseInstaller -HiveServerDir $HiveServerDir -PanelDir $PanelDir -HiveRoot $HiveRoot

Write-Step "All done"
Write-Host "Server code: $HiveServerDir"
Write-Host "Panel code:  $PanelDir"
Write-Host "File store:  $HiveRoot"
Write-Host "`nFollow the 'Next steps' printed above (set PUBLIC_BASE_URL, create your first login, start both)."

