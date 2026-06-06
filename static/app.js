const COUNT_STORAGE_KEY = "tw-dashboard-chart-count";
const PANELS_STORAGE_KEY = "tw-dashboard-panel-configs";
const SYNC_STORAGE_KEY = "tw-dashboard-sync-enabled";
const REPLAY_STORAGE_KEY = "tw-dashboard-replay";
const VALID_COUNTS = [1, 2, 4, 6, 8];
const HISTORY_LIMIT = 360;

const IndicatorEngine = window.TWIndicatorEngine;
const INDICATORS = IndicatorEngine.getIndicators();
const LEGACY_INDICATOR_KEYS = {
  ma: "ma20",
  ema: "ema50",
  bb: "bollinger",
};
const INTERVAL_SECONDS = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
};

const dashboard = document.getElementById("dashboard");
const chartCountSelect = document.getElementById("chartCount");
const syncChartsToggle = document.getElementById("syncCharts");
const replayModeToggle = document.getElementById("replayMode");
const replayDateInput = document.getElementById("replayDate");
const replayTimeSelect = document.getElementById("replayTime");
const replayCutoffInput = document.getElementById("replayCutoff");
const replayApplyButton = document.getElementById("replayApply");
const replayPickButton = document.getElementById("replayPick");
const replayStepButton = document.getElementById("replayStep");
const replayPlayButton = document.getElementById("replayPlay");
const replaySpeedSelect = document.getElementById("replaySpeed");
const replayResetButton = document.getElementById("replayReset");
const replayStatus = document.getElementById("replayStatus");
const drawingToolSelect = document.getElementById("drawingTool");
const drawingColorInput = document.getElementById("drawingColor");
const drawingUndoButton = document.getElementById("drawingUndo");
const drawingClearButton = document.getElementById("drawingClear");
const panelTemplate = document.getElementById("panelTemplate");

let meta = null;
let chartCount = 4;
let syncChartsEnabled = true;
let panelConfigs = [];
let activePanels = [];
let isApplyingCrosshairSync = false;
let replayTimer = null;
let replayState = {
  enabled: false,
  cutoff: null,
  playing: false,
  speed: 1,
  pickMode: false,
};
let drawingState = {
  tool: "none",
  color: "#20c7b1",
};
let activeDrawingPanel = null;

function defaultIndicators() {
  return Object.fromEntries(INDICATORS.map((item) => [item.key, item.defaultOn]));
}

function migrateIndicatorConfig(indicators = {}) {
  const migrated = { ...indicators };
  Object.entries(LEGACY_INDICATOR_KEYS).forEach(([oldKey, newKey]) => {
    if (oldKey in migrated && !(newKey in migrated)) {
      migrated[newKey] = migrated[oldKey];
    }
  });
  return migrated;
}

function loadChartCount() {
  const raw = Number(localStorage.getItem(COUNT_STORAGE_KEY));
  return VALID_COUNTS.includes(raw) ? raw : 4;
}

function loadSyncEnabled() {
  return localStorage.getItem(SYNC_STORAGE_KEY) !== "false";
}

function loadReplayState() {
  try {
    const saved = JSON.parse(localStorage.getItem(REPLAY_STORAGE_KEY) || "{}");
    replayState = {
      enabled: Boolean(saved.enabled),
      cutoff: Number.isFinite(Number(saved.cutoff)) ? Number(saved.cutoff) : null,
      playing: false,
      speed: [1, 2, 5, 10].includes(Number(saved.speed)) ? Number(saved.speed) : 1,
      pickMode: false,
    };
  } catch {
    replayState = { enabled: false, cutoff: null, playing: false, speed: 1, pickMode: false };
  }
}

function loadPanelConfigs(defaultPanels) {
  try {
    const saved = JSON.parse(localStorage.getItem(PANELS_STORAGE_KEY) || "[]");
    if (Array.isArray(saved)) {
      panelConfigs = saved;
    }
  } catch {
    panelConfigs = [];
  }

  for (let index = 0; index < 8; index += 1) {
    const fallback = defaultPanels[index % defaultPanels.length];
    const current = panelConfigs[index] || {};
    panelConfigs[index] = {
      instrumentId: current.instrumentId || fallback.instrumentId,
      source: current.source || fallback.source,
      symbol: current.symbol || fallback.symbol,
      interval: current.interval || fallback.interval || "1m",
      indicators: { ...defaultIndicators(), ...migrateIndicatorConfig(current.indicators) },
      drawings: Array.isArray(current.drawings) ? current.drawings : [],
    };
  }
}

function saveState() {
  localStorage.setItem(COUNT_STORAGE_KEY, String(chartCount));
  localStorage.setItem(SYNC_STORAGE_KEY, String(syncChartsEnabled));
  localStorage.setItem(
    REPLAY_STORAGE_KEY,
    JSON.stringify({ enabled: replayState.enabled, cutoff: replayState.cutoff, speed: replayState.speed }),
  );
  localStorage.setItem(PANELS_STORAGE_KEY, JSON.stringify(panelConfigs));
}

function groupedInstruments(instruments) {
  const groups = new Map();
  instruments.forEach((instrument) => {
    if (!groups.has(instrument.market)) {
      groups.set(instrument.market, []);
    }
    groups.get(instrument.market).push(instrument);
  });
  return groups;
}

function addSeries(chart, typeName, options = {}, paneIndex) {
  const lw = window.LightweightCharts;
  if (chart.addSeries && lw && lw[typeName]) {
    if (paneIndex === undefined) {
      return chart.addSeries(lw[typeName], options);
    }
    return chart.addSeries(lw[typeName], options, paneIndex);
  }
  const fallback = {
    CandlestickSeries: "addCandlestickSeries",
    LineSeries: "addLineSeries",
    HistogramSeries: "addHistogramSeries",
  }[typeName];
  return chart[fallback](options);
}

function priceFormat(value) {
  if (!Number.isFinite(value)) return "--";
  if (value >= 1000) return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
  if (value >= 10) return value.toFixed(2);
  if (value >= 1) return value.toFixed(4);
  return value.toFixed(6);
}

function percentFormat(value) {
  if (!Number.isFinite(value)) return "--";
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function debounce(fn, delay = 80) {
  let timer = 0;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

function normalizeTime(time) {
  if (typeof time === "number") return time;
  if (time && typeof time === "object" && "year" in time && "month" in time && "day" in time) {
    return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
  }
  return null;
}

function toDatetimeLocalValue(epochSeconds) {
  if (!Number.isFinite(epochSeconds)) return "";
  const date = new Date(epochSeconds * 1000);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function fromDatetimeLocalValue(value) {
  if (!value) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

function dateValueFromEpoch(epochSeconds) {
  const value = toDatetimeLocalValue(epochSeconds);
  return value ? value.slice(0, 10) : "";
}

function timeValueFromEpoch(epochSeconds) {
  const value = toDatetimeLocalValue(epochSeconds);
  return value ? value.slice(11, 16) : "09:30";
}

function syncReplayInputsFromCutoff() {
  if (!replayState.cutoff) return;
  const datetimeValue = toDatetimeLocalValue(replayState.cutoff);
  replayCutoffInput.value = datetimeValue;
  replayDateInput.value = datetimeValue.slice(0, 10);
  replayTimeSelect.value = datetimeValue.slice(11, 16);
}

function syncCutoffFromDateTimeControls() {
  if (!replayDateInput.value) return null;
  const time = replayTimeSelect.value || "09:30";
  const datetime = `${replayDateInput.value}T${time}`;
  replayCutoffInput.value = datetime;
  return fromDatetimeLocalValue(datetime);
}

function drawingPointKey(point) {
  return `${Math.round(point.time)}:${Number(point.price).toFixed(8)}`;
}

class ChartPanel {
  constructor(index, config) {
    this.index = index;
    this.config = config;
    this.allBars = [];
    this.bars = [];
    this.replayCursor = -1;
    this.drawings = Array.isArray(config.drawings) ? config.drawings : [];
    this.pendingDrawing = null;
    this.previewPoint = null;
    this.eventSource = null;
    this.resizeObserver = null;
    this.indicatorSeries = new Map();
    this.paneCharts = new Map();
    this.paneElements = new Map();
    this.paneLevelLines = [];
    this.priceLines = [];
    this.lastClose = null;
    this.dom = panelTemplate.content.firstElementChild.cloneNode(true);
    this.instrumentSelect = this.dom.querySelector(".instrument-select");
    this.intervalSelect = this.dom.querySelector(".interval-select");
    this.indicatorList = this.dom.querySelector(".indicator-list");
    this.priceStrip = this.dom.querySelector(".price-strip");
    this.priceValue = this.dom.querySelector(".price-value");
    this.priceChange = this.dom.querySelector(".price-change");
    this.statusText = this.dom.querySelector(".status-text");
    this.chartHost = this.dom.querySelector(".chart-host");
    this.fvgLayer = this.dom.querySelector(".fvg-layer");
    this.vpLayer = this.dom.querySelector(".volume-profile-layer");
    this.drawingLayer = this.dom.querySelector(".drawing-layer");
    this.drawingPreviewLayer = this.dom.querySelector(".drawing-preview-layer");
    this.chartWrap = this.dom.querySelector(".chart-wrap");
    this.indicatorPanes = this.dom.querySelector(".indicator-panes");
  }

  mount(parent) {
    this.renderControls();
    parent.appendChild(this.dom);
    this.createCharts();
    this.bindResize();
    this.load();
  }

  destroy() {
    if (this.eventSource) this.eventSource.close();
    if (this.resizeObserver) this.resizeObserver.disconnect();
    try {
      if (this.crosshairMoveHandler) {
        this.chart?.unsubscribeCrosshairMove(this.crosshairMoveHandler);
      }
      if (this.drawingPointerDownHandler) {
        this.chartWrap.removeEventListener("pointerdown", this.drawingPointerDownHandler);
        this.chartWrap.removeEventListener("pointermove", this.drawingPointerMoveHandler);
        this.chartWrap.removeEventListener("pointerleave", this.drawingPointerLeaveHandler);
      }
      this.chart?.remove();
      this.paneCharts.forEach((pane) => pane.chart.remove());
    } catch {
      // Lightweight Charts handles DOM cleanup; ignore late disposal errors.
    }
    this.dom.remove();
  }

  renderControls() {
    this.instrumentSelect.innerHTML = "";
    for (const [market, instruments] of groupedInstruments(meta.instruments)) {
      const group = document.createElement("optgroup");
      group.label = market;
      instruments.forEach((instrument) => {
        const option = document.createElement("option");
        option.value = instrument.id;
        option.textContent = instrument.label;
        option.dataset.source = instrument.source;
        option.dataset.symbol = instrument.symbol;
        group.appendChild(option);
      });
      this.instrumentSelect.appendChild(group);
    }
    this.instrumentSelect.value = this.config.instrumentId;

    this.intervalSelect.innerHTML = "";
    meta.intervals.forEach((interval) => {
      const option = document.createElement("option");
      option.value = interval.value;
      option.textContent = interval.label;
      this.intervalSelect.appendChild(option);
    });
    this.intervalSelect.value = this.config.interval;

    this.indicatorList.innerHTML = "";
    let currentCategory = "";
    INDICATORS.forEach((indicator) => {
      if (indicator.category !== currentCategory) {
        currentCategory = indicator.category;
        const category = document.createElement("div");
        category.className = "indicator-category";
        category.textContent = currentCategory;
        this.indicatorList.appendChild(category);
      }
      const label = document.createElement("label");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(this.config.indicators[indicator.key]);
      checkbox.addEventListener("change", () => {
        this.config.indicators[indicator.key] = checkbox.checked;
        panelConfigs[this.index] = this.config;
        saveState();
        this.updateIndicatorVisibility();
        this.recalculateIndicators();
      });
      label.append(checkbox, document.createTextNode(indicator.label));
      this.indicatorList.appendChild(label);
    });

    this.instrumentSelect.addEventListener("change", () => {
      const option = this.instrumentSelect.selectedOptions[0];
      this.config.instrumentId = option.value;
      this.config.source = option.dataset.source;
      this.config.symbol = option.dataset.symbol;
      panelConfigs[this.index] = this.config;
      saveState();
      this.load();
    });

    this.intervalSelect.addEventListener("change", () => {
      this.config.interval = this.intervalSelect.value;
      panelConfigs[this.index] = this.config;
      saveState();
      this.load();
    });
  }

  chartOptions(height) {
    return {
      height,
      autoSize: true,
      layout: {
        background: { type: "solid", color: "#17191d" },
        textColor: "#c7ced9",
        fontFamily: "Segoe UI, Microsoft YaHei UI, sans-serif",
      },
      grid: {
        vertLines: { color: "#252a33" },
        horzLines: { color: "#252a33" },
      },
      crosshair: {
        mode: window.LightweightCharts?.CrosshairMode?.Normal ?? 0,
      },
      rightPriceScale: {
        borderColor: "#343a46",
        scaleMargins: { top: 0.12, bottom: 0.18 },
      },
      timeScale: {
        borderColor: "#343a46",
        timeVisible: true,
        secondsVisible: false,
      },
    };
  }

  createCharts() {
    const mainHeight = Math.max(180, this.chartHost.clientHeight || 260);
    this.chart = window.LightweightCharts.createChart(this.chartHost, this.chartOptions(mainHeight));
    this.candleSeries = addSeries(this.chart, "CandlestickSeries", {
      upColor: "#22c55e",
      downColor: "#ef5350",
      borderUpColor: "#22c55e",
      borderDownColor: "#ef5350",
      wickUpColor: "#22c55e",
      wickDownColor: "#ef5350",
    });

    this.setupIndicatorSeries();
    this.crosshairMoveHandler = (params) => this.handleCrosshairMove(params);
    this.chart.subscribeCrosshairMove(this.crosshairMoveHandler);
    this.bindDrawingEvents();

    const sync = debounce(() => {
      const range = this.chart.timeScale().getVisibleLogicalRange();
      if (range) {
        this.paneCharts.forEach((pane) => pane.chart.timeScale().setVisibleLogicalRange(range));
      }
      this.drawOverlays();
      this.drawStoredDrawings();
    }, 20);
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(sync);
    this.updateIndicatorVisibility();
  }

  setupIndicatorSeries() {
    INDICATORS.forEach((indicator) => {
      (indicator.series || []).forEach((seriesDef) => {
        const targetChart = seriesDef.pane === "main" ? this.chart : this.ensurePane(seriesDef.pane).chart;
        const series = addSeries(targetChart, seriesDef.type, seriesDef.options || {});
        if (seriesDef.priceScaleOptions && series.priceScale) {
          series.priceScale().applyOptions(seriesDef.priceScaleOptions);
        }
        if (seriesDef.pane !== "main") {
          const pane = this.paneCharts.get(seriesDef.pane);
          if (pane && !pane.levelsCreated) {
            (pane.meta.levels || []).forEach((level) => {
              this.paneLevelLines.push(
                series.createPriceLine({
                  price: level.price,
                  color: level.color,
                  lineWidth: 1,
                  lineStyle: 2,
                  axisLabelVisible: false,
                  title: level.title || "",
                }),
              );
            });
            pane.levelsCreated = true;
          }
        }
        this.indicatorSeries.set(this.seriesKey(indicator.key, seriesDef.id), series);
      });
    });
  }

  ensurePane(paneId) {
    if (this.paneCharts.has(paneId)) {
      return this.paneCharts.get(paneId);
    }

    const meta = IndicatorEngine.getPaneMeta(paneId);
    const pane = document.createElement("div");
    pane.className = "indicator-pane hidden";
    pane.dataset.pane = paneId;
    const host = document.createElement("div");
    host.className = "indicator-pane-host";
    pane.appendChild(host);
    this.indicatorPanes.appendChild(pane);

    const chart = window.LightweightCharts.createChart(host, this.chartOptions(meta.height || 72));
    chart.timeScale().applyOptions({ timeVisible: true, secondsVisible: false });
    this.paneCharts.set(paneId, { chart, host, pane, meta });
    this.paneElements.set(paneId, pane);
    return this.paneCharts.get(paneId);
  }

  seriesKey(indicatorKey, seriesId) {
    return `${indicatorKey}:${seriesId}`;
  }

  indicatorContext() {
    return {
      interval: this.config.interval,
      intervalSeconds: INTERVAL_SECONDS[this.config.interval] || 60,
      visibleRange: this.chart?.timeScale().getVisibleRange(),
    };
  }

  instrumentKey() {
    return `${this.config.source}:${this.config.symbol}`;
  }

  handleCrosshairMove(params) {
    if (!syncChartsEnabled || isApplyingCrosshairSync) return;
    const sourceTime = normalizeTime(params?.time);
    if (!sourceTime) {
      clearLinkedCrosshairs(this);
      return;
    }
    syncLinkedCrosshairs(this, sourceTime);
  }

  handlePointerCrosshairSync(event) {
    if (!syncChartsEnabled || isApplyingCrosshairSync || replayState.pickMode || drawingState.tool !== "none") return;
    const sourceTime = this.chartTimeFromEvent(event);
    if (sourceTime === null) {
      clearLinkedCrosshairs(this);
      return;
    }
    syncLinkedCrosshairs(this, sourceTime);
  }

  findBarCoveringTime(time) {
    if (!this.bars.length) return null;
    let left = 0;
    let right = this.bars.length - 1;
    let best = -1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      if (this.bars[mid].time <= time) {
        best = mid;
        left = mid + 1;
      } else {
        right = mid - 1;
      }
    }
    if (best < 0) return null;
    const bar = this.bars[best];
    const next = this.bars[best + 1];
    const endTime = next?.time || bar.time + (INTERVAL_SECONDS[this.config.interval] || 60);
    return time < endTime ? bar : null;
  }

  visibleRangeCoversTime(time) {
    const range = this.chart?.timeScale().getVisibleRange();
    if (!range) return false;
    const from = normalizeTime(range.from);
    const to = normalizeTime(range.to);
    return from !== null && to !== null && time >= from && time <= to;
  }

  setLinkedCrosshair(sourceTime) {
    if (typeof this.chart?.setCrosshairPosition !== "function") return false;
    const bar = this.findBarCoveringTime(sourceTime);
    const x = bar ? this.chart.timeScale().timeToCoordinate(bar.time) : null;
    if (!bar || x === null || x < 0 || x > this.chartHost.clientWidth) {
      this.clearLinkedCrosshair();
      return false;
    }
    this.chart.setCrosshairPosition(bar.close, bar.time, this.candleSeries);
    return true;
  }

  clearLinkedCrosshair() {
    if (typeof this.chart?.clearCrosshairPosition === "function") {
      this.chart.clearCrosshairPosition();
    }
  }

  bindDrawingEvents() {
    this.drawingPointerDownHandler = (event) => this.handleDrawingPointerDown(event);
    this.drawingPointerMoveHandler = (event) => this.handleDrawingPointerMove(event);
    this.drawingPointerLeaveHandler = () => this.clearDrawingPreview();
    this.chartWrap.addEventListener("pointerdown", this.drawingPointerDownHandler);
    this.chartWrap.addEventListener("pointermove", this.drawingPointerMoveHandler);
    this.chartWrap.addEventListener("pointerleave", this.drawingPointerLeaveHandler);
  }

  updateDrawingMode() {
    this.chartWrap.classList.toggle("drawing-active", drawingState.tool !== "none");
    this.chartWrap.classList.toggle("replay-pick-active", Boolean(replayState.pickMode));
    if (drawingState.tool === "none") {
      this.pendingDrawing = null;
      this.clearDrawingPreview();
    }
  }

  chartPointFromEvent(event) {
    const rect = this.chartHost.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    const time = this.chartTimeFromEvent(event);
    const price = this.candleSeries.coordinateToPrice(y);
    if (time === null || !Number.isFinite(price)) return null;
    return { time, price };
  }

  chartTimeFromEvent(event) {
    const rect = this.chartHost.getBoundingClientRect();
    const x = event.clientX - rect.left;
    if (x < 0 || x > rect.width) return null;
    const directTime = normalizeTime(this.chart.timeScale().coordinateToTime(x));
    if (directTime !== null) return directTime;
    const range = this.chart.timeScale().getVisibleRange();
    const from = normalizeTime(range?.from);
    const to = normalizeTime(range?.to);
    if (from !== null && to !== null && rect.width > 0) {
      return from + ((to - from) * x) / rect.width;
    }
    if (this.allBars.length && rect.width > 0) {
      const index = Math.max(0, Math.min(this.allBars.length - 1, Math.round((x / rect.width) * (this.allBars.length - 1))));
      return this.allBars[index].time;
    }
    return null;
  }

  handleDrawingPointerDown(event) {
    if (replayState.pickMode) {
      this.handleReplayPick(event);
      return;
    }
    if (drawingState.tool === "none") return;
    const point = this.chartPointFromEvent(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    activeDrawingPanel = this;

    if (drawingState.tool === "hline") {
      this.addDrawing({ type: "hline", color: drawingState.color, points: [point] });
      return;
    }

    if (drawingState.tool === "text") {
      const text = window.prompt("输入标注文字", "文字");
      if (text) this.addDrawing({ type: "text", color: drawingState.color, text, points: [point] });
      return;
    }

    if (!this.pendingDrawing || this.pendingDrawing.type !== drawingState.tool) {
      this.pendingDrawing = { type: drawingState.tool, color: drawingState.color, points: [point] };
      this.previewPoint = point;
      this.drawDrawingPreview();
      return;
    }

    const first = this.pendingDrawing.points[0];
    if (drawingPointKey(first) === drawingPointKey(point)) return;
    this.addDrawing({ ...this.pendingDrawing, points: [first, point] });
    this.pendingDrawing = null;
    this.previewPoint = null;
    this.clearDrawingPreview();
  }

  handleDrawingPointerMove(event) {
    this.handlePointerCrosshairSync(event);
    if (replayState.pickMode) return;
    if (drawingState.tool === "none" || !this.pendingDrawing) return;
    const point = this.chartPointFromEvent(event);
    if (!point) return;
    this.previewPoint = point;
    this.drawDrawingPreview();
  }

  handleReplayPick(event) {
    const time = this.chartTimeFromEvent(event);
    if (time === null) return;
    event.preventDefault();
    event.stopPropagation();
    const bar = this.findBarCoveringTime(time) || this.nearestBarByTime(time);
    if (!bar) return;
    setReplayCutoffFromChart(bar.time);
  }

  nearestBarByTime(time) {
    if (!this.allBars.length) return null;
    let best = this.allBars[0];
    let bestDistance = Math.abs(best.time - time);
    this.allBars.forEach((bar) => {
      const distance = Math.abs(bar.time - time);
      if (distance < bestDistance) {
        best = bar;
        bestDistance = distance;
      }
    });
    return best;
  }

  addDrawing(drawing) {
    activeDrawingPanel = this;
    this.drawings.push({ id: `${Date.now()}-${Math.random().toString(16).slice(2)}`, ...drawing });
    this.config.drawings = this.drawings;
    panelConfigs[this.index] = this.config;
    saveState();
    this.drawStoredDrawings();
  }

  undoDrawing() {
    this.drawings.pop();
    this.config.drawings = this.drawings;
    panelConfigs[this.index] = this.config;
    saveState();
    this.drawStoredDrawings();
  }

  clearDrawings() {
    this.drawings = [];
    this.config.drawings = this.drawings;
    panelConfigs[this.index] = this.config;
    this.pendingDrawing = null;
    this.previewPoint = null;
    saveState();
    this.drawStoredDrawings();
    this.clearDrawingPreview();
  }

  clearDrawingPreview() {
    if (this.drawingPreviewLayer) this.drawingPreviewLayer.innerHTML = "";
  }

  setReplayPickHint() {
    if (!this.drawingPreviewLayer) return;
    this.clearDrawingPreview();
    if (!replayState.pickMode) return;
    const hint = document.createElement("div");
    hint.className = "replay-pick-hint";
    hint.textContent = "点击K线设置回放截止时间";
    this.drawingPreviewLayer.appendChild(hint);
  }

  drawDrawingPreview() {
    this.clearDrawingPreview();
    if (!this.pendingDrawing || !this.previewPoint) return;
    const drawing = { ...this.pendingDrawing, points: [this.pendingDrawing.points[0], this.previewPoint] };
    this.renderDrawings(this.drawingPreviewLayer, [drawing], true);
  }

  drawStoredDrawings() {
    if (!this.drawingLayer) return;
    this.drawingLayer.innerHTML = "";
    this.renderDrawings(this.drawingLayer, this.drawings, false);
  }

  renderDrawings(container, drawings, preview) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("drawing-svg");
    container.appendChild(svg);
    drawings.forEach((drawing) => this.renderDrawing(svg, container, drawing, preview));
  }

  renderDrawing(svg, container, drawing, preview = false) {
    const points = drawing.points || [];
    const color = drawing.color || "#20c7b1";
    const coords = points.map((point) => this.drawingPointToCoordinate(point));
    const opacity = preview ? "0.62" : "0.88";
    if (drawing.type === "hline" && coords[0]) {
      this.svgLine(svg, 0, coords[0].y, this.chartHost.clientWidth, coords[0].y, color, opacity, "4 4");
      this.drawingLabel(container, this.chartHost.clientWidth - 54, coords[0].y, priceFormat(points[0].price), color);
    }
    if (drawing.type === "trend" && coords[0] && coords[1]) {
      this.svgLine(svg, coords[0].x, coords[0].y, coords[1].x, coords[1].y, color, opacity);
    }
    if (drawing.type === "rect" && coords[0] && coords[1]) {
      this.svgRect(svg, coords[0], coords[1], color, opacity);
    }
    if (drawing.type === "fib" && coords[0] && coords[1]) {
      this.renderFib(svg, container, points[0], points[1], coords[0], coords[1], color, opacity);
    }
    if (drawing.type === "text" && coords[0]) {
      this.drawingLabel(container, coords[0].x, coords[0].y, drawing.text || "文字", color);
    }
  }

  drawingPointToCoordinate(point) {
    const x = this.chart.timeScale().timeToCoordinate(point.time);
    const y = this.candleSeries.priceToCoordinate(point.price);
    if (x === null || y === null || Number.isNaN(x) || Number.isNaN(y)) return null;
    return { x, y };
  }

  svgLine(svg, x1, y1, x2, y2, color, opacity, dash = "") {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", "1.4");
    line.setAttribute("opacity", opacity);
    if (dash) line.setAttribute("stroke-dasharray", dash);
    svg.appendChild(line);
  }

  svgRect(svg, start, end, color, opacity) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", Math.min(start.x, end.x));
    rect.setAttribute("y", Math.min(start.y, end.y));
    rect.setAttribute("width", Math.abs(end.x - start.x));
    rect.setAttribute("height", Math.abs(end.y - start.y));
    rect.setAttribute("fill", color);
    rect.setAttribute("fill-opacity", "0.1");
    rect.setAttribute("stroke", color);
    rect.setAttribute("stroke-opacity", opacity);
    rect.setAttribute("stroke-width", "1.2");
    svg.appendChild(rect);
  }

  renderFib(svg, container, firstPoint, secondPoint, firstCoord, secondCoord, color, opacity) {
    const levels = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618];
    const x1 = Math.min(firstCoord.x, secondCoord.x);
    const x2 = Math.max(firstCoord.x, secondCoord.x);
    const priceDelta = secondPoint.price - firstPoint.price;
    levels.forEach((level) => {
      const price = firstPoint.price + priceDelta * level;
      const y = this.candleSeries.priceToCoordinate(price);
      if (y === null || Number.isNaN(y)) return;
      this.svgLine(svg, x1, y, x2, y, color, opacity, level > 1 ? "5 3" : "");
      this.drawingLabel(container, x2, y, `${level.toFixed(3)} ${priceFormat(price)}`, color);
    });
    this.svgLine(svg, firstCoord.x, firstCoord.y, secondCoord.x, secondCoord.y, color, "0.35", "3 3");
  }

  drawingLabel(container, x, y, text, color) {
    const label = document.createElement("div");
    label.className = "drawing-label";
    label.textContent = text;
    label.style.left = `${x}px`;
    label.style.top = `${y}px`;
    label.style.border = `1px solid ${color}`;
    container.appendChild(label);
  }

  bindResize() {
    this.resizeObserver = new ResizeObserver(() => {
      this.chart?.resize(this.chartHost.clientWidth, this.chartHost.clientHeight);
      this.resizeIndicatorPanes();
      this.drawOverlays();
      this.drawStoredDrawings();
    });
    this.resizeObserver.observe(this.dom);
  }

  async load() {
    this.status("加载历史数据");
    if (this.eventSource) this.eventSource.close();
    this.allBars = [];
    this.bars = [];
    this.replayCursor = -1;
    this.lastClose = null;
    this.clearOverlays();
    this.clearDrawingPreview();
    this.priceValue.textContent = "--";
    this.priceChange.textContent = "--";

    const params = new URLSearchParams({
      source: this.config.source,
      symbol: this.config.symbol,
      interval: this.config.interval,
      limit: String(HISTORY_LIMIT),
    });

    try {
      const response = await fetch(`/api/history?${params}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "历史数据请求失败");
      this.allBars = payload.bars || [];
      this.applyReplayState(true);
      this.connectStream();
      this.status("已连接");
    } catch (error) {
      this.status(error.message || "加载失败");
      this.candleSeries.setData([]);
      this.showEmpty(error.message || "暂无数据");
    }
  }

  showEmpty(message) {
    this.clearEmpty();
    const note = document.createElement("div");
    note.className = "empty-note";
    note.textContent = message;
    this.chartHost.appendChild(note);
  }

  clearEmpty() {
    this.chartHost.querySelectorAll(".empty-note").forEach((node) => node.remove());
  }

  connectStream() {
    const params = new URLSearchParams({
      source: this.config.source,
      symbol: this.config.symbol,
      interval: this.config.interval,
    });
    this.eventSource = new EventSource(`/api/stream?${params}`);
    this.eventSource.addEventListener("bar", (event) => {
      const payload = JSON.parse(event.data);
      this.upsertBar(payload.bar);
    });
    this.eventSource.addEventListener("status", (event) => {
      const payload = JSON.parse(event.data);
      this.status(payload.message || "已连接");
    });
    this.eventSource.addEventListener("warning", (event) => {
      const payload = JSON.parse(event.data);
      this.status(payload.message || "数据异常");
    });
    this.eventSource.onerror = () => {
      this.status("连接重试中");
    };
  }

  upsertBar(bar) {
    this.clearEmpty();
    this.upsertAllBar(bar);
    if (replayState.enabled) {
      setReplayStatus();
      return;
    }
    const previousLast = this.bars[this.bars.length - 1];
    const canUpdateLatest = !previousLast || bar.time >= previousLast.time;
    this.bars = this.allBars.slice();
    if (canUpdateLatest) {
      this.candleSeries.update(bar);
    } else {
      this.candleSeries.setData(this.bars);
    }
    this.updatePrice(bar);
    this.recalculateIndicators();
    this.drawStoredDrawings();
  }

  upsertAllBar(bar) {
    const last = this.allBars[this.allBars.length - 1];
    if (!last || bar.time > last.time) {
      this.allBars.push(bar);
      if (!replayState.enabled && this.allBars.length > HISTORY_LIMIT + 80) this.allBars.shift();
    } else if (bar.time === last.time) {
      this.allBars[this.allBars.length - 1] = bar;
    } else {
      const index = this.allBars.findIndex((item) => item.time === bar.time);
      if (index >= 0) this.allBars[index] = bar;
      this.allBars.sort((a, b) => a.time - b.time);
    }
  }

  applyReplayState(fitContent = false) {
    if (replayState.enabled && replayState.cutoff !== null) {
      this.replayCursor = this.findReplayCursor(replayState.cutoff);
      this.bars = this.allBars.slice(0, this.replayCursor + 1);
    } else {
      this.replayCursor = this.allBars.length - 1;
      this.bars = this.allBars.slice();
    }

    this.candleSeries.setData(this.bars);
    if (fitContent) this.chart.timeScale().fitContent();
    this.updatePrice(this.bars[this.bars.length - 1], true);
    this.recalculateIndicators();
    this.drawStoredDrawings();
    setReplayStatus();
  }

  findReplayCursor(cutoff) {
    let cursor = -1;
    for (let index = 0; index < this.allBars.length; index += 1) {
      if (this.allBars[index].time <= cutoff) cursor = index;
      else break;
    }
    return cursor;
  }

  replayStep() {
    if (!this.allBars.length) return false;
    if (this.replayCursor >= this.allBars.length - 1) return false;
    this.replayCursor += 1;
    const bar = this.allBars[this.replayCursor];
    this.bars.push(bar);
    this.candleSeries.update(bar);
    this.updatePrice(bar);
    this.recalculateIndicators();
    this.drawStoredDrawings();
    return true;
  }

  updatePrice(bar, initial = false) {
    if (!bar) return;
    const previous = this.lastClose;
    const changed = previous !== null ? bar.close - previous : 0;
    this.lastClose = bar.close;
    this.priceValue.textContent = priceFormat(bar.close);
    const open = bar.open || bar.close;
    const pct = open ? ((bar.close - open) / open) * 100 : 0;
    this.priceChange.textContent = percentFormat(pct);
    this.priceChange.style.color = pct >= 0 ? "var(--green)" : "var(--red)";

    if (!initial && changed !== 0) {
      this.priceStrip.classList.remove("flash-up", "flash-down");
      void this.priceStrip.offsetWidth;
      this.priceStrip.classList.add(changed > 0 ? "flash-up" : "flash-down");
      window.setTimeout(() => this.priceStrip.classList.remove("flash-up", "flash-down"), 260);
    }
  }

  status(message) {
    this.statusText.textContent = message;
  }

  updateIndicatorVisibility() {
    const enabled = this.config.indicators;
    const visiblePanes = new Set();
    INDICATORS.forEach((indicator) => {
      if (!enabled[indicator.key]) return;
      (indicator.series || []).forEach((seriesDef) => {
        if (seriesDef.pane !== "main") visiblePanes.add(seriesDef.pane);
      });
    });

    this.paneCharts.forEach((pane, paneId) => {
      pane.pane.classList.toggle("hidden", !visiblePanes.has(paneId));
    });
    this.indicatorPanes.classList.toggle("visible", visiblePanes.size > 0);
    this.indicatorPanes.style.setProperty("--pane-count", String(Math.max(visiblePanes.size, 1)));
    requestAnimationFrame(() => this.resizeIndicatorPanes());
  }

  resizeIndicatorPanes() {
    this.paneCharts.forEach((pane) => {
      pane.chart.resize(pane.host.clientWidth, pane.host.clientHeight || pane.meta.height || 72);
    });
  }

  clearOverlays() {
    this.fvgLayer.innerHTML = "";
    this.vpLayer.innerHTML = "";
    this.priceLines.forEach((line) => {
      try {
        this.candleSeries.removePriceLine(line);
      } catch {
        // A removed chart can invalidate price lines during panel rebuild.
      }
    });
    this.priceLines = [];
  }

  recalculateIndicators() {
    const enabled = this.config.indicators;
    const bars = this.bars;
    const context = this.indicatorContext();

    INDICATORS.forEach((indicator) => {
      const series = indicator.series || [];
      // Overlay-only indicators (FVG, Volume Profile, auto structure...) carry no
      // chart series; drawOverlays owns their calculation and rendering, so skip
      // them here to avoid computing the same heavy result twice per update.
      if (!series.length) return;

      if (!enabled[indicator.key]) {
        series.forEach((seriesDef) => {
          this.indicatorSeries.get(this.seriesKey(indicator.key, seriesDef.id))?.setData([]);
        });
        return;
      }

      let result = {};
      try {
        result = indicator.calculate(bars, context) || {};
      } catch (error) {
        console.warn(`指标计算失败: ${indicator.key}`, error);
        result = {};
      }

      series.forEach((seriesDef) => {
        const seriesInstance = this.indicatorSeries.get(this.seriesKey(indicator.key, seriesDef.id));
        seriesInstance?.setData(result.series?.[seriesDef.id] || []);
      });
    });

    this.updateIndicatorVisibility();
    this.drawOverlays();
  }

  drawOverlays() {
    if (!this.chart || !this.candleSeries) return;
    this.clearOverlays();
    const context = this.indicatorContext();
    INDICATORS.forEach((indicator) => {
      if (!this.config.indicators[indicator.key] || !indicator.renderOverlay) return;
      try {
        indicator.renderOverlay(this, indicator.calculate(this.bars, context) || {});
      } catch (error) {
        console.warn(`指标覆盖层绘制失败: ${indicator.key}`, error);
      }
    });
  }
}

function syncLinkedCrosshairs(sourcePanel, sourceTime) {
  isApplyingCrosshairSync = true;
  try {
    activePanels.forEach((targetPanel) => {
      if (targetPanel === sourcePanel) return;
      if (targetPanel.instrumentKey() !== sourcePanel.instrumentKey()) return;
      if (targetPanel.setLinkedCrosshair(sourceTime)) {
        window.dispatchEvent(
          new CustomEvent("tw-crosshair-sync", {
            detail: {
              source: sourcePanel.instrumentKey(),
              target: targetPanel.instrumentKey(),
              time: sourceTime,
            },
          }),
        );
      }
    });
  } finally {
    isApplyingCrosshairSync = false;
  }
}

function clearLinkedCrosshairs(sourcePanel = null) {
  isApplyingCrosshairSync = true;
  try {
    activePanels.forEach((targetPanel) => {
      if (targetPanel === sourcePanel) return;
      if (sourcePanel && targetPanel.instrumentKey() !== sourcePanel.instrumentKey()) return;
      targetPanel.clearLinkedCrosshair();
    });
  } finally {
    isApplyingCrosshairSync = false;
  }
}

function applyReplayToAll(fitContent = false) {
  activePanels.forEach((panel) => panel.applyReplayState(fitContent));
  setReplayStatus();
}

function replayStepAll() {
  let moved = false;
  activePanels.forEach((panel) => {
    moved = panel.replayStep() || moved;
  });
  setReplayStatus();
  if (!moved) stopReplayPlayback();
  return moved;
}

function startReplayPlayback() {
  if (!replayState.enabled) {
    replayState.enabled = true;
    replayModeToggle.checked = true;
  }
  replayState.playing = true;
  replayPlayButton.textContent = "暂停";
  window.clearInterval(replayTimer);
  replayTimer = window.setInterval(replayStepAll, Math.max(120, 900 / replayState.speed));
  setReplayStatus();
}

function stopReplayPlayback() {
  replayState.playing = false;
  replayPlayButton.textContent = "播放";
  window.clearInterval(replayTimer);
  replayTimer = null;
  setReplayStatus();
}

function setReplayPickMode(enabled) {
  replayState.pickMode = enabled;
  replayPickButton.classList.toggle("active", enabled);
  replayPickButton.textContent = enabled ? "取消选择" : "图上选择";
  activePanels.forEach((panel) => {
    panel.updateDrawingMode();
    panel.setReplayPickHint();
  });
}

function setReplayCutoffFromChart(cutoff) {
  replayState.cutoff = cutoff;
  replayState.enabled = true;
  replayModeToggle.checked = true;
  stopReplayPlayback();
  syncReplayInputsFromCutoff();
  setReplayPickMode(false);
  applyReplayToAll(true);
  saveState();
}

function setReplayStatus() {
  if (!replayState.enabled) {
    replayStatus.textContent = "实时模式";
    return;
  }
  const visible = activePanels.reduce((sum, panel) => sum + panel.bars.length, 0);
  const total = activePanels.reduce((sum, panel) => sum + panel.allBars.length, 0);
  const cutoff = replayState.cutoff ? toDatetimeLocalValue(replayState.cutoff).replace("T", " ") : "未设置";
  replayStatus.textContent = `回放 ${visible}/${total} ${cutoff}`;
}

function setupReplayControls() {
  loadReplayState();
  replayModeToggle.checked = replayState.enabled;
  if (replayState.cutoff) {
    syncReplayInputsFromCutoff();
  } else {
    const now = Math.floor(Date.now() / 1000);
    replayDateInput.value = dateValueFromEpoch(now);
    replayTimeSelect.value = "09:30";
  }
  replaySpeedSelect.value = String(replayState.speed);

  replayDateInput.addEventListener("change", () => {
    const cutoff = syncCutoffFromDateTimeControls();
    if (cutoff !== null) replayState.cutoff = cutoff;
  });

  replayTimeSelect.addEventListener("change", () => {
    const cutoff = syncCutoffFromDateTimeControls();
    if (cutoff !== null) replayState.cutoff = cutoff;
  });

  replayCutoffInput.addEventListener("change", () => {
    const cutoff = fromDatetimeLocalValue(replayCutoffInput.value);
    if (cutoff !== null) {
      replayState.cutoff = cutoff;
      syncReplayInputsFromCutoff();
    }
  });

  replayModeToggle.addEventListener("change", () => {
    replayState.enabled = replayModeToggle.checked;
    if (!replayState.enabled) {
      stopReplayPlayback();
      setReplayPickMode(false);
    }
    applyReplayToAll(false);
    saveState();
  });

  replayApplyButton.addEventListener("click", () => {
    const cutoff = fromDatetimeLocalValue(replayCutoffInput.value) || syncCutoffFromDateTimeControls();
    if (cutoff !== null) replayState.cutoff = cutoff;
    replayState.enabled = true;
    replayModeToggle.checked = true;
    stopReplayPlayback();
    setReplayPickMode(false);
    syncReplayInputsFromCutoff();
    applyReplayToAll(true);
    saveState();
  });

  replayPickButton.addEventListener("click", () => {
    setReplayPickMode(!replayState.pickMode);
  });

  replayStepButton.addEventListener("click", () => {
    replayState.enabled = true;
    replayModeToggle.checked = true;
    replayStepAll();
    saveState();
  });

  replayPlayButton.addEventListener("click", () => {
    if (replayState.playing) {
      stopReplayPlayback();
    } else {
      startReplayPlayback();
    }
    saveState();
  });

  replaySpeedSelect.addEventListener("change", () => {
    replayState.speed = Number(replaySpeedSelect.value) || 1;
    if (replayState.playing) startReplayPlayback();
    saveState();
  });

  replayResetButton.addEventListener("click", () => {
    stopReplayPlayback();
    setReplayPickMode(false);
    replayState.enabled = false;
    replayModeToggle.checked = false;
    applyReplayToAll(true);
    saveState();
  });
}

function updateDrawingModeAll() {
  activePanels.forEach((panel) => panel.updateDrawingMode());
}

function setupDrawingControls() {
  drawingToolSelect.value = drawingState.tool;
  drawingColorInput.value = drawingState.color;

  drawingToolSelect.addEventListener("change", () => {
    drawingState.tool = drawingToolSelect.value;
    updateDrawingModeAll();
  });

  drawingColorInput.addEventListener("change", () => {
    drawingState.color = drawingColorInput.value;
  });

  drawingUndoButton.addEventListener("click", () => {
    const target = activeDrawingPanel || activePanels[0];
    target?.undoDrawing();
  });

  drawingClearButton.addEventListener("click", () => {
    activePanels.forEach((panel) => panel.clearDrawings());
  });
}

function renderDashboard() {
  activePanels.forEach((panel) => panel.destroy());
  activePanels = [];
  dashboard.innerHTML = "";
  dashboard.dataset.count = String(chartCount);

  for (let index = 0; index < chartCount; index += 1) {
    const panel = new ChartPanel(index, panelConfigs[index]);
    activePanels.push(panel);
    panel.mount(dashboard);
  }
  updateDrawingModeAll();
}

async function init() {
  const response = await fetch("/api/meta");
  meta = await response.json();
  chartCount = loadChartCount();
  syncChartsEnabled = loadSyncEnabled();
  setupReplayControls();
  setupDrawingControls();
  chartCountSelect.value = String(chartCount);
  syncChartsToggle.checked = syncChartsEnabled;
  loadPanelConfigs(meta.defaultPanels);
  syncChartsToggle.addEventListener("change", () => {
    syncChartsEnabled = syncChartsToggle.checked;
    saveState();
    if (!syncChartsEnabled) clearLinkedCrosshairs();
  });
  chartCountSelect.addEventListener("change", () => {
    chartCount = Number(chartCountSelect.value);
    saveState();
    renderDashboard();
  });
  saveState();
  renderDashboard();
}

init().catch((error) => {
  dashboard.innerHTML = `<div class="empty-note">初始化失败：${error.message}</div>`;
});
