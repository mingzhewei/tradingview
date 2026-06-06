$ErrorActionPreference = "Stop"

Set-Location $PSScriptRoot

# 统一的启动逻辑集中在 launch.py，这里只负责找��� Python 并调用它。
function Get-PythonCommand {
    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        return @("py", "-3")
    }
    $python = Get-Command python -ErrorAction SilentlyContinue
    if ($python) {
        return @("python")
    }
    throw "未找到 Python。请安装 Python 3.10 或更高版本（https://www.python.org/downloads/）。"
}

$pythonCommand = Get-PythonCommand
if ($pythonCommand.Count -eq 2) {
    & $pythonCommand[0] $pythonCommand[1] launch.py
} else {
    & $pythonCommand[0] launch.py
}
