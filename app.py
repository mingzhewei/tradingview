from __future__ import annotations

import json
import logging
import queue
import threading
import time
import webbrowser
from pathlib import Path
from typing import Any

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

import data_source

BASE_DIR = Path(__file__).resolve().parent
LOG_DIR = BASE_DIR / "logs"
LOG_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    handlers=[
        logging.FileHandler(LOG_DIR / "app.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
LOGGER = logging.getLogger(__name__)

app = Flask(__name__, static_folder="static", static_url_path="/static")


def _sse(event: str, payload: dict[str, Any]) -> str:
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    return f"event: {event}\ndata: {data}\n\n"


def _parse_limit() -> int:
    try:
        limit = int(request.args.get("limit", "300"))
    except ValueError:
        limit = 300
    return max(30, min(limit, 800))


@app.get("/")
def index() -> Response:
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/meta")
def meta() -> Response:
    return jsonify(
        {
            "instruments": data_source.get_instruments(),
            "intervals": data_source.get_intervals(),
            "defaultPanels": data_source.get_default_panels(),
        }
    )


@app.get("/api/history")
def history() -> tuple[Response, int] | Response:
    source = request.args.get("source", "")
    symbol = request.args.get("symbol", "")
    interval = request.args.get("interval", "1m")
    limit = _parse_limit()
    if not source or not symbol:
        return jsonify({"error": "缺少 source 或 symbol 参数"}), 400

    try:
        bars = data_source.fetch_history(source, symbol, interval, limit)
    except data_source.DataSourceError as exc:
        LOGGER.warning("历史数据失败: %s", exc)
        return jsonify({"error": str(exc)}), 502
    except Exception as exc:
        LOGGER.exception("历史数据异常")
        return jsonify({"error": f"历史数据异常: {exc}"}), 500

    return jsonify({"bars": bars})


def _stream_hyperliquid(symbol: str, interval: str):
    subscription = data_source.get_data_source("hyperliquid")["stream"](symbol, interval)
    yield _sse("status", {"message": "正在接入 Hyperliquid WebSocket"})
    try:
        while True:
            try:
                item = subscription.get(timeout=18)
            except queue.Empty:
                yield ": keepalive\n\n"
                continue

            if item.get("kind") == "bar":
                yield _sse("bar", {"bar": item["bar"]})
            elif item.get("kind") == "warning":
                yield _sse("warning", {"message": item.get("message", "连接异常")})
            else:
                yield _sse("status", {"message": item.get("message", "已连接")})
    finally:
        subscription.close()


def _stream_polling(source: str, symbol: str, interval: str):
    provider = data_source.get_data_source(source)
    latest_func = provider.get("latest")
    if latest_func is None:
        yield _sse("warning", {"message": f"{source} 未提供实时流或轮询函数"})
        return

    poll_seconds = data_source.INTERVALS[interval]["poll_seconds"]
    last_signature: tuple[int, float] | None = None
    yield _sse("status", {"message": "正在轮询 yfinance"})
    while True:
        try:
            bar = latest_func(symbol, interval)
            if bar is not None:
                signature = (int(bar["time"]), float(bar["close"]))
                if signature != last_signature:
                    last_signature = signature
                    yield _sse("bar", {"bar": bar})
        except data_source.DataSourceError as exc:
            yield _sse("warning", {"message": str(exc)})
        except Exception as exc:
            LOGGER.exception("轮询数据异常")
            yield _sse("warning", {"message": f"轮询数据异常: {exc}"})
        time.sleep(poll_seconds)


@app.get("/api/stream")
def stream() -> tuple[Response, int] | Response:
    source = request.args.get("source", "")
    symbol = request.args.get("symbol", "")
    interval = request.args.get("interval", "1m")
    if not source or not symbol:
        return jsonify({"error": "缺少 source 或 symbol 参数"}), 400
    if interval not in data_source.INTERVALS:
        return jsonify({"error": f"不支持的周期: {interval}"}), 400

    def generator():
        try:
            if source == "hyperliquid":
                yield from _stream_hyperliquid(symbol, interval)
            else:
                yield from _stream_polling(source, symbol, interval)
        except GeneratorExit:
            raise
        except Exception as exc:
            LOGGER.exception("实时流异常")
            yield _sse("warning", {"message": f"实时流异常: {exc}"})

    headers = {
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return Response(stream_with_context(generator()), mimetype="text/event-stream", headers=headers)


def open_browser_later(host: str, port: int) -> None:
    def opener() -> None:
        webbrowser.open(f"http://{host}:{port}")

    threading.Timer(1.2, opener).start()


if __name__ == "__main__":
    host = "127.0.0.1"
    port = 5050
    open_browser_later(host, port)
    print(f"本地交易图表已启动: http://{host}:{port}")
    app.run(host=host, port=port, threaded=True, use_reloader=False)
