#!/usr/bin/env python3
"""跨平台启动器：Windows 10 / macOS / Linux 通用。

职责：
1. 在项目目录下创建本地虚拟环境 .venv（如不存在）。
2. 按 requirements.txt 安装/更新依赖（用时间戳避免每次重装）。
3. 如果服务已在运行，直接打开浏览器。
4. 否则用 venv 内的 Python 启动 app.py。

可直接 `python launch.py` 运行；Windows 与 macOS 的双击启动器都会调用本脚本。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
VENV_DIR = BASE_DIR / ".venv"
REQUIREMENTS = BASE_DIR / "requirements.txt"
DEP_STAMP = VENV_DIR / ".deps_installed"
APP = BASE_DIR / "app.py"

HOST = "127.0.0.1"
PORT = 5050
APP_URL = f"http://{HOST}:{PORT}"

MIN_PYTHON = (3, 10)


def venv_python() -> Path:
    """venv 内 Python 解释器路径（按平台区分）。"""
    if os.name == "nt":
        return VENV_DIR / "Scripts" / "python.exe"
    return VENV_DIR / "bin" / "python"


def is_running() -> bool:
    """检测服务是否已在监听端口。"""
    try:
        with urllib.request.urlopen(f"{APP_URL}/api/meta", timeout=2) as response:
            return response.status == 200
    except (urllib.error.URLError, OSError, ValueError):
        return False


def check_python_version() -> None:
    if sys.version_info < MIN_PYTHON:
        need = ".".join(str(part) for part in MIN_PYTHON)
        have = ".".join(str(part) for part in sys.version_info[:3])
        print(f"当前 Python 为 {have}，将尝试查找 Python {need}+ 用于创建虚拟环境。")


def _interpreter_version_ok(executable: str) -> bool:
    """运行候选解释器，确认其版本满足 MIN_PYTHON。"""
    try:
        result = subprocess.run(
            [executable, "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    try:
        major, minor = (int(part) for part in result.stdout.strip().split("."))
    except ValueError:
        return False
    return (major, minor) >= MIN_PYTHON


def find_suitable_python() -> str:
    """查找满足最低版本要求的 Python 解释器。

    顺序：当前解释器 -> Windows 的 py 启动器 -> PATH 中常见的 pythonX.Y 名称。
    """
    if sys.version_info >= MIN_PYTHON:
        return sys.executable

    candidates: list[str] = []

    # Windows 的 py 启动器可直接定位高版本解释器。
    if os.name == "nt":
        launcher = shutil.which("py")
        if launcher and _py_launcher_has_version(launcher):
            return f"{launcher}|-3"

    # 从高到低尝试带版本号的解释器名（覆盖 3.10~3.14）。
    for minor in range(14, MIN_PYTHON[1] - 1, -1):
        candidates.append(f"python3.{minor}")
    candidates.extend(["python3", "python"])

    seen: set[str] = set()
    for name in candidates:
        resolved = shutil.which(name)
        if not resolved or resolved in seen:
            continue
        seen.add(resolved)
        if _interpreter_version_ok(resolved):
            return resolved

    need = ".".join(str(part) for part in MIN_PYTHON)
    sys.exit(
        f"未找到 Python {need} 或更高版本。\n"
        f"请从 https://www.python.org/downloads/ 安装后重试。"
    )


def _py_launcher_has_version(launcher: str) -> bool:
    """检查 Windows py 启动器是否能提供满足版本的解释器。"""
    target = f"-3.{MIN_PYTHON[1]}"
    try:
        result = subprocess.run(
            [launcher, "-3", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    if result.returncode != 0:
        return False
    try:
        major, minor = (int(part) for part in result.stdout.strip().split("."))
    except ValueError:
        return False
    return (major, minor) >= MIN_PYTHON


def _build_venv_command(python_spec: str) -> list[str]:
    """将解释器标记（可能带 |-3 形式的 py 启动器参数）拆为命令列表。"""
    if "|" in python_spec:
        parts = python_spec.split("|")
        return [parts[0], *parts[1:]]
    return [python_spec]


def ensure_venv() -> Path:
    python = venv_python()
    if python.exists():
        if _interpreter_version_ok(str(python)):
            return python
        # 已存在的 venv 版本过低（例如用旧 Python 误建），重建之。
        need = ".".join(str(part) for part in MIN_PYTHON)
        print(f"现有 .venv 的 Python 版本低于 {need}，将重新创建 ...")
        shutil.rmtree(VENV_DIR, ignore_errors=True)
    base_python = find_suitable_python()
    print("正在创建本地 Python 虚拟环境 (.venv) ...")
    try:
        subprocess.run(
            [*_build_venv_command(base_python), "-m", "venv", str(VENV_DIR)],
            check=True,
        )
    except subprocess.CalledProcessError as exc:
        sys.exit(f"创建虚拟环境失败：{exc}")
    if not python.exists():
        sys.exit("虚拟环境创建后未找到 Python 解释器，请检查 Python 安装是否完整。")
    return python


def dependencies_need_install() -> bool:
    if not DEP_STAMP.exists():
        return True
    try:
        return REQUIREMENTS.stat().st_mtime > DEP_STAMP.stat().st_mtime
    except OSError:
        return True


def install_dependencies(python: Path) -> None:
    if not dependencies_need_install():
        print("依赖已就绪。")
        return
    print("正在安装/检查依赖 ...")
    try:
        subprocess.run([str(python), "-m", "pip", "install", "--upgrade", "pip"], check=True)
        subprocess.run([str(python), "-m", "pip", "install", "-r", str(REQUIREMENTS)], check=True)
    except subprocess.CalledProcessError as exc:
        sys.exit(f"安装依赖失败：{exc}")
    DEP_STAMP.write_text("ok", encoding="utf-8")


def run_app(python: Path) -> int:
    print(f"正在启动本地交易图表 ... {APP_URL}")
    # app.py 自身会在启动后约 1.2 秒打开浏览器，这里不重复打开。
    try:
        completed = subprocess.run([str(python), str(APP)], cwd=str(BASE_DIR))
        return completed.returncode
    except KeyboardInterrupt:
        return 0


def main() -> int:
    os.chdir(BASE_DIR)

    if is_running():
        print(f"仪表盘已在运行：{APP_URL}")
        webbrowser.open(APP_URL)
        return 0

    check_python_version()
    python = ensure_venv()
    install_dependencies(python)
    return run_app(python)


if __name__ == "__main__":
    sys.exit(main())
