<#
    ai-news-wallpaper installer.

        irm https://kshivam4781.github.io/ainewswallpaper/install.ps1 | iex

    Downloads the latest release, puts it on PATH, and starts the hourly
    refresh. No Node, no npm, no admin rights.

    Options (set before piping to iex):
        $env:AINW_VERSION = 'v1.0.0'   install a specific tag
        $env:AINW_NO_START = '1'       install without starting the schedule
#>

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo    = 'kshivam4781/ainewswallpaper'
$AppName = 'ai-news-wallpaper'
$Dest    = Join-Path $env:LOCALAPPDATA "Programs\$AppName"
$Exe     = Join-Path $Dest "$AppName.exe"

function Write-Step { param([string]$Text) Write-Host "  $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "  $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "  $Text" -ForegroundColor Yellow }

Write-Host ""
Write-Host "  ai-news-wallpaper" -ForegroundColor White
Write-Host "  ----------------------------------------"

# --- Preflight ---------------------------------------------------------------
if ([System.Environment]::OSVersion.Platform -ne 'Win32NT') {
    throw 'ai-news-wallpaper only runs on Windows.'
}
if ([Environment]::Is64BitOperatingSystem -eq $false) {
    throw 'A 64-bit version of Windows is required.'
}

# --- Find the release --------------------------------------------------------
Write-Step 'Looking up the latest release...'
$headers = @{ 'User-Agent' = 'ainw-installer'; 'Accept' = 'application/vnd.github+json' }
$apiUrl = if ($env:AINW_VERSION) {
    "https://api.github.com/repos/$Repo/releases/tags/$($env:AINW_VERSION)"
} else {
    "https://api.github.com/repos/$Repo/releases/latest"
}

try {
    $release = Invoke-RestMethod -Uri $apiUrl -Headers $headers
} catch {
    throw "Could not reach GitHub to find a release. $($_.Exception.Message)"
}

$asset = $release.assets | Where-Object { $_.name -eq "$AppName.exe" } | Select-Object -First 1
if (-not $asset) {
    throw "Release $($release.tag_name) has no $AppName.exe attached."
}
Write-Ok "Found $($release.tag_name)  ($([Math]::Round($asset.size / 1MB, 1)) MB)"

# --- Stop anything already running -------------------------------------------
if (Test-Path $Exe) {
    Write-Step 'Upgrading an existing install...'
    try { & schtasks /End /TN 'AI News Wallpaper' 2>$null | Out-Null } catch {}
    Get-Process -Name $AppName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 400
}

# --- Download ----------------------------------------------------------------
New-Item -ItemType Directory -Path $Dest -Force | Out-Null
$tmp = Join-Path $env:TEMP "$AppName-$([guid]::NewGuid()).exe"

Write-Step 'Downloading...'
try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp -Headers @{ 'User-Agent' = 'ainw-installer' }
} catch {
    throw "Download failed. $($_.Exception.Message)"
}

if ((Get-Item $tmp).Length -lt 1MB) {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
    throw 'The downloaded file is too small to be valid. Try again.'
}

Move-Item -Path $tmp -Destination $Exe -Force
# Clear the mark-of-the-web so SmartScreen does not block the scheduled runs.
Unblock-File -Path $Exe -ErrorAction SilentlyContinue
Write-Ok "Installed to $Exe"

# --- PATH --------------------------------------------------------------------
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$Dest*") {
    Write-Step 'Adding to your PATH...'
    $newPath = if ([string]::IsNullOrEmpty($userPath)) { $Dest } else { "$userPath;$Dest" }
    [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    Write-Ok 'Added (open a new terminal to use the command there).'
}
$env:Path = "$env:Path;$Dest"

# --- Start -------------------------------------------------------------------
if ($env:AINW_NO_START -eq '1') {
    Write-Host ""
    Write-Warn 'Skipped starting the schedule (AINW_NO_START=1).'
    Write-Host "  Start it later with:  $AppName start"
} else {
    Write-Host ""
    Write-Step 'Setting your wallpaper and starting the hourly refresh...'
    Write-Host ""
    & $Exe start
}

Write-Host ""
Write-Host "  ----------------------------------------"
Write-Host "  Done." -ForegroundColor Green
Write-Host ""
Write-Host "  $AppName status     see the schedule and settings"
Write-Host "  $AppName setup      add your name, link Gmail + Calendar"
Write-Host "  $AppName --help     everything else"
Write-Host "  $AppName stop       turn the automatic refresh off"
Write-Host ""
