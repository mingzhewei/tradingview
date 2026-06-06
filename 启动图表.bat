@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem 优先使用 Python 启动器 py，其次 python。
where py >nul 2>nul
if %errorlevel%==0 (
    py -3 launch.py
    goto :done
)

where python >nul 2>nul
if %errorlevel%==0 (
    python launch.py
    goto :done
)

echo 未找到 Python。请先安装 Python 3.10 或更高版本（https://www.python.org/downloads/）。
echo 安装时请勾选 "Add Python to PATH"。
pause
exit /b 1

:done
if errorlevel 1 pause
