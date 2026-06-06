#!/usr/bin/env bash
# macOS / Linux 双击启动器。
# macOS: 双击本文件即可（首次可能需要在“访达”里右键→打开，或执行 chmod +x）。
set -euo pipefail

# 切换到脚本所在目录，确保相对路径正确。
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# 优先使用 python3，其次 python。
if command -v python3 >/dev/null 2>&1; then
    PYTHON=python3
elif command -v python >/dev/null 2>&1; then
    PYTHON=python
else
    echo "未找到 Python。请先安装 Python 3.10 或更高版本（https://www.python.org/downloads/）。"
    read -r -p "按回车键退出..." _
    exit 1
fi

"$PYTHON" launch.py
status=$?

# 出错时暂停，方便在终端窗口看到错误信息。
if [ $status -ne 0 ]; then
    echo "启动失败（退出码 $status）。"
    read -r -p "按回车键退出..." _
fi
exit $status
