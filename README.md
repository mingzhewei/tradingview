# 实时多图表交易仪表盘

本项目是本地运行的 Flask + 原生 HTML/CSS/JS Web 应用，用 Lightweight Charts 显示最多 8 个实时交易图表。

## 运行方式

本项目可在 Windows 10、macOS、Linux 上运行，需要预先安装 Python 3.10 或更高版本（[下载地址](https://www.python.org/downloads/)，Windows 安装时请勾选 “Add Python to PATH”）。

- Windows：双击 `启动图表.bat`。
- macOS：双击 `启动图表.command`（首次若提示无法打开，右键→打开，或在终端执行一次 `chmod +x 启动图表.command`）。
- 任意平台（含 Linux）：在项目目录执行 `python launch.py`（或 `python3 launch.py`）。

启动器会自动完成：创建本地虚拟环境 `.venv`、安装 `requirements.txt` 依赖、启动 Flask，并打开浏览器访问 `http://127.0.0.1:5050`。若系统默认的 `python3` 版本低于 3.10，`launch.py` 会自动查找更高版本（如 `python3.12`、Windows 的 `py -3`）来创建环境。再次启动时如服务已在运行，会直接打开浏览器。

## 数据源说明

- 加密货币：Hyperliquid WebSocket 实时 candle，并用 `candleSnapshot` 拉取历史 K 线。
- 股票/ETF：中国股票、美股、印度股票使用 yfinance 从 Yahoo Finance 获取数据，通过 Flask 后端轮询桥接给浏览器。
- yfinance 数据不是交易所级低延迟实时数据，分钟级数据也受 Yahoo Finance 可用周期限制；此项目按本地研究和看盘工具设计。

## 已内置功能

- 图表数量：1、2、4、6、8，刷新后自动记住上次选择。
- 布局：1 全屏，2 左右，4 为 2x2，6 为 3x2，8 为 4x2，并在小屏自动改为更易读的列数。
- 每个图表独立选择交易品种和周期：1m、5m、15m、1h、4h、1d。
- 同品种联动：默认开启。多个面板选择同一个 `source + symbol` 时，鼠标在一个主图移动，其他同品种面板如果当前可视范围覆盖对应时间，会同步显示十字光标；不同周期会自动匹配到覆盖该时间的 K 线。
- 图表级回放回测：可用日期选择器、时间选择器、精确时间输入，或直接在图上点击某根 K 线设置历史截止时间；应用后隐藏后续 K 线，可逐根前进、自动播放、调节速度和重置。这个功能等同于图表 Bar Replay，用于手工复盘和视觉回测，不是策略撮合/PnL 统计引擎。
- 绘图工具：趋势线、水平线、矩形、文字、斐波那契回撤/扩展比例、撤销和清除。绘图按面板保存，并随图表缩放/滚动重绘。
- 指标：Fair Value Gaps、Volume Profile POC/VA、自动趋势线、自动形态识别、支撑压力热力图、成交量、SMA/EMA/WMA/HMA/SMMA、VWMA、VWAP、布林带、Keltner、Donchian、均线包络、Ichimoku、Supertrend、Chandelier Exit、Parabolic SAR、Zig Zag、Williams Fractals、RSI、Stochastic、Stoch RSI、CCI、MFI、Williams %R、ROC、Momentum、MACD、Awesome Oscillator、ADX/DMI、Aroon、Ultimate Oscillator、CMO、Fisher、TSI、TRIX、PPO、DPO、KST、Balance of Power、ATR、标准差、历史波动率、布林带宽度、布林%B、Choppiness Index、Vortex、Mass Index、Ulcer Index、OBV、Accum/Dist、Chaikin Money Flow、Chaikin Oscillator、Elder Force Index、PVT、NVI、PVI、Volume Oscillator、Ease of Movement。

## 自动结构识别说明

`自动趋势线`、`自动形态识别`、`支撑压力热力图` 是基于 TrendSpider 公开文档描述和通用技术分析规则实现的本地近似版本，不是 TrendSpider 专有算法复刻。

- 自动趋势线：用分形/反应高低点作为基础点，生成候选支撑/压力线，按触碰次数、突破次数、近期性评分。
- 自动形态识别：基于近端 pivot 序列识别双顶/双底、头肩顶/底、上升/下降/收敛三角形、上升/下降通道。
- 支撑压力热力图：按当前可视区间价格分桶，统计红绿 K 的关键高低点、pivot 触碰和成交量权重，绘制水平热区。

这些工具适合辅助复盘和筛选潜在结构，不能作为确定性交易信号。

- 价格栏：价格变化时按涨跌闪烁绿色或红色。

## 扩展数据源

所有数据源统一在 `data_source.py` 注册。新增供应商时，实现一个历史函数，并按需要提供 `latest` 轮询函数或 `stream` 订阅函数：

```python
def fetch_new_broker_history(symbol: str, interval: str, limit: int):
    return [
        {"time": 1710000000, "open": 1.0, "high": 1.2, "low": 0.9, "close": 1.1, "volume": 1000}
    ]

register_data_source("new_broker", history=fetch_new_broker_history)
```

前端下拉品种来自 `INSTRUMENTS`，添加新品种时补一条 `source`、`symbol`、`label` 即可。

## 扩展指标

指标统一注册在 `static/indicator_engine.js`，前端面板只读取注册表，不再写死具体公式。

最小接口：

```javascript
registerIndicator({
  key: "my_indicator",
  label: "我的指标",
  category: "动量",
  defaultOn: false,
  series: [
    {
      id: "line",
      pane: "momentum", // main / momentum / macd / trend / volume / volatility
      type: "LineSeries",
      options: { color: "#20c7b1", lineWidth: 1, priceLineVisible: false },
    },
  ],
  calculate(bars, context) {
    return {
      series: {
        line: bars.map((bar) => ({ time: bar.time, value: bar.close })),
      },
    };
  },
});
```

需要 HTML 覆盖层的指标可以额外实现 `renderOverlay(panel, result)`，例如 FVG、Volume Profile、Fractals。`bars` 统一使用 `{ time, open, high, low, close, volume }`，`time` 是 epoch 秒。
