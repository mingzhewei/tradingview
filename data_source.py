"""Pluggable market data sources for the local chart dashboard.

New providers can be added with register_data_source(). A provider needs a
history function, and can optionally provide either a streaming subscriber or a
latest-bar function for polling.
"""

from __future__ import annotations

import json
import logging
import queue
import threading
import time
from dataclasses import dataclass
from typing import Any, Callable

import pandas as pd
import requests
import websocket
import yfinance as yf

LOGGER = logging.getLogger(__name__)

HYPERLIQUID_INFO_URL = "https://api.hyperliquid.xyz/info"
HYPERLIQUID_WS_URL = "wss://api.hyperliquid.xyz/ws"


class DataSourceError(RuntimeError):
    """Raised when a provider cannot return usable market data."""


INTERVALS: dict[str, dict[str, Any]] = {
    "1m": {
        "label": "1分钟",
        "seconds": 60,
        "hyperliquid": "1m",
        "yfinance_interval": "1m",
        "yfinance_period": "1d",
        "poll_seconds": 12,
    },
    "5m": {
        "label": "5分钟",
        "seconds": 300,
        "hyperliquid": "5m",
        "yfinance_interval": "5m",
        "yfinance_period": "5d",
        "poll_seconds": 20,
    },
    "15m": {
        "label": "15分钟",
        "seconds": 900,
        "hyperliquid": "15m",
        "yfinance_interval": "15m",
        "yfinance_period": "1mo",
        "poll_seconds": 30,
    },
    "1h": {
        "label": "1小时",
        "seconds": 3600,
        "hyperliquid": "1h",
        "yfinance_interval": "1h",
        "yfinance_period": "1mo",
        "poll_seconds": 60,
    },
    "4h": {
        "label": "4小时",
        "seconds": 14400,
        "hyperliquid": "4h",
        "yfinance_interval": "1h",
        "yfinance_period": "1mo",
        "resample": "4h",
        "poll_seconds": 90,
    },
    "1d": {
        "label": "日线",
        "seconds": 86400,
        "hyperliquid": "1d",
        "yfinance_interval": "1d",
        "yfinance_period": "1y",
        "poll_seconds": 180,
    },
}


INSTRUMENTS: list[dict[str, str]] = [
    {"id": "hl:BTC", "source": "hyperliquid", "symbol": "BTC", "label": "BTC 永续", "market": "加密货币"},
    {"id": "hl:ETH", "source": "hyperliquid", "symbol": "ETH", "label": "ETH 永续", "market": "加密货币"},
    {"id": "hl:SOL", "source": "hyperliquid", "symbol": "SOL", "label": "SOL 永续", "market": "加密货币"},
    {"id": "hl:HYPE", "source": "hyperliquid", "symbol": "HYPE", "label": "HYPE 永续", "market": "加密货币"},
    {"id": "yf:AAPL", "source": "yfinance", "symbol": "AAPL", "label": "Apple AAPL", "market": "美股/ETF"},
    {"id": "yf:MSFT", "source": "yfinance", "symbol": "MSFT", "label": "Microsoft MSFT", "market": "美股/ETF"},
    {"id": "yf:NVDA", "source": "yfinance", "symbol": "NVDA", "label": "NVIDIA NVDA", "market": "美股/ETF"},
    {"id": "yf:TSLA", "source": "yfinance", "symbol": "TSLA", "label": "Tesla TSLA", "market": "美股/ETF"},
    {"id": "yf:SPY", "source": "yfinance", "symbol": "SPY", "label": "标普500 ETF SPY", "market": "美股/ETF"},
    {"id": "yf:QQQ", "source": "yfinance", "symbol": "QQQ", "label": "纳指100 ETF QQQ", "market": "美股/ETF"},
    {"id": "yf:600519.SS", "source": "yfinance", "symbol": "600519.SS", "label": "贵州茅台 600519.SS", "market": "中国股票"},
    {"id": "yf:000001.SZ", "source": "yfinance", "symbol": "000001.SZ", "label": "平安银行 000001.SZ", "market": "中国股票"},
    {"id": "yf:300750.SZ", "source": "yfinance", "symbol": "300750.SZ", "label": "宁德时代 300750.SZ", "market": "中国股票"},
    {"id": "yf:RELIANCE.NS", "source": "yfinance", "symbol": "RELIANCE.NS", "label": "Reliance RELIANCE.NS", "market": "印度股票"},
    {"id": "yf:TCS.NS", "source": "yfinance", "symbol": "TCS.NS", "label": "TCS TCS.NS", "market": "印度股票"},
    {"id": "yf:INFY.NS", "source": "yfinance", "symbol": "INFY.NS", "label": "Infosys INFY.NS", "market": "印度股票"},
]

DEFAULT_PANEL_IDS = [
    "hl:BTC",
    "hl:ETH",
    "yf:AAPL",
    "yf:NVDA",
    "hl:SOL",
    "yf:600519.SS",
    "yf:RELIANCE.NS",
    "yf:SPY",
]


HistoryFunc = Callable[[str, str, int], list[dict[str, float | int]]]
LatestFunc = Callable[[str, str], dict[str, float | int] | None]
StreamFunc = Callable[[str, str], "StreamSubscription"]

DATA_SOURCE_REGISTRY: dict[str, dict[str, Any]] = {}


def register_data_source(
    name: str,
    *,
    history: HistoryFunc,
    latest: LatestFunc | None = None,
    stream: StreamFunc | None = None,
) -> None:
    """Register a data provider.

    history(symbol, interval, limit) must return OHLCV bars using epoch-second
    timestamps. latest(symbol, interval) is used for polling providers, while
    stream(symbol, interval) is used for push providers.
    """

    DATA_SOURCE_REGISTRY[name] = {
        "history": history,
        "latest": latest,
        "stream": stream,
    }


def get_data_source(name: str) -> dict[str, Any]:
    try:
        return DATA_SOURCE_REGISTRY[name]
    except KeyError as exc:
        raise DataSourceError(f"未知数据源: {name}") from exc


def get_intervals() -> list[dict[str, str]]:
    return [{"value": key, "label": value["label"]} for key, value in INTERVALS.items()]


def get_instruments() -> list[dict[str, str]]:
    return INSTRUMENTS


def get_default_panels() -> list[dict[str, Any]]:
    defaults: list[dict[str, Any]] = []
    lookup = {item["id"]: item for item in INSTRUMENTS}
    for item_id in DEFAULT_PANEL_IDS:
        item = lookup[item_id]
        defaults.append(
            {
                "instrumentId": item_id,
                "source": item["source"],
                "symbol": item["symbol"],
                "interval": "1m",
            }
        )
    return defaults


def _to_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if pd.isna(number):
        return None
    return number


def _normalize_yfinance_df(df: pd.DataFrame, limit: int) -> list[dict[str, float | int]]:
    if df is None or df.empty:
        return []

    normalized = df.copy()
    if isinstance(normalized.columns, pd.MultiIndex):
        normalized.columns = [str(column[0]) for column in normalized.columns]

    column_map = {str(column).lower().replace(" ", ""): column for column in normalized.columns}
    required = {
        "open": column_map.get("open"),
        "high": column_map.get("high"),
        "low": column_map.get("low"),
        "close": column_map.get("close"),
        "volume": column_map.get("volume"),
    }
    if any(required[key] is None for key in ("open", "high", "low", "close")):
        return []

    normalized = normalized.sort_index()
    records: list[dict[str, float | int]] = []
    for timestamp, row in normalized.iterrows():
        open_price = _to_float(row[required["open"]])
        high = _to_float(row[required["high"]])
        low = _to_float(row[required["low"]])
        close = _to_float(row[required["close"]])
        if open_price is None or high is None or low is None or close is None:
            continue
        volume = _to_float(row[required["volume"]]) if required["volume"] is not None else 0.0
        ts = pd.Timestamp(timestamp)
        if ts.tzinfo is None:
            ts = ts.tz_localize("UTC")
        records.append(
            {
                "time": int(ts.timestamp()),
                "open": open_price,
                "high": high,
                "low": low,
                "close": close,
                "volume": volume or 0.0,
            }
        )
    return records[-limit:]


def _resample_ohlcv(df: pd.DataFrame, rule: str) -> pd.DataFrame:
    if df is None or df.empty:
        return df
    working = df.copy()
    if isinstance(working.columns, pd.MultiIndex):
        working.columns = [str(column[0]) for column in working.columns]
    columns = {str(column).lower().replace(" ", ""): column for column in working.columns}
    rename = {
        columns.get("open"): "Open",
        columns.get("high"): "High",
        columns.get("low"): "Low",
        columns.get("close"): "Close",
        columns.get("volume"): "Volume",
    }
    rename = {old: new for old, new in rename.items() if old is not None}
    working = working.rename(columns=rename)
    if not {"Open", "High", "Low", "Close"}.issubset(working.columns):
        return working
    if "Volume" not in working.columns:
        working["Volume"] = 0.0
    return (
        working.sort_index()
        # Label each resampled bar by its open (left edge) so 4h timestamps match
        # the open-time convention used by 1h/1d and Hyperliquid candles. This keeps
        # cross-interval crosshair sync (findBarCoveringTime) accurate.
        .resample(rule, label="left", closed="left")
        .agg({"Open": "first", "High": "max", "Low": "min", "Close": "last", "Volume": "sum"})
        .dropna(subset=["Open", "High", "Low", "Close"])
    )


def _download_yfinance(symbol: str, interval: str, period: str) -> pd.DataFrame:
    ticker = yf.Ticker(symbol)
    df = ticker.history(period=period, interval=interval, auto_adjust=False, prepost=False)
    if df is not None and not df.empty:
        return df
    fallback = yf.download(
        symbol,
        period=period,
        interval=interval,
        progress=False,
        auto_adjust=False,
        prepost=False,
        threads=False,
        timeout=12,
        multi_level_index=False,
    )
    return fallback if fallback is not None else pd.DataFrame()


def fetch_yfinance_history(symbol: str, interval: str, limit: int = 300) -> list[dict[str, float | int]]:
    spec = INTERVALS.get(interval)
    if spec is None:
        raise DataSourceError(f"不支持的周期: {interval}")

    df = _download_yfinance(symbol, spec["yfinance_interval"], spec["yfinance_period"])
    if spec.get("resample"):
        df = _resample_ohlcv(df, spec["resample"])

    bars = _normalize_yfinance_df(df, limit)
    if not bars:
        raise DataSourceError(f"yfinance 暂无可用数据: {symbol} / {interval}")
    return bars


def fetch_yfinance_latest(symbol: str, interval: str) -> dict[str, float | int] | None:
    bars = fetch_yfinance_history(symbol, interval, limit=3)
    return bars[-1] if bars else None


def _normalize_hyperliquid_candle(raw: dict[str, Any]) -> dict[str, float | int] | None:
    time_ms = raw.get("t", raw.get("time"))
    open_price = _to_float(raw.get("o", raw.get("open")))
    high = _to_float(raw.get("h", raw.get("high")))
    low = _to_float(raw.get("l", raw.get("low")))
    close = _to_float(raw.get("c", raw.get("close")))
    volume = _to_float(raw.get("v", raw.get("volume")))
    if time_ms is None or open_price is None or high is None or low is None or close is None:
        return None
    return {
        "time": int(int(time_ms) / 1000),
        "open": open_price,
        "high": high,
        "low": low,
        "close": close,
        "volume": volume or 0.0,
    }


def fetch_hyperliquid_history(symbol: str, interval: str, limit: int = 300) -> list[dict[str, float | int]]:
    spec = INTERVALS.get(interval)
    if spec is None:
        raise DataSourceError(f"不支持的周期: {interval}")

    now_ms = int(time.time() * 1000)
    lookback = min(max(limit * 3, limit + 10), 5000) * spec["seconds"] * 1000
    payload = {
        "type": "candleSnapshot",
        "req": {
            "coin": symbol,
            "interval": spec["hyperliquid"],
            "startTime": now_ms - lookback,
            "endTime": now_ms,
        },
    }
    try:
        response = requests.post(HYPERLIQUID_INFO_URL, json=payload, timeout=12)
        response.raise_for_status()
        raw_data = response.json()
    except requests.RequestException as exc:
        raise DataSourceError(f"Hyperliquid 历史数据请求失败: {exc}") from exc
    except ValueError as exc:
        raise DataSourceError("Hyperliquid 返回了非 JSON 数据") from exc

    if isinstance(raw_data, dict) and "error" in raw_data:
        raise DataSourceError(f"Hyperliquid 错误: {raw_data['error']}")
    if not isinstance(raw_data, list):
        raise DataSourceError("Hyperliquid candleSnapshot 返回格式异常")

    bars = [
        bar
        for bar in (_normalize_hyperliquid_candle(item) for item in raw_data if isinstance(item, dict))
        if bar is not None
    ]
    if not bars:
        raise DataSourceError(f"Hyperliquid 暂无可用数据: {symbol} / {interval}")
    return bars[-limit:]


@dataclass
class StreamSubscription:
    stream: "_HyperliquidCandleStream"
    queue: queue.Queue

    def get(self, timeout: float) -> dict[str, Any]:
        return self.queue.get(timeout=timeout)

    def close(self) -> None:
        self.stream.remove_subscriber(self.queue)


class _HyperliquidCandleStream:
    def __init__(self, symbol: str, interval: str) -> None:
        self.symbol = symbol.upper()
        self.interval = interval
        self.subscription_interval = INTERVALS[interval]["hyperliquid"]
        self._subscribers: set[queue.Queue] = set()
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._ws: websocket.WebSocketApp | None = None

    def add_subscriber(self) -> StreamSubscription:
        subscriber: queue.Queue = queue.Queue(maxsize=64)
        with self._lock:
            self._subscribers.add(subscriber)
            if self._thread is None or not self._thread.is_alive():
                self._stop.clear()
                self._thread = threading.Thread(target=self._run, name=f"hl-{self.symbol}-{self.interval}", daemon=True)
                self._thread.start()
        return StreamSubscription(self, subscriber)

    def remove_subscriber(self, subscriber: queue.Queue) -> None:
        with self._lock:
            self._subscribers.discard(subscriber)
            should_stop = not self._subscribers
        if should_stop:
            self._stop.set()
            if self._ws is not None:
                try:
                    self._ws.close()
                except Exception:
                    LOGGER.debug("关闭 Hyperliquid WebSocket 失败", exc_info=True)

    def _publish(self, payload: dict[str, Any]) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for subscriber in subscribers:
            try:
                subscriber.put_nowait(payload)
            except queue.Full:
                try:
                    subscriber.get_nowait()
                except queue.Empty:
                    pass
                try:
                    subscriber.put_nowait(payload)
                except queue.Full:
                    pass

    def _on_open(self, ws: websocket.WebSocketApp) -> None:
        message = {
            "method": "subscribe",
            "subscription": {
                "type": "candle",
                "coin": self.symbol,
                "interval": self.subscription_interval,
            },
        }
        ws.send(json.dumps(message))
        self._publish({"kind": "status", "message": "Hyperliquid 已连接"})

    def _on_message(self, _ws: websocket.WebSocketApp, message: str) -> None:
        try:
            data = json.loads(message)
        except json.JSONDecodeError:
            return
        if data.get("channel") == "subscriptionResponse":
            return
        if data.get("channel") != "candle":
            return

        raw = data.get("data")
        candles = raw if isinstance(raw, list) else [raw]
        for item in candles:
            if not isinstance(item, dict):
                continue
            bar = _normalize_hyperliquid_candle(item)
            if bar is not None:
                self._publish({"kind": "bar", "bar": bar})

    def _on_error(self, _ws: websocket.WebSocketApp, error: Exception) -> None:
        self._publish({"kind": "warning", "message": f"Hyperliquid 连接异常: {error}"})

    def _on_close(self, _ws: websocket.WebSocketApp, _status: int, _message: str) -> None:
        self._publish({"kind": "status", "message": "Hyperliquid 已断开，准备重连"})

    def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            self._ws = websocket.WebSocketApp(
                HYPERLIQUID_WS_URL,
                on_open=self._on_open,
                on_message=self._on_message,
                on_error=self._on_error,
                on_close=self._on_close,
            )
            try:
                self._ws.run_forever(ping_interval=25, ping_timeout=10)
            except Exception as exc:
                self._publish({"kind": "warning", "message": f"Hyperliquid 重连中: {exc}"})
            if self._stop.wait(backoff):
                break
            backoff = min(backoff * 1.6, 12.0)
        self._ws = None


class HyperliquidHub:
    def __init__(self) -> None:
        self._streams: dict[tuple[str, str], _HyperliquidCandleStream] = {}
        self._lock = threading.Lock()

    def subscribe(self, symbol: str, interval: str) -> StreamSubscription:
        if interval not in INTERVALS:
            raise DataSourceError(f"不支持的周期: {interval}")
        key = (symbol.upper(), interval)
        with self._lock:
            stream = self._streams.get(key)
            if stream is None:
                stream = _HyperliquidCandleStream(symbol, interval)
                self._streams[key] = stream
        return stream.add_subscriber()


HYPERLIQUID_HUB = HyperliquidHub()


def subscribe_hyperliquid_candles(symbol: str, interval: str) -> StreamSubscription:
    return HYPERLIQUID_HUB.subscribe(symbol, interval)


def fetch_history(source: str, symbol: str, interval: str, limit: int = 300) -> list[dict[str, float | int]]:
    provider = get_data_source(source)
    return provider["history"](symbol, interval, limit)


register_data_source(
    "hyperliquid",
    history=fetch_hyperliquid_history,
    stream=subscribe_hyperliquid_candles,
)
register_data_source(
    "yfinance",
    history=fetch_yfinance_history,
    latest=fetch_yfinance_latest,
)
