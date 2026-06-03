$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

$HostName = "127.0.0.1"
$Port = 5050
$AppUrl = "http://${HostName}:${Port}"

function Test-AppReady {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "$AppUrl/api/meta" -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch {
        return $false
    }
}

function Get-PythonCommand {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        return @("py", "-3")
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return @("python")
    }
    throw "Python was not found. Please install Python 3.10 or newer."
}

if (Test-AppReady) {
    Write-Host "Dashboard is already running: $AppUrl"
    Start-Process $AppUrl
    exit 0
}

$venvPython = Join-Path $PSScriptRoot ".venv\Scripts\python.exe"

if (-not (Test-Path $venvPython)) {
    $pythonCommand = Get-PythonCommand
    Write-Host "Creating local Python environment..."
    if ($pythonCommand.Count -eq 2) {
        & $pythonCommand[0] $pythonCommand[1] -m venv .venv
    } else {
        & $pythonCommand[0] -m venv .venv
    }
}

$requirements = Join-Path $PSScriptRoot "requirements.txt"
$dependencyStamp = Join-Path $PSScriptRoot ".venv\.deps_installed"
$needsInstall = -not (Test-Path $dependencyStamp)
if (-not $needsInstall) {
    $needsInstall = (Get-Item $requirements).LastWriteTimeUtc -gt (Get-Item $dependencyStamp).LastWriteTimeUtc
}

if ($needsInstall) {
    Write-Host "Installing/checking dependencies..."
    & $venvPython -m pip install --upgrade pip
    & $venvPython -m pip install -r requirements.txt
    New-Item -ItemType File -Force -Path $dependencyStamp | Out-Null
} else {
    Write-Host "Dependencies are ready."
}

Write-Host "Starting local dashboard..."
& $venvPython app.py
