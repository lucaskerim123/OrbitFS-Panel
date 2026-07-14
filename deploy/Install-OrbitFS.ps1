<#
.SYNOPSIS
  Bootstraps OrbitFS on a Windows machine: clones (or locates) both repos,
  builds the shared FireStorm file-store skeleton, and generates .env files
  for both, all at locations YOU choose.

.DESCRIPTION
  Unlike the old install scripts, nothing here is hardcoded to a specific
  drive or username. If you don't pass -CodeDir / -HiveDataRoot, the script
  prompts for them interactively (with sensible defaults you can just press
  Enter to accept).

  Steps:
    1. Ask (or take from params) where the code goes (-CodeDir) and where the
       shared file store goes (-HiveDataRoot).
    2. Clone both repos into <CodeDir>\orbitfs-mcp and <CodeDir>\orbitfs-panel
       (pulls instead of cloning if a checkout already exists there).
    3. Build the FireStorm folder skeleton under -HiveDataRoot.
    4. Generate .env for both repos from their .env.example, with a fresh
       matching HIVE_API_KEY/SESSION_SECRET and every path pointed at what
       you chose in step 1-2. Existing .env files are never overwritten.
    5. npm install both repos.

  Does NOT set up Windows services, the Cloudflare tunnel, or IIS - run
  deploy\Setup-Services.ps1 next for that (it reads the same -CodeDir).

.PARAMETER CodeDir
  Parent folder both repos get cloned into, as CodeDir\orbitfs-mcp and
  CodeDir\orbitfs-panel. Prompted for if omitted.

.PARAMETER HiveDataRoot
  Where the shared FireStorm file store lives (this is the folder your MCP
  tools actually read/write). Prompted for if omitted. Can be any drive -
  put it on a data disk separate from the code if you want.

.PARAMETER HiveRepoUrl
.PARAMETER PanelRepoUrl
  Git remotes to clone from. Override if you're working from a fork.

.PARAMETER SkipClone
  Skip the git clone/pull step entirely - use this if CodeDir already has
  both repos checked out and you only want the folder-skeleton + .env steps
  re-run.

.EXAMPLE
  .\Install-OrbitFS.ps1
  (prompts for CodeDir and HiveDataRoot)

.EXAMPLE
  .\Install-OrbitFS.ps1 -CodeDir "D:\apps" -HiveDataRoot "D:\FireStorm\The Orbit FS"
#>
[CmdletBinding()]
param(
  [string]$CodeDir,
  [string]$HiveDataRoot,
  [string]$HiveRepoUrl = "https://github.com/lucaskerim123/mcp-hive-server.git",
  [string]$PanelRepoUrl = "https://github.com/lucaskerim123/the-master-brain.git",
  [switch]$SkipClone
)

$ErrorActionPreference = "Stop"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Write-Skip($msg) { Write-Host "    skip: $msg" -ForegroundColor DarkGray }
function Write-Warn2($msg) { Write-Host "    WARNING: $msg" -ForegroundColor Yellow }

function Read-PathWithDefault([string]$Prompt, [string]$Default) {
  $answer = Read-Host "$Prompt [$Default]"
  if ([string]::IsNullOrWhiteSpace($answer)) { return $Default }
  return $answer
}

function New-RandomSecret([int]$Length = 44) {
  $chars = (48..57) + (65..90) + (97..122)
  -join (1..$Length | ForEach-Object { [char]($chars | Get-Random) })
}

function Get-EnvValue([string]$EnvPath, [string]$Key) {
  if (-not (Test-Path -LiteralPath $EnvPath)) { return $null }
  $line = Get-Content -LiteralPath $EnvPath | Where-Object { $_ -match "^\s*$Key\s*=" } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -split "=", 2)[1].Trim()
}

function Ensure-Dir([string]$DirPath) {
  if (Test-Path -LiteralPath $DirPath) { Write-Skip "$DirPath already exists" }
  else { New-Item -ItemType Directory -Path $DirPath -Force | Out-Null; Write-Ok "created $DirPath" }
}

function Ensure-File([string]$FilePath, [string]$Content) {
  if (Test-Path -LiteralPath $FilePath) { Write-Skip "$FilePath already exists" }
  else { Set-Content -LiteralPath $FilePath -Value $Content -Encoding UTF8; Write-Ok "created $FilePath" }
}

function Copy-MissingTree([string]$SourceRoot, [string]$DestRoot) {
  if (-not (Test-Path -LiteralPath $SourceRoot)) {
    Write-Skip "$SourceRoot not found - skipping bundled content copy"
    return
  }
  Get-ChildItem -LiteralPath $SourceRoot -Recurse -Force | ForEach-Object {
    $relative = $_.FullName.Substring($SourceRoot.Length).TrimStart('\')
    if (-not $relative) { return }
    $dest = Join-Path $DestRoot $relative
    if ($_.PSIsContainer) {
      if (-not (Test-Path -LiteralPath $dest)) {
        New-Item -ItemType Directory -Path $dest -Force | Out-Null
        Write-Ok "created $dest"
      }
      return
    }
    if (-not (Test-Path -LiteralPath $dest)) {
      $parent = Split-Path -Parent $dest
      if ($parent -and -not (Test-Path -LiteralPath $parent)) {
        New-Item -ItemType Directory -Path $parent -Force | Out-Null
      }
      Copy-Item -LiteralPath $_.FullName -Destination $dest -Force
      Write-Ok "seeded $dest"
    } else {
      Write-Skip "$dest already exists"
    }
  }
}

function Invoke-Git([string[]]$GitArgs, [string]$WorkDir) {
  # WorkDir must be absolute by the time this runs - Resolve-CodeDir below
  # guarantees that. Cloning happens FROM WorkDir with an absolute -Dest
  # passed straight to git, so nothing gets re-resolved against the new cwd
  # (that double-resolution is what used to nest paths like test\server\test\server
  # when -CodeDir was given as a relative path).
  $prevLoc = Get-Location
  Set-Location $WorkDir
  try {
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
      throw "git $($GitArgs -join ' ') failed (exit $LASTEXITCODE). If this is a private repo, set up git credentials (a PAT or SSH key) first."
    }
  } finally { Set-Location $prevLoc }
}

function Get-OrUpdateRepo([string]$Url, [string]$Dest) {
  # $Dest is guaranteed absolute (see Resolve-CodeDir) - safe to pass as-is
  # regardless of what directory git ends up running from.
  if (Test-Path -LiteralPath (Join-Path $Dest ".git")) {
    Write-Skip "$Dest already a git checkout, pulling latest"
    Invoke-Git -GitArgs @("pull", "--ff-only") -WorkDir $Dest
    Write-Ok "$Dest up to date"
  } elseif (Test-Path -LiteralPath $Dest) {
    throw "$Dest already exists and isn't a git repo. Move it aside or choose a different -CodeDir."
  } else {
    $parent = Split-Path -Parent $Dest
    if (-not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    Invoke-Git -GitArgs @("clone", $Url, $Dest) -WorkDir $parent
    Write-Ok "cloned $Url to $Dest"
  }
}

function Resolve-OrCreateAbsolutePath([string]$Path) {
  # Turns any relative/mixed path into an absolute one BEFORE it's used for
  # cloning or file generation, so every downstream step - which may cd
  # around (git clone) or run from a different invocation directory next
  # time - keeps working off the same real location instead of silently
  # resolving against whatever the current directory happens to be.
  if (-not (Test-Path -LiteralPath $Path)) { New-Item -ItemType Directory -Path $Path -Force | Out-Null }
  return (Resolve-Path -LiteralPath $Path).Path
}

# --- 0. Prerequisites --------------------------------------------------------
Write-Step "Checking prerequisites"
foreach ($cmd in @("node", "npm")) {
  try { & $cmd --version | Out-Null } catch { throw "$cmd is not installed or not on PATH. Install Node.js 18+ from https://nodejs.org/ and re-run." }
}
Write-Ok "node $(node --version), npm $(npm --version)"
if (-not $SkipClone) {
  try { git --version | Out-Null } catch { throw "git is not installed or not on PATH. Install it (https://git-scm.com/) or pass -SkipClone if the code is already in place." }
  Write-Ok "git $(git --version)"
}

# --- 1. Ask where things go --------------------------------------------------
Write-Step "Choosing install locations"
if (-not $CodeDir) {
  Write-Host "Where should the OrbitFS code live? Two folders will be created here:" -ForegroundColor White
  Write-Host "  <CodeDir>\orbitfs-mcp    - the MCP/REST server" -ForegroundColor DarkGray
  Write-Host "  <CodeDir>\orbitfs-panel  - the web panel" -ForegroundColor DarkGray
  $CodeDir = Read-PathWithDefault "Code install directory" "F:\"
}
if (-not $HiveDataRoot) {
  Write-Host "Where should the shared FireStorm file store live? (this is the actual data - separate from code)" -ForegroundColor White
  $HiveDataRoot = Read-PathWithDefault "FireStorm data directory" (Join-Path $CodeDir "Project FireStorm\The Orbit FS")
}

# Resolve to an absolute path immediately, whatever form the user typed
# (relative, trailing slash, mixed / and \) - every downstream step assumes
# $CodeDir is absolute, since git clone changes the current directory and a
# still-relative path there would silently re-resolve against the wrong
# location (this bit a relative "test\server" -CodeDir previously, nesting
# the clone two folders deeper than intended).
$CodeDir = Resolve-OrCreateAbsolutePath $CodeDir

$HiveServerDir = Join-Path $CodeDir "orbitfs-mcp"
$PanelDir = Join-Path $CodeDir "orbitfs-panel"

Write-Ok "Code dir:   $CodeDir"
Write-Ok "MCP server: $HiveServerDir"
Write-Ok "Panel:      $PanelDir"
Write-Ok "Data root:  $HiveDataRoot"

if (-not (Test-Path -LiteralPath $CodeDir)) { New-Item -ItemType Directory -Path $CodeDir -Force | Out-Null }

# --- 2. Clone/update both repos ----------------------------------------------
if ($SkipClone) {
  Write-Step "Skipping clone (-SkipClone) - expecting repos already at the paths above"
  if (-not (Test-Path -LiteralPath $HiveServerDir)) { throw "$HiveServerDir not found. Remove -SkipClone or point -CodeDir at where the repos actually are." }
  if (-not (Test-Path -LiteralPath $PanelDir)) { throw "$PanelDir not found. Remove -SkipClone or point -CodeDir at where the repos actually are." }
} else {
  Write-Step "Getting orbitfs-mcp onto this machine"
  Get-OrUpdateRepo -Url $HiveRepoUrl -Dest $HiveServerDir
  Write-Step "Getting orbitfs-panel onto this machine"
  Get-OrUpdateRepo -Url $PanelRepoUrl -Dest $PanelDir
}

# --- 3. FireStorm folder skeleton --------------------------------------------
Write-Step "Creating FireStorm data folder skeleton at $HiveDataRoot"
Ensure-Dir $HiveDataRoot
$HiveDataRoot = (Resolve-Path -LiteralPath $HiveDataRoot).Path

$protectedRoots = @("_system", "_sorter", "_trash", "0. Core", "1. Legal", "2. Wellbeing", "_media")
foreach ($folder in $protectedRoots) { Ensure-Dir (Join-Path $HiveDataRoot $folder) }

$coreDir = Join-Path $HiveDataRoot "0. Core"
foreach ($folder in @("Master Logs", "Profiles", "Shared Notes", "Current AVO", "Active Orders")) { Ensure-Dir (Join-Path $coreDir $folder) }

$legalDir = Join-Path $HiveDataRoot "1. Legal"
foreach ($folder in @("0. Intake - Needs Review", "1. Addons", "Archive", "Documents", "Imports", "Key Dates", "Maintenance", "Reference Files", "Written Records")) { Ensure-Dir (Join-Path $legalDir $folder) }

$wellbeingDir = Join-Path $HiveDataRoot "2. Wellbeing"
foreach ($folder in @("0. Waiting To Be Sorted - Approval Required", "1. Plugin-Addons", "Archive", "Imports", "Letters - Documents", "Notes", "Pure Vent Mode", "Sessions")) { Ensure-Dir (Join-Path $wellbeingDir $folder) }

$mediaDir = Join-Path $HiveDataRoot "_media"
foreach ($folder in @("Photos", "Videos", "Audio")) { Ensure-Dir (Join-Path $mediaDir $folder) }

$systemDir = Join-Path $HiveDataRoot "_system"
Ensure-Dir (Join-Path $systemDir "Startup")
Ensure-Dir (Join-Path $systemDir "Rules")
Ensure-Dir (Join-Path $systemDir "Index")

$bundledHiveRoot = Join-Path $PanelDir "server files\The Orbit FS"
Write-Step "Seeding bundled Hive content from $bundledHiveRoot"
Copy-MissingTree -SourceRoot $bundledHiveRoot -DestRoot $HiveDataRoot

$note = "<!-- placeholder created by Install-OrbitFS.ps1 because bundled _system content was missing -->`n"
Ensure-File (Join-Path $systemDir "Startup\00_MASTER_STARTUP.md") "$note# Master Startup`n"
Ensure-File (Join-Path $systemDir "Startup\01_COURT_SYSTEM_STARTUP.md") "$note# Court System Startup`n"
Ensure-File (Join-Path $systemDir "Startup\02_MENTAL_HEALTH_SYSTEM_STARTUP.md") "$note# Mental Health System Startup`n"
Ensure-File (Join-Path $systemDir "Startup\03_MEDIA_STARTUP.md") "$note# Media Startup`n"
Ensure-File (Join-Path $systemDir "Rules\load_order.md") "$note# Load Order`n"
Ensure-File (Join-Path $systemDir "Rules\project_rules.md") "$note# Project Rules`n"
Ensure-File (Join-Path $systemDir "Rules\saving_rules.md") "$note# Saving Rules`n"
Ensure-File (Join-Path $systemDir "Rules\commands.md") "$note# Commands`n"
Ensure-File (Join-Path $systemDir "Index\file_index.json") "{}`n"
Ensure-File (Join-Path $systemDir "chatgpt_mcp_instructions.md") "$note# ChatGPT MCP Instructions`n"
Ensure-File (Join-Path $systemDir "claude_mcp_instructions.md") "$note# Claude MCP Instructions`n"

Write-Step "Creating log folders"
Ensure-Dir (Join-Path $HiveServerDir "logs")
Ensure-Dir (Join-Path $PanelDir "logs")

# --- 4. .env for orbitfs-mcp --------------------------------------------------
Write-Step "Setting up orbitfs-mcp\.env"
$hiveEnvPath = Join-Path $HiveServerDir ".env"
$hiveApiKey = $null
if (Test-Path -LiteralPath $hiveEnvPath) {
  Write-Skip ".env already exists, leaving it as-is"
  $hiveApiKey = Get-EnvValue -EnvPath $hiveEnvPath -Key "HIVE_API_KEY"
} else {
  $examplePath = Join-Path $HiveServerDir ".env.example"
  if (-not (Test-Path -LiteralPath $examplePath)) { throw "$examplePath not found - can't generate .env from it." }
  $hiveApiKey = New-RandomSecret
  $sessionSecret = New-RandomSecret
  $content = Get-Content -LiteralPath $examplePath -Raw
  $content = $content -replace "(?m)^HIVE_ROOT=.*$", "HIVE_ROOT=$HiveDataRoot"
  $content = $content -replace "(?m)^HIVE_API_KEY=\s*$", "HIVE_API_KEY=$hiveApiKey"
  $content = $content -replace "(?m)^SESSION_SECRET=\s*$", "SESSION_SECRET=$sessionSecret"
  Set-Content -LiteralPath $hiveEnvPath -Value $content -Encoding UTF8
  Write-Ok "generated .env with a fresh HIVE_API_KEY and SESSION_SECRET"
  Write-Warn2 "PUBLIC_BASE_URL still needs to be set by hand once you know your tunnel/domain"
}

# --- 5. .env for orbitfs-panel ------------------------------------------------
Write-Step "Setting up orbitfs-panel\.env"
$panelEnvPath = Join-Path $PanelDir ".env"
if (Test-Path -LiteralPath $panelEnvPath) {
  Write-Skip ".env already exists, leaving it as-is"
} else {
  $examplePath = Join-Path $PanelDir ".env.example"
  if (-not (Test-Path -LiteralPath $examplePath)) { throw "$examplePath not found - can't generate .env from it." }
  $hivePort = Get-EnvValue -EnvPath $hiveEnvPath -Key "PORT"
  if (-not $hivePort) { $hivePort = "3939" }
  $sorterDir = Join-Path $PanelDir "plugins\OrbitFS Sorter"
  $content = Get-Content -LiteralPath $examplePath -Raw
  if ($hiveApiKey) { $content = $content -replace "(?m)^HIVE_API_KEY=.*$", "HIVE_API_KEY=$hiveApiKey" }
  $content = $content -replace "(?m)^HIVE_URL=.*$", "HIVE_URL=http://localhost:$hivePort"
  $content = $content -replace "(?m)^HIVE_SERVER_DIR=.*$", "HIVE_SERVER_DIR=$HiveServerDir"
  $content = $content -replace "(?m)^HIVE_LOG_DIR=.*$", "HIVE_LOG_DIR=$(Join-Path $HiveServerDir 'logs')"
  $content = $content -replace "(?m)^SORTER_DIR=.*$", "SORTER_DIR=$sorterDir"
  Set-Content -LiteralPath $panelEnvPath -Value $content -Encoding UTF8
  Write-Ok "generated .env, matched HIVE_API_KEY to the MCP server's, pointed paths at $CodeDir"
}

# --- 5b. .env for orbitfs-sorter -----------------------------------------------
Write-Step "Setting up orbitfs-sorter\.env"
$sorterDir = Join-Path $PanelDir "plugins\OrbitFS Sorter"
$sorterEnvPath = Join-Path $sorterDir ".env"
if ((Test-Path -LiteralPath (Join-Path $sorterDir "server.js")) -and -not (Test-Path -LiteralPath $sorterEnvPath)) {
  $examplePath = Join-Path $sorterDir ".env.example"
  if (-not (Test-Path -LiteralPath $examplePath)) { throw "$examplePath not found - can't generate sorter .env from it." }
  $content = Get-Content -LiteralPath $examplePath -Raw
  if ($hiveApiKey) { $content = $content -replace "(?m)^HIVE_API_KEY=.*$", "HIVE_API_KEY=$hiveApiKey" }
  $content = $content -replace "(?m)^SORTER_HIVE_ROOT=.*$", "SORTER_HIVE_ROOT=$HiveDataRoot"
  Set-Content -LiteralPath $sorterEnvPath -Value $content -Encoding UTF8
  Write-Ok "generated sorter .env and pointed it at the Hive root"
} elseif (Test-Path -LiteralPath $sorterEnvPath) {
  Write-Skip "sorter .env already exists, leaving it as-is"
}

# --- 6. npm install -----------------------------------------------------------
Write-Step "Installing dependencies (orbitfs-mcp)"
Push-Location $HiveServerDir
try { npm install } finally { Pop-Location }
Write-Ok "orbitfs-mcp dependencies installed"

$sorterDir = Join-Path $PanelDir "plugins\OrbitFS Sorter"
if (Test-Path -LiteralPath (Join-Path $sorterDir "package.json")) {
  Write-Step "Installing dependencies (orbitfs-sorter)"
  Push-Location $sorterDir
  try { npm install } finally { Pop-Location }
  Write-Ok "sorter dependencies installed"
}

Write-Step "Installing dependencies (orbitfs-panel)"
Push-Location $PanelDir
try { npm install } finally { Pop-Location }
Write-Ok "orbitfs-panel dependencies installed"

# --- Done ---------------------------------------------------------------------
Write-Step "Base install complete"
Write-Host @"

Next steps:
  1. Open $hiveEnvPath and fill in PUBLIC_BASE_URL (and the CF_* values if
     you're using Cloudflare Access OAuth instead of the bearer key).
  2. Create your first panel login:
       cd "$PanelDir"
       node scripts/add-user.mjs <username> <4-10 digit pin>
  3. Run as Windows services (recommended) - installs all 4 services (panel,
     MCP server, sorter, Cloudflare tunnel) plus IIS, all pointed at the
     locations you just chose:
       .\Setup-Services.ps1 -CodeDir "$CodeDir"
     or run everything manually for local dev:
       cd "$HiveServerDir"; npm start        (in one window)
       cd "$PanelDir"; npm start             (in another)
       http://localhost:4000
"@
