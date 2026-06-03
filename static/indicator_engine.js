(function () {
  const COLORS = {
    green: "#22c55e",
    red: "#ef5350",
    teal: "#20c7b1",
    amber: "#d9a441",
    blue: "#6aa7ff",
    purple: "#e879f9",
    orange: "#f59e0b",
    gray: "#9aa3af",
    cyan: "#38bdf8",
    pink: "#fb7185",
  };

  const PANE_META = {
    momentum: {
      title: "动量",
      height: 72,
      levels: [
        { price: 80, color: "#513845", title: "80" },
        { price: 50, color: "#343a46", title: "50" },
        { price: 20, color: "#2a493e", title: "20" },
      ],
    },
    macd: {
      title: "趋势震荡",
      height: 72,
      levels: [{ price: 0, color: "#343a46", title: "0" }],
    },
    trend: {
      title: "趋势强度",
      height: 72,
      levels: [
        { price: 25, color: "#343a46", title: "25" },
        { price: 50, color: "#343a46", title: "50" },
      ],
    },
    volume: {
      title: "量能",
      height: 72,
      levels: [{ price: 0, color: "#343a46", title: "0" }],
    },
    volatility: {
      title: "波动率",
      height: 72,
      levels: [{ price: 0, color: "#343a46", title: "0" }],
    },
  };

  const CATEGORY_ORDER = ["必备", "均线", "通道", "趋势", "动量", "量能", "波动率", "结构"];
  const indicators = [];

  function registerIndicator(definition) {
    if (!definition || !definition.key || !definition.label || typeof definition.calculate !== "function") {
      throw new Error("Invalid indicator definition");
    }
    if (indicators.some((item) => item.key === definition.key)) {
      throw new Error(`Duplicate indicator key: ${definition.key}`);
    }
    indicators.push({
      category: "其他",
      defaultOn: false,
      series: [],
      ...definition,
    });
  }

  function getIndicators() {
    return [...indicators].sort((left, right) => {
      const categoryDelta =
        CATEGORY_ORDER.indexOf(left.category) - CATEGORY_ORDER.indexOf(right.category);
      if (categoryDelta !== 0) return categoryDelta;
      return left.label.localeCompare(right.label, "zh-CN");
    });
  }

  function getPaneMeta(paneId) {
    return PANE_META[paneId] || { title: paneId, height: 72, levels: [{ price: 0, color: "#343a46" }] };
  }

  function isFiniteNumber(value) {
    return Number.isFinite(value);
  }

  function normalizeChartTime(time) {
    if (typeof time === "number") return time;
    if (time && typeof time === "object" && "year" in time && "month" in time && "day" in time) {
      return Math.floor(Date.UTC(time.year, time.month - 1, time.day) / 1000);
    }
    return null;
  }

  function linePoint(bar, value, extra = {}) {
    if (!isFiniteNumber(value)) return null;
    return { time: bar.time, value, ...extra };
  }

  function compact(points) {
    return points.filter(Boolean);
  }

  function seriesFromValues(bars, values, colorFn) {
    return compact(
      values.map((value, index) => {
        const extra = colorFn ? { color: colorFn(value, index, values) } : {};
        return linePoint(bars[index], value, extra);
      }),
    );
  }

  function fieldValues(bars, field) {
    return bars.map((bar) => Number(bar[field]));
  }

  function typicalPrices(bars) {
    return bars.map((bar) => (bar.high + bar.low + bar.close) / 3);
  }

  function medianPrices(bars) {
    return bars.map((bar) => (bar.high + bar.low) / 2);
  }

  function rollingSum(values, period) {
    const output = Array(values.length).fill(null);
    let sum = 0;
    for (let index = 0; index < values.length; index += 1) {
      sum += Number(values[index]) || 0;
      if (index >= period) sum -= Number(values[index - period]) || 0;
      if (index >= period - 1) output[index] = sum;
    }
    return output;
  }

  function smaValues(values, period) {
    return rollingSum(values, period).map((sum) => (sum === null ? null : sum / period));
  }

  function emaValues(values, period) {
    const output = Array(values.length).fill(null);
    const k = 2 / (period + 1);
    let current = null;
    for (let index = 0; index < values.length; index += 1) {
      const value = Number(values[index]);
      if (!isFiniteNumber(value)) continue;
      current = current === null ? value : value * k + current * (1 - k);
      if (index >= period - 1) output[index] = current;
    }
    return output;
  }

  function rmaValues(values, period) {
    const output = Array(values.length).fill(null);
    let sum = 0;
    let current = null;
    for (let index = 0; index < values.length; index += 1) {
      const value = Number(values[index]) || 0;
      if (index < period) {
        sum += value;
        if (index === period - 1) {
          current = sum / period;
          output[index] = current;
        }
      } else {
        current = (current * (period - 1) + value) / period;
        output[index] = current;
      }
    }
    return output;
  }

  function wmaValues(values, period) {
    const output = Array(values.length).fill(null);
    const denominator = (period * (period + 1)) / 2;
    for (let index = period - 1; index < values.length; index += 1) {
      let weighted = 0;
      for (let offset = 0; offset < period; offset += 1) {
        weighted += values[index - offset] * (period - offset);
      }
      output[index] = weighted / denominator;
    }
    return output;
  }

  function hmaValues(values, period) {
    const half = Math.max(1, Math.floor(period / 2));
    const root = Math.max(1, Math.round(Math.sqrt(period)));
    const fast = wmaValues(values, half);
    const slow = wmaValues(values, period);
    const diff = values.map((_value, index) =>
      fast[index] === null || slow[index] === null ? null : 2 * fast[index] - slow[index],
    );
    return wmaValues(diff.map((value) => (value === null ? 0 : value)), root).map((value, index) =>
      diff[index] === null ? null : value,
    );
  }

  function highestValues(values, period) {
    const output = Array(values.length).fill(null);
    for (let index = period - 1; index < values.length; index += 1) {
      output[index] = Math.max(...values.slice(index - period + 1, index + 1));
    }
    return output;
  }

  function lowestValues(values, period) {
    const output = Array(values.length).fill(null);
    for (let index = period - 1; index < values.length; index += 1) {
      output[index] = Math.min(...values.slice(index - period + 1, index + 1));
    }
    return output;
  }

  function stdDevValues(values, period) {
    const output = Array(values.length).fill(null);
    for (let index = period - 1; index < values.length; index += 1) {
      const slice = values.slice(index - period + 1, index + 1);
      const mean = slice.reduce((sum, value) => sum + value, 0) / period;
      const variance = slice.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period;
      output[index] = Math.sqrt(variance);
    }
    return output;
  }

  function meanDeviationValues(values, period, averages) {
    const output = Array(values.length).fill(null);
    for (let index = period - 1; index < values.length; index += 1) {
      const mean = averages[index];
      if (!isFiniteNumber(mean)) continue;
      const slice = values.slice(index - period + 1, index + 1);
      output[index] = slice.reduce((sum, value) => sum + Math.abs(value - mean), 0) / period;
    }
    return output;
  }

  function trueRanges(bars) {
    return bars.map((bar, index) => {
      if (index === 0) return bar.high - bar.low;
      const prevClose = bars[index - 1].close;
      return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
    });
  }

  function atrValues(bars, period) {
    return rmaValues(trueRanges(bars), period);
  }

  function buildMacdValues(values, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
    const fast = emaValues(values, fastPeriod);
    const slow = emaValues(values, slowPeriod);
    const line = values.map((_value, index) =>
      fast[index] === null || slow[index] === null ? null : fast[index] - slow[index],
    );
    const signal = emaValues(line.map((value) => (value === null ? 0 : value)), signalPeriod).map((value, index) =>
      line[index] === null ? null : value,
    );
    const histogram = line.map((value, index) =>
      value === null || signal[index] === null ? null : value - signal[index],
    );
    return { line, signal, histogram };
  }

  function rsiValues(bars, period = 14) {
    const output = Array(bars.length).fill(null);
    if (bars.length <= period) return output;
    const gains = Array(bars.length).fill(0);
    const losses = Array(bars.length).fill(0);
    for (let index = 1; index < bars.length; index += 1) {
      const change = bars[index].close - bars[index - 1].close;
      gains[index] = Math.max(change, 0);
      losses[index] = Math.max(-change, 0);
    }
    const avgGain = rmaValues(gains, period);
    const avgLoss = rmaValues(losses, period);
    for (let index = 0; index < bars.length; index += 1) {
      if (avgGain[index] === null || avgLoss[index] === null) continue;
      output[index] = avgLoss[index] === 0 ? 100 : 100 - 100 / (1 + avgGain[index] / avgLoss[index]);
    }
    return output;
  }

  function stochasticValues(bars, period = 14, smoothK = 3, smoothD = 3) {
    const highs = fieldValues(bars, "high");
    const lows = fieldValues(bars, "low");
    const closes = fieldValues(bars, "close");
    const highest = highestValues(highs, period);
    const lowest = lowestValues(lows, period);
    const rawK = closes.map((close, index) => {
      const range = highest[index] - lowest[index];
      return !range ? null : ((close - lowest[index]) / range) * 100;
    });
    const k = smaValues(rawK.map((value) => (value === null ? 0 : value)), smoothK).map((value, index) =>
      rawK[index] === null ? null : value,
    );
    const d = smaValues(k.map((value) => (value === null ? 0 : value)), smoothD).map((value, index) =>
      k[index] === null ? null : value,
    );
    return { k, d };
  }

  function moneyFlowIndexValues(bars, period = 14) {
    const output = Array(bars.length).fill(null);
    const positive = Array(bars.length).fill(0);
    const negative = Array(bars.length).fill(0);
    const typical = typicalPrices(bars);
    for (let index = 1; index < bars.length; index += 1) {
      const flow = typical[index] * (bars[index].volume || 0);
      if (typical[index] > typical[index - 1]) positive[index] = flow;
      if (typical[index] < typical[index - 1]) negative[index] = flow;
    }
    const posSum = rollingSum(positive, period);
    const negSum = rollingSum(negative, period);
    for (let index = period - 1; index < bars.length; index += 1) {
      if (negSum[index] === 0) output[index] = 100;
      else output[index] = 100 - 100 / (1 + posSum[index] / negSum[index]);
    }
    return output;
  }

  function fairValueGaps(bars) {
    const gaps = [];
    for (let index = 2; index < bars.length; index += 1) {
      const left = bars[index - 2];
      const current = bars[index];
      if (current.low > left.high) {
        gaps.push({
          direction: "bullish",
          fromTime: left.time,
          toTime: findGapFillTime(bars, index + 1, left.high, current.low, "bullish"),
          top: current.low,
          bottom: left.high,
        });
      }
      if (current.high < left.low) {
        gaps.push({
          direction: "bearish",
          fromTime: left.time,
          toTime: findGapFillTime(bars, index + 1, current.high, left.low, "bearish"),
          top: left.low,
          bottom: current.high,
        });
      }
    }
    return gaps.filter((gap) => !gap.toTime || gap.toTime >= bars[Math.max(0, bars.length - 160)]?.time);
  }

  function findGapFillTime(bars, start, lower, upper, direction) {
    for (let index = start; index < bars.length; index += 1) {
      const bar = bars[index];
      if (direction === "bullish" && bar.low <= lower) return bar.time;
      if (direction === "bearish" && bar.high >= upper) return bar.time;
    }
    return null;
  }

  function volumeProfile(bars, range) {
    if (!bars.length) return null;
    const visible = range ? bars.filter((bar) => bar.time >= range.from && bar.time <= range.to) : bars.slice(-180);
    const working = visible.length >= 20 ? visible : bars.slice(-180);
    const minPrice = Math.min(...working.map((bar) => bar.low));
    const maxPrice = Math.max(...working.map((bar) => bar.high));
    if (!isFiniteNumber(minPrice) || !isFiniteNumber(maxPrice) || maxPrice <= minPrice) return null;

    const bucketCount = 32;
    const step = (maxPrice - minPrice) / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_item, index) => ({
      low: minPrice + step * index,
      high: minPrice + step * (index + 1),
      volume: 0,
    }));
    working.forEach((bar) => {
      const typical = (bar.high + bar.low + bar.close) / 3;
      const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((typical - minPrice) / step)));
      buckets[index].volume += Math.max(Number(bar.volume) || 0, 0);
    });
    if (buckets.every((bucket) => bucket.volume === 0)) return null;

    const pocIndex = buckets.reduce((best, bucket, index) => (bucket.volume > buckets[best].volume ? index : best), 0);
    const totalVolume = buckets.reduce((sum, bucket) => sum + bucket.volume, 0);
    const target = totalVolume * 0.7;
    let left = pocIndex;
    let right = pocIndex;
    let valueVolume = buckets[pocIndex].volume;
    while (valueVolume < target && (left > 0 || right < bucketCount - 1)) {
      const leftVolume = left > 0 ? buckets[left - 1].volume : -1;
      const rightVolume = right < bucketCount - 1 ? buckets[right + 1].volume : -1;
      if (rightVolume >= leftVolume) {
        right += 1;
        valueVolume += buckets[right].volume;
      } else {
        left -= 1;
        valueVolume += buckets[left].volume;
      }
    }

    return {
      buckets,
      poc: (buckets[pocIndex].low + buckets[pocIndex].high) / 2,
      vah: buckets[right].high,
      val: buckets[left].low,
      pocIndex,
      vahIndex: right,
      valIndex: left,
    };
  }

  function visibleBarsForAnalysis(bars, range, fallback = 260) {
    if (!bars.length) return [];
    if (!range) return bars.slice(-fallback);
    const from = normalizeChartTime(range.from);
    const to = normalizeChartTime(range.to);
    if (from === null || to === null) return bars.slice(-fallback);
    const visible = bars.filter((bar) => bar.time >= from && bar.time <= to);
    return visible.length >= 35 ? visible : bars.slice(-fallback);
  }

  function averageAtr(bars, period = 14) {
    const atr = atrValues(bars, period).filter((value) => value !== null && Number.isFinite(value));
    if (!atr.length) {
      const range = Math.max(...bars.map((bar) => bar.high)) - Math.min(...bars.map((bar) => bar.low));
      return range / 80 || 1;
    }
    return atr.slice(-30).reduce((sum, value) => sum + value, 0) / Math.min(30, atr.length);
  }

  function pivotPoints(bars, left = 3, right = 3) {
    const pivots = [];
    for (let index = left; index < bars.length - right; index += 1) {
      const window = bars.slice(index - left, index + right + 1);
      const high = bars[index].high;
      const low = bars[index].low;
      if (window.every((bar, pos) => pos === left || high > bar.high)) {
        pivots.push({ type: "high", index, time: bars[index].time, price: high });
      }
      if (window.every((bar, pos) => pos === left || low < bar.low)) {
        pivots.push({ type: "low", index, time: bars[index].time, price: low });
      }
    }
    return pivots.sort((leftPivot, rightPivot) => leftPivot.index - rightPivot.index);
  }

  function linePriceAt(line, index) {
    return line.slope * index + line.intercept;
  }

  function makeCandidateLine(first, second, type, bars, pivots, tolerance) {
    const span = second.index - first.index;
    if (span < 6) return null;
    const slope = (second.price - first.price) / span;
    const intercept = first.price - slope * first.index;
    const line = { type, slope, intercept };
    let touches = 0;
    let violations = 0;
    let lastTouchIndex = Math.max(first.index, second.index);

    pivots
      .filter((pivot) => pivot.type === type)
      .forEach((pivot) => {
        const projected = linePriceAt(line, pivot.index);
        if (Math.abs(pivot.price - projected) <= tolerance) {
          touches += 1;
          lastTouchIndex = Math.max(lastTouchIndex, pivot.index);
        }
      });

    for (let index = first.index; index < bars.length; index += 1) {
      const projected = linePriceAt(line, index);
      if (type === "low" && bars[index].low < projected - tolerance) violations += 1;
      if (type === "high" && bars[index].high > projected + tolerance) violations += 1;
    }

    const recency = lastTouchIndex / Math.max(1, bars.length - 1);
    const score = touches * 4 + recency * 2 - violations * 3 + Math.min(span / bars.length, 1);
    if (touches < 2 || violations > Math.max(2, touches)) return null;
    return {
      type,
      score,
      touches,
      violations,
      startTime: first.time,
      startPrice: first.price,
      endTime: bars[bars.length - 1].time,
      endPrice: linePriceAt(line, bars.length - 1),
    };
  }

  function uniqueLines(lines, tolerance) {
    const sorted = [...lines].sort((left, right) => right.score - left.score);
    const accepted = [];
    sorted.forEach((line) => {
      const duplicate = accepted.some(
        (item) =>
          item.type === line.type &&
          Math.abs(item.endPrice - line.endPrice) <= tolerance &&
          Math.abs(item.startPrice - line.startPrice) <= tolerance * 2,
      );
      if (!duplicate) accepted.push(line);
    });
    return accepted;
  }

  function autoTrendlines(bars, range) {
    const working = visibleBarsForAnalysis(bars, range, 280);
    if (working.length < 40) return [];
    const pivots = pivotPoints(working, 3, 3);
    const atr = averageAtr(working);
    const tolerance = Math.max(atr * 0.45, (Math.max(...working.map((bar) => bar.high)) - Math.min(...working.map((bar) => bar.low))) * 0.004);
    const candidates = [];

    ["high", "low"].forEach((type) => {
      const typed = pivots.filter((pivot) => pivot.type === type).slice(-18);
      for (let left = 0; left < typed.length - 1; left += 1) {
        for (let right = left + 1; right < typed.length; right += 1) {
          const candidate = makeCandidateLine(typed[left], typed[right], type, working, pivots, tolerance);
          if (candidate) candidates.push(candidate);
        }
      }
    });

    return uniqueLines(candidates, tolerance).slice(0, 8).map((line) => ({
      ...line,
      label: line.type === "low" ? "自动支撑趋势线" : "自动压力趋势线",
      color: line.type === "low" ? COLORS.green : COLORS.red,
    }));
  }

  function nearEqual(left, right, tolerance) {
    return Math.abs(left - right) <= tolerance;
  }

  function detectChartPatterns(bars, range) {
    const working = visibleBarsForAnalysis(bars, range, 220);
    if (working.length < 45) return [];
    const atr = averageAtr(working);
    const priceRange = Math.max(...working.map((bar) => bar.high)) - Math.min(...working.map((bar) => bar.low));
    const tolerance = Math.max(atr * 0.85, priceRange * 0.008);
    const pivots = pivotPoints(working, 3, 3).slice(-12);
    const highs = pivots.filter((pivot) => pivot.type === "high").slice(-5);
    const lows = pivots.filter((pivot) => pivot.type === "low").slice(-5);
    const patterns = [];

    if (highs.length >= 2) {
      const first = highs[highs.length - 2];
      const second = highs[highs.length - 1];
      const betweenLow = lows.find((pivot) => pivot.index > first.index && pivot.index < second.index);
      if (betweenLow && nearEqual(first.price, second.price, tolerance) && Math.min(first.price, second.price) - betweenLow.price > atr * 1.4) {
        patterns.push({
          type: "double-top",
          label: "双顶",
          color: COLORS.red,
          points: [first, betweenLow, second],
          lines: [
            [first, second],
            [betweenLow, { ...betweenLow, time: second.time, index: second.index }],
          ],
        });
      }
    }

    if (lows.length >= 2) {
      const first = lows[lows.length - 2];
      const second = lows[lows.length - 1];
      const betweenHigh = highs.find((pivot) => pivot.index > first.index && pivot.index < second.index);
      if (betweenHigh && nearEqual(first.price, second.price, tolerance) && betweenHigh.price - Math.max(first.price, second.price) > atr * 1.4) {
        patterns.push({
          type: "double-bottom",
          label: "双底",
          color: COLORS.green,
          points: [first, betweenHigh, second],
          lines: [
            [first, second],
            [betweenHigh, { ...betweenHigh, time: second.time, index: second.index }],
          ],
        });
      }
    }

    if (highs.length >= 3 && lows.length >= 2) {
      const shoulderLeft = highs[highs.length - 3];
      const head = highs[highs.length - 2];
      const shoulderRight = highs[highs.length - 1];
      if (
        head.price > shoulderLeft.price + tolerance &&
        head.price > shoulderRight.price + tolerance &&
        nearEqual(shoulderLeft.price, shoulderRight.price, tolerance * 1.5)
      ) {
        patterns.push({
          type: "head-shoulders",
          label: "头肩顶",
          color: COLORS.red,
          points: [shoulderLeft, head, shoulderRight],
          lines: [
            [shoulderLeft, head],
            [head, shoulderRight],
          ],
        });
      }
    }

    if (lows.length >= 3 && highs.length >= 2) {
      const shoulderLeft = lows[lows.length - 3];
      const head = lows[lows.length - 2];
      const shoulderRight = lows[lows.length - 1];
      if (
        head.price < shoulderLeft.price - tolerance &&
        head.price < shoulderRight.price - tolerance &&
        nearEqual(shoulderLeft.price, shoulderRight.price, tolerance * 1.5)
      ) {
        patterns.push({
          type: "inverse-head-shoulders",
          label: "头肩底",
          color: COLORS.green,
          points: [shoulderLeft, head, shoulderRight],
          lines: [
            [shoulderLeft, head],
            [head, shoulderRight],
          ],
        });
      }
    }

    if (highs.length >= 3 && lows.length >= 3) {
      const recentHighs = highs.slice(-3);
      const recentLows = lows.slice(-3);
      const highSlope = (recentHighs[2].price - recentHighs[0].price) / Math.max(1, recentHighs[2].index - recentHighs[0].index);
      const lowSlope = (recentLows[2].price - recentLows[0].price) / Math.max(1, recentLows[2].index - recentLows[0].index);
      const flatHigh = Math.max(...recentHighs.map((pivot) => pivot.price)) - Math.min(...recentHighs.map((pivot) => pivot.price)) <= tolerance;
      const flatLow = Math.max(...recentLows.map((pivot) => pivot.price)) - Math.min(...recentLows.map((pivot) => pivot.price)) <= tolerance;
      if (flatHigh && lowSlope > 0) {
        patterns.push({ type: "ascending-triangle", label: "上升三角形", color: COLORS.green, points: [...recentHighs, ...recentLows], lines: [[recentHighs[0], recentHighs[2]], [recentLows[0], recentLows[2]]] });
      } else if (flatLow && highSlope < 0) {
        patterns.push({ type: "descending-triangle", label: "下降三角形", color: COLORS.red, points: [...recentHighs, ...recentLows], lines: [[recentHighs[0], recentHighs[2]], [recentLows[0], recentLows[2]]] });
      } else if (highSlope < 0 && lowSlope > 0) {
        patterns.push({ type: "sym-triangle", label: "收敛三角形", color: COLORS.amber, points: [...recentHighs, ...recentLows], lines: [[recentHighs[0], recentHighs[2]], [recentLows[0], recentLows[2]]] });
      } else if (Math.abs(highSlope - lowSlope) <= atr / Math.max(20, working.length) && Math.abs(highSlope) > atr / Math.max(80, working.length)) {
        patterns.push({ type: highSlope > 0 ? "rising-channel" : "falling-channel", label: highSlope > 0 ? "上升通道" : "下降通道", color: COLORS.blue, points: [...recentHighs, ...recentLows], lines: [[recentHighs[0], recentHighs[2]], [recentLows[0], recentLows[2]]] });
      }
    }

    return patterns.slice(-4);
  }

  function supportResistanceHeatmap(bars, range) {
    const working = visibleBarsForAnalysis(bars, range, 280);
    if (working.length < 30) return [];
    const minPrice = Math.min(...working.map((bar) => bar.low));
    const maxPrice = Math.max(...working.map((bar) => bar.high));
    if (!isFiniteNumber(minPrice) || !isFiniteNumber(maxPrice) || maxPrice <= minPrice) return [];

    const bucketCount = 64;
    const step = (maxPrice - minPrice) / bucketCount;
    const buckets = Array.from({ length: bucketCount }, (_item, index) => ({
      low: minPrice + step * index,
      high: minPrice + step * (index + 1),
      weight: 0,
    }));
    const pivots = pivotPoints(working, 3, 3);
    const maxVolume = Math.max(...working.map((bar) => bar.volume || 0), 1);

    const addWeight = (price, weight) => {
      const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((price - minPrice) / step)));
      buckets[index].weight += weight;
      if (index > 0) buckets[index - 1].weight += weight * 0.35;
      if (index < bucketCount - 1) buckets[index + 1].weight += weight * 0.35;
    };

    working.forEach((bar) => {
      const volumeBoost = 1 + Math.min(2, (bar.volume || 0) / maxVolume);
      if (bar.close >= bar.open) addWeight(bar.high, 1.2 * volumeBoost);
      else addWeight(bar.low, 1.2 * volumeBoost);
      if (Math.abs(bar.close - bar.open) <= (bar.high - bar.low) * 0.25) {
        addWeight((bar.high + bar.low) / 2, 0.65 * volumeBoost);
      }
    });
    pivots.forEach((pivot) => addWeight(pivot.price, 3));

    const maxWeight = Math.max(...buckets.map((bucket) => bucket.weight), 1);
    return buckets
      .map((bucket, index) => ({ ...bucket, index, strength: bucket.weight / maxWeight }))
      .filter((bucket) => bucket.strength >= 0.32)
      .sort((left, right) => right.strength - left.strength)
      .slice(0, 14)
      .sort((left, right) => right.high - left.high);
  }

  function overlaySvg(panel, className = "auto-structure-svg") {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.classList.add("drawing-svg", className);
    panel.fvgLayer.appendChild(svg);
    return svg;
  }

  function overlayLine(svg, x1, y1, x2, y2, color, width = 1.4, dash = "") {
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", x1);
    line.setAttribute("y1", y1);
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    line.setAttribute("stroke", color);
    line.setAttribute("stroke-width", width);
    line.setAttribute("opacity", "0.82");
    if (dash) line.setAttribute("stroke-dasharray", dash);
    svg.appendChild(line);
  }

  function overlayLabel(panel, x, y, text, color) {
    const label = document.createElement("div");
    label.className = "auto-structure-label";
    label.textContent = text;
    label.style.left = `${x}px`;
    label.style.top = `${y}px`;
    label.style.borderColor = color;
    label.style.color = color;
    panel.fvgLayer.appendChild(label);
  }

  function drawAutoTrendlinesOverlay(panel, result) {
    const lines = result.lines || [];
    if (!lines.length) return;
    const svg = overlaySvg(panel, "auto-trendline-svg");
    const timeScale = panel.chart.timeScale();
    lines.forEach((line) => {
      const x1 = timeScale.timeToCoordinate(line.startTime);
      const x2 = timeScale.timeToCoordinate(line.endTime);
      const y1 = panel.candleSeries.priceToCoordinate(line.startPrice);
      const y2 = panel.candleSeries.priceToCoordinate(line.endPrice);
      if ([x1, x2, y1, y2].some((value) => value === null || Number.isNaN(value))) return;
      overlayLine(svg, x1, y1, x2, y2, line.color, line.touches >= 3 ? 2 : 1.3);
      overlayLabel(panel, x2, y2, `${line.type === "low" ? "支撑" : "压力"} x${line.touches}`, line.color);
    });
  }

  function drawChartPatternsOverlay(panel, result) {
    const patterns = result.patterns || [];
    if (!patterns.length) return;
    const svg = overlaySvg(panel, "auto-pattern-svg");
    const timeScale = panel.chart.timeScale();
    patterns.forEach((pattern) => {
      (pattern.lines || []).forEach(([first, second]) => {
        const x1 = timeScale.timeToCoordinate(first.time);
        const y1 = panel.candleSeries.priceToCoordinate(first.price);
        const x2 = timeScale.timeToCoordinate(second.time);
        const y2 = panel.candleSeries.priceToCoordinate(second.price);
        if ([x1, y1, x2, y2].some((value) => value === null || Number.isNaN(value))) return;
        overlayLine(svg, x1, y1, x2, y2, pattern.color, 1.6, pattern.type.includes("triangle") ? "5 3" : "");
      });
      const anchor = pattern.points?.[pattern.points.length - 1];
      if (!anchor) return;
      const x = timeScale.timeToCoordinate(anchor.time);
      const y = panel.candleSeries.priceToCoordinate(anchor.price);
      if (x !== null && y !== null) overlayLabel(panel, x, y, pattern.label, pattern.color);
    });
  }

  function drawSupportResistanceHeatmapOverlay(panel, result) {
    const zones = result.zones || [];
    if (!zones.length) return;
    const width = panel.chartHost.clientWidth;
    zones.forEach((zone) => {
      const yTop = panel.candleSeries.priceToCoordinate(zone.high);
      const yBottom = panel.candleSeries.priceToCoordinate(zone.low);
      if (yTop === null || yBottom === null) return;
      const node = document.createElement("div");
      node.className = "sr-heat-zone";
      node.style.top = `${Math.min(yTop, yBottom)}px`;
      node.style.height = `${Math.max(3, Math.abs(yBottom - yTop))}px`;
      node.style.width = `${width}px`;
      node.style.opacity = String(0.12 + zone.strength * 0.5);
      panel.fvgLayer.appendChild(node);
    });
  }

  function drawFvgOverlay(panel, result) {
    const gaps = result.gaps || [];
    const last = panel.bars[panel.bars.length - 1];
    if (!last) return;
    const timeScale = panel.chart.timeScale();
    gaps.slice(-18).forEach((gap) => {
      const x1 = timeScale.timeToCoordinate(gap.fromTime);
      const x2 = timeScale.timeToCoordinate(gap.toTime || last.time);
      const yTop = panel.candleSeries.priceToCoordinate(gap.top);
      const yBottom = panel.candleSeries.priceToCoordinate(gap.bottom);
      if ([x1, x2, yTop, yBottom].some((value) => value === null || Number.isNaN(value))) return;
      const node = document.createElement("div");
      node.className = `fvg-box ${gap.direction}`;
      node.style.left = `${Math.min(x1, x2)}px`;
      node.style.width = `${Math.max(6, Math.abs(x2 - x1))}px`;
      node.style.top = `${Math.min(yTop, yBottom)}px`;
      node.style.height = `${Math.max(4, Math.abs(yBottom - yTop))}px`;
      panel.fvgLayer.appendChild(node);
    });
  }

  function drawVolumeProfileOverlay(panel, result) {
    const profile = result.profile;
    if (!profile) return;
    panel.priceLines.push(
      panel.candleSeries.createPriceLine({
        price: profile.poc,
        color: COLORS.amber,
        lineWidth: 2,
        lineStyle: 0,
        axisLabelVisible: true,
        title: "POC",
      }),
      panel.candleSeries.createPriceLine({
        price: profile.vah,
        color: COLORS.teal,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "VAH",
      }),
      panel.candleSeries.createPriceLine({
        price: profile.val,
        color: COLORS.teal,
        lineWidth: 1,
        lineStyle: 2,
        axisLabelVisible: true,
        title: "VAL",
      }),
    );

    const maxVolume = Math.max(...profile.buckets.map((bucket) => bucket.volume), 1);
    const widthLimit = Math.max(42, panel.chartHost.clientWidth * 0.22);
    profile.buckets.forEach((bucket, index) => {
      const yTop = panel.candleSeries.priceToCoordinate(bucket.high);
      const yBottom = panel.candleSeries.priceToCoordinate(bucket.low);
      if (yTop === null || yBottom === null) return;
      const node = document.createElement("div");
      node.className = [
        "vp-bar",
        index === profile.pocIndex ? "is-poc" : "",
        index >= profile.valIndex && index <= profile.vahIndex ? "in-value" : "",
      ]
        .filter(Boolean)
        .join(" ");
      node.style.top = `${Math.min(yTop, yBottom)}px`;
      node.style.height = `${Math.max(2, Math.abs(yBottom - yTop) - 1)}px`;
      node.style.width = `${Math.max(3, (bucket.volume / maxVolume) * widthLimit)}px`;
      panel.vpLayer.appendChild(node);
    });
  }

  function drawMarkerOverlay(panel, result) {
    const markers = result.markers || [];
    const timeScale = panel.chart.timeScale();
    markers.slice(-80).forEach((marker) => {
      const x = timeScale.timeToCoordinate(marker.time);
      const y = panel.candleSeries.priceToCoordinate(marker.price);
      if (x === null || y === null) return;
      const node = document.createElement("div");
      node.className = `structure-marker ${marker.direction}`;
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
      panel.fvgLayer.appendChild(node);
    });
  }

  function movingAverageFactory(key, label, category, period, method, color, defaultOn = false) {
    const valueFn =
      method === "EMA"
        ? emaValues
        : method === "WMA"
          ? wmaValues
          : method === "HMA"
            ? hmaValues
            : method === "SMMA"
              ? rmaValues
              : smaValues;
    registerIndicator({
      key,
      label,
      category,
      defaultOn,
      series: [{ id: "line", pane: "main", type: "LineSeries", options: { color, lineWidth: 1, priceLineVisible: false } }],
      calculate(bars) {
        return { series: { line: seriesFromValues(bars, valueFn(fieldValues(bars, "close"), period)) } };
      },
    });
  }

  function mainLine(id, color, lineWidth = 1) {
    return { id, pane: "main", type: "LineSeries", options: { color, lineWidth, priceLineVisible: false } };
  }

  function paneLine(id, pane, color, lineWidth = 1) {
    return { id, pane, type: "LineSeries", options: { color, lineWidth, priceLineVisible: false } };
  }

  function paneHistogram(id, pane) {
    return { id, pane, type: "HistogramSeries", options: { priceLineVisible: false } };
  }

  registerIndicator({
    key: "fvg",
    label: "Fair Value Gaps",
    category: "必备",
    defaultOn: true,
    calculate(bars) {
      return { gaps: fairValueGaps(bars) };
    },
    renderOverlay: drawFvgOverlay,
  });

  registerIndicator({
    key: "vp",
    label: "Volume Profile POC/VA",
    category: "必备",
    defaultOn: true,
    calculate(bars, context) {
      return { profile: volumeProfile(bars, context.visibleRange) };
    },
    renderOverlay: drawVolumeProfileOverlay,
  });

  registerIndicator({
    key: "volume",
    label: "成交量",
    category: "必备",
    defaultOn: true,
    series: [
      {
        id: "bars",
        pane: "main",
        type: "HistogramSeries",
        options: { priceFormat: { type: "volume" }, priceScaleId: "", color: "rgba(154, 163, 175, 0.32)" },
        priceScaleOptions: { scaleMargins: { top: 0.78, bottom: 0 } },
      },
    ],
    calculate(bars) {
      return {
        series: {
          bars: bars.map((bar) => ({
            time: bar.time,
            value: bar.volume || 0,
            color: bar.close >= bar.open ? "rgba(34, 197, 94, 0.28)" : "rgba(239, 83, 80, 0.28)",
          })),
        },
      };
    },
  });

  movingAverageFactory("ma20", "SMA20", "均线", 20, "SMA", COLORS.amber, true);
  movingAverageFactory("sma50", "SMA50", "均线", 50, "SMA", "#f97316");
  movingAverageFactory("sma200", "SMA200", "均线", 200, "SMA", "#f43f5e");
  movingAverageFactory("ema20", "EMA20", "均线", 20, "EMA", COLORS.teal);
  movingAverageFactory("ema50", "EMA50", "均线", 50, "EMA", COLORS.cyan, true);
  movingAverageFactory("ema200", "EMA200", "均线", 200, "EMA", COLORS.purple);
  movingAverageFactory("wma20", "WMA20", "均线", 20, "WMA", "#a3e635");
  movingAverageFactory("hma20", "HMA20", "均线", 20, "HMA", "#2dd4bf");
  movingAverageFactory("smma20", "SMMA20", "均线", 20, "SMMA", "#c084fc");

  registerIndicator({
    key: "vwma20",
    label: "VWMA20",
    category: "均线",
    series: [mainLine("line", "#84cc16")],
    calculate(bars) {
      const numerator = rollingSum(bars.map((bar) => bar.close * (bar.volume || 0)), 20);
      const denominator = rollingSum(bars.map((bar) => bar.volume || 0), 20);
      const values = numerator.map((value, index) => (!denominator[index] ? null : value / denominator[index]));
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "vwap",
    label: "VWAP",
    category: "均线",
    series: [mainLine("line", COLORS.purple)],
    calculate(bars) {
      const output = [];
      let currentDay = "";
      let cumulativePv = 0;
      let cumulativeVolume = 0;
      bars.forEach((bar) => {
        const day = new Date(bar.time * 1000).toISOString().slice(0, 10);
        if (day !== currentDay) {
          currentDay = day;
          cumulativePv = 0;
          cumulativeVolume = 0;
        }
        const volume = Math.max(Number(bar.volume) || 0, 0);
        const typical = (bar.high + bar.low + bar.close) / 3;
        cumulativePv += typical * volume;
        cumulativeVolume += volume;
        if (cumulativeVolume > 0) output.push({ time: bar.time, value: cumulativePv / cumulativeVolume });
      });
      return { series: { line: output } };
    },
  });

  registerIndicator({
    key: "bollinger",
    label: "布林带20",
    category: "通道",
    series: [mainLine("upper", COLORS.blue), mainLine("basis", "#94a3b8"), mainLine("lower", COLORS.blue)],
    calculate(bars) {
      const closes = fieldValues(bars, "close");
      const basis = smaValues(closes, 20);
      const dev = stdDevValues(closes, 20);
      return {
        series: {
          upper: seriesFromValues(bars, basis.map((value, index) => (value === null ? null : value + 2 * dev[index]))),
          basis: seriesFromValues(bars, basis),
          lower: seriesFromValues(bars, basis.map((value, index) => (value === null ? null : value - 2 * dev[index]))),
        },
      };
    },
  });

  registerIndicator({
    key: "keltner",
    label: "Keltner通道",
    category: "通道",
    series: [mainLine("upper", "#60a5fa"), mainLine("basis", "#94a3b8"), mainLine("lower", "#60a5fa")],
    calculate(bars) {
      const basis = emaValues(fieldValues(bars, "close"), 20);
      const atr = atrValues(bars, 20);
      return {
        series: {
          upper: seriesFromValues(bars, basis.map((value, index) => (value === null ? null : value + 2 * atr[index]))),
          basis: seriesFromValues(bars, basis),
          lower: seriesFromValues(bars, basis.map((value, index) => (value === null ? null : value - 2 * atr[index]))),
        },
      };
    },
  });

  registerIndicator({
    key: "donchian",
    label: "Donchian通道20",
    category: "通道",
    series: [mainLine("upper", "#38bdf8"), mainLine("basis", "#94a3b8"), mainLine("lower", "#38bdf8")],
    calculate(bars) {
      const highs = highestValues(fieldValues(bars, "high"), 20);
      const lows = lowestValues(fieldValues(bars, "low"), 20);
      return {
        series: {
          upper: seriesFromValues(bars, highs),
          basis: seriesFromValues(bars, highs.map((value, index) => (value === null ? null : (value + lows[index]) / 2))),
          lower: seriesFromValues(bars, lows),
        },
      };
    },
  });

  registerIndicator({
    key: "envelope",
    label: "均线包络线",
    category: "通道",
    series: [mainLine("upper", "#f472b6"), mainLine("basis", "#94a3b8"), mainLine("lower", "#f472b6")],
    calculate(bars) {
      const basis = smaValues(fieldValues(bars, "close"), 20);
      return {
        series: {
          upper: seriesFromValues(bars, basis.map((value) => (value === null ? null : value * 1.025))),
          basis: seriesFromValues(bars, basis),
          lower: seriesFromValues(bars, basis.map((value) => (value === null ? null : value * 0.975))),
        },
      };
    },
  });

  registerIndicator({
    key: "ichimoku",
    label: "Ichimoku云图",
    category: "趋势",
    series: [
      mainLine("tenkan", "#f97316"),
      mainLine("kijun", COLORS.blue),
      mainLine("senkouA", COLORS.green),
      mainLine("senkouB", COLORS.red),
      mainLine("chikou", "#a78bfa"),
    ],
    calculate(bars, context) {
      const highs = fieldValues(bars, "high");
      const lows = fieldValues(bars, "low");
      const conversion = highestValues(highs, 9).map((value, index) =>
        value === null ? null : (value + lowestValues(lows, 9)[index]) / 2,
      );
      const baseHigh = highestValues(highs, 26);
      const baseLow = lowestValues(lows, 26);
      const base = baseHigh.map((value, index) => (value === null ? null : (value + baseLow[index]) / 2));
      const spanBHigh = highestValues(highs, 52);
      const spanBLow = lowestValues(lows, 52);
      const spanB = spanBHigh.map((value, index) => (value === null ? null : (value + spanBLow[index]) / 2));
      const shiftSeconds = (context.intervalSeconds || 60) * 26;
      return {
        series: {
          tenkan: seriesFromValues(bars, conversion),
          kijun: seriesFromValues(bars, base),
          senkouA: compact(
            bars.map((bar, index) =>
              conversion[index] === null || base[index] === null
                ? null
                : { time: bar.time + shiftSeconds, value: (conversion[index] + base[index]) / 2 },
            ),
          ),
          senkouB: compact(
            bars.map((bar, index) => (spanB[index] === null ? null : { time: bar.time + shiftSeconds, value: spanB[index] })),
          ),
          chikou: compact(
            bars.map((bar, index) => (index < 26 ? null : { time: bars[index - 26].time, value: bar.close })),
          ),
        },
      };
    },
  });

  registerIndicator({
    key: "supertrend",
    label: "Supertrend",
    category: "趋势",
    series: [mainLine("line", COLORS.green, 2)],
    calculate(bars) {
      const period = 10;
      const multiplier = 3;
      const atr = atrValues(bars, period);
      const upper = Array(bars.length).fill(null);
      const lower = Array(bars.length).fill(null);
      const trend = Array(bars.length).fill(null);
      for (let index = 0; index < bars.length; index += 1) {
        if (atr[index] === null) continue;
        const hl2 = (bars[index].high + bars[index].low) / 2;
        const basicUpper = hl2 + multiplier * atr[index];
        const basicLower = hl2 - multiplier * atr[index];
        if (index === 0 || upper[index - 1] === null) {
          upper[index] = basicUpper;
          lower[index] = basicLower;
          trend[index] = basicLower;
          continue;
        }
        upper[index] = basicUpper < upper[index - 1] || bars[index - 1].close > upper[index - 1] ? basicUpper : upper[index - 1];
        lower[index] = basicLower > lower[index - 1] || bars[index - 1].close < lower[index - 1] ? basicLower : lower[index - 1];
        trend[index] =
          trend[index - 1] === upper[index - 1]
            ? bars[index].close <= upper[index]
              ? upper[index]
              : lower[index]
            : bars[index].close >= lower[index]
              ? lower[index]
              : upper[index];
      }
      return {
        series: {
          line: seriesFromValues(bars, trend, (value, index) => (bars[index].close >= value ? COLORS.green : COLORS.red)),
        },
      };
    },
  });

  registerIndicator({
    key: "chandelier",
    label: "Chandelier Exit",
    category: "趋势",
    series: [mainLine("long", COLORS.green), mainLine("short", COLORS.red)],
    calculate(bars) {
      const atr = atrValues(bars, 22);
      const highest = highestValues(fieldValues(bars, "high"), 22);
      const lowest = lowestValues(fieldValues(bars, "low"), 22);
      return {
        series: {
          long: seriesFromValues(bars, highest.map((value, index) => (value === null ? null : value - 3 * atr[index]))),
          short: seriesFromValues(bars, lowest.map((value, index) => (value === null ? null : value + 3 * atr[index]))),
        },
      };
    },
  });

  registerIndicator({
    key: "psar",
    label: "Parabolic SAR",
    category: "趋势",
    series: [mainLine("line", "#fbbf24")],
    calculate(bars) {
      if (bars.length < 3) return { series: { line: [] } };
      const psar = Array(bars.length).fill(null);
      let rising = bars[1].close >= bars[0].close;
      let acceleration = 0.02;
      let extreme = rising ? Math.max(bars[0].high, bars[1].high) : Math.min(bars[0].low, bars[1].low);
      psar[1] = rising ? Math.min(bars[0].low, bars[1].low) : Math.max(bars[0].high, bars[1].high);
      for (let index = 2; index < bars.length; index += 1) {
        let value = psar[index - 1] + acceleration * (extreme - psar[index - 1]);
        if (rising) {
          value = Math.min(value, bars[index - 1].low, bars[index - 2].low);
          if (bars[index].low < value) {
            rising = false;
            value = extreme;
            extreme = bars[index].low;
            acceleration = 0.02;
          } else if (bars[index].high > extreme) {
            extreme = bars[index].high;
            acceleration = Math.min(acceleration + 0.02, 0.2);
          }
        } else {
          value = Math.max(value, bars[index - 1].high, bars[index - 2].high);
          if (bars[index].high > value) {
            rising = true;
            value = extreme;
            extreme = bars[index].high;
            acceleration = 0.02;
          } else if (bars[index].low < extreme) {
            extreme = bars[index].low;
            acceleration = Math.min(acceleration + 0.02, 0.2);
          }
        }
        psar[index] = value;
      }
      return { series: { line: seriesFromValues(bars, psar) } };
    },
  });

  registerIndicator({
    key: "zigzag",
    label: "Zig Zag 5%",
    category: "结构",
    series: [mainLine("line", "#facc15", 2)],
    calculate(bars) {
      if (bars.length < 2) return { series: { line: [] } };
      const pivots = [{ time: bars[0].time, value: bars[0].close }];
      let lastPivot = bars[0].close;
      let direction = 0;
      for (let index = 1; index < bars.length; index += 1) {
        const close = bars[index].close;
        const change = (close - lastPivot) / lastPivot;
        if (direction >= 0 && change <= -0.05) {
          direction = -1;
          pivots.push({ time: bars[index].time, value: close });
          lastPivot = close;
        } else if (direction <= 0 && change >= 0.05) {
          direction = 1;
          pivots.push({ time: bars[index].time, value: close });
          lastPivot = close;
        } else if ((direction >= 0 && close > lastPivot) || (direction <= 0 && close < lastPivot)) {
          pivots[pivots.length - 1] = { time: bars[index].time, value: close };
          lastPivot = close;
        }
      }
      return { series: { line: pivots } };
    },
  });

  registerIndicator({
    key: "fractals",
    label: "Williams Fractals",
    category: "结构",
    calculate(bars) {
      const markers = [];
      for (let index = 2; index < bars.length - 2; index += 1) {
        const high = bars[index].high;
        const low = bars[index].low;
        if ([1, 2].every((offset) => high > bars[index - offset].high && high > bars[index + offset].high)) {
          markers.push({ time: bars[index].time, price: high, direction: "down" });
        }
        if ([1, 2].every((offset) => low < bars[index - offset].low && low < bars[index + offset].low)) {
          markers.push({ time: bars[index].time, price: low, direction: "up" });
        }
      }
      return { markers };
    },
    renderOverlay: drawMarkerOverlay,
  });

  registerIndicator({
    key: "auto_trendlines",
    label: "自动趋势线",
    category: "结构",
    calculate(bars, context) {
      return { lines: autoTrendlines(bars, context.visibleRange) };
    },
    renderOverlay: drawAutoTrendlinesOverlay,
  });

  registerIndicator({
    key: "auto_patterns",
    label: "自动形态识别",
    category: "结构",
    calculate(bars, context) {
      return { patterns: detectChartPatterns(bars, context.visibleRange) };
    },
    renderOverlay: drawChartPatternsOverlay,
  });

  registerIndicator({
    key: "sr_heatmap",
    label: "支撑压力热力图",
    category: "结构",
    calculate(bars, context) {
      return { zones: supportResistanceHeatmap(bars, context.visibleRange) };
    },
    renderOverlay: drawSupportResistanceHeatmapOverlay,
  });

  registerIndicator({
    key: "rsi",
    label: "RSI14",
    category: "动量",
    series: [paneLine("line", "momentum", COLORS.orange)],
    calculate(bars) {
      return { series: { line: seriesFromValues(bars, rsiValues(bars, 14)) } };
    },
  });

  registerIndicator({
    key: "stoch",
    label: "Stochastic 14",
    category: "动量",
    series: [paneLine("k", "momentum", COLORS.teal), paneLine("d", "momentum", COLORS.amber)],
    calculate(bars) {
      const data = stochasticValues(bars, 14, 3, 3);
      return { series: { k: seriesFromValues(bars, data.k), d: seriesFromValues(bars, data.d) } };
    },
  });

  registerIndicator({
    key: "stoch_rsi",
    label: "Stoch RSI",
    category: "动量",
    series: [paneLine("k", "momentum", COLORS.cyan), paneLine("d", "momentum", COLORS.pink)],
    calculate(bars) {
      const rsiData = rsiValues(bars, 14);
      const highest = highestValues(rsiData.map((value) => (value === null ? 0 : value)), 14);
      const lowest = lowestValues(rsiData.map((value) => (value === null ? 0 : value)), 14);
      const raw = rsiData.map((value, index) => {
        if (value === null || highest[index] === lowest[index]) return null;
        return ((value - lowest[index]) / (highest[index] - lowest[index])) * 100;
      });
      const k = smaValues(raw.map((value) => (value === null ? 0 : value)), 3).map((value, index) =>
        raw[index] === null ? null : value,
      );
      const d = smaValues(k.map((value) => (value === null ? 0 : value)), 3).map((value, index) =>
        k[index] === null ? null : value,
      );
      return { series: { k: seriesFromValues(bars, k), d: seriesFromValues(bars, d) } };
    },
  });

  registerIndicator({
    key: "cci",
    label: "CCI20",
    category: "动量",
    series: [paneLine("line", "macd", "#c084fc")],
    calculate(bars) {
      const typical = typicalPrices(bars);
      const average = smaValues(typical, 20);
      const deviation = meanDeviationValues(typical, 20, average);
      const values = typical.map((value, index) =>
        !deviation[index] ? null : (value - average[index]) / (0.015 * deviation[index]),
      );
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "mfi",
    label: "MFI14",
    category: "动量",
    series: [paneLine("line", "momentum", "#34d399")],
    calculate(bars) {
      return { series: { line: seriesFromValues(bars, moneyFlowIndexValues(bars, 14)) } };
    },
  });

  registerIndicator({
    key: "williams_r",
    label: "Williams %R",
    category: "动量",
    series: [paneLine("line", "momentum", "#f87171")],
    calculate(bars) {
      const highs = highestValues(fieldValues(bars, "high"), 14);
      const lows = lowestValues(fieldValues(bars, "low"), 14);
      const values = bars.map((bar, index) => {
        const range = highs[index] - lows[index];
        return !range ? null : ((highs[index] - bar.close) / range) * -100;
      });
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "roc",
    label: "ROC12",
    category: "动量",
    series: [paneLine("line", "macd", COLORS.blue)],
    calculate(bars) {
      const values = bars.map((bar, index) => (index < 12 ? null : ((bar.close - bars[index - 12].close) / bars[index - 12].close) * 100));
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "momentum",
    label: "Momentum10",
    category: "动量",
    series: [paneLine("line", "macd", COLORS.gray)],
    calculate(bars) {
      return { series: { line: seriesFromValues(bars, bars.map((bar, index) => (index < 10 ? null : bar.close - bars[index - 10].close))) } };
    },
  });

  registerIndicator({
    key: "macd",
    label: "MACD",
    category: "动量",
    series: [paneLine("line", "macd", COLORS.teal), paneLine("signal", "macd", COLORS.amber), paneHistogram("histogram", "macd")],
    calculate(bars) {
      const data = buildMacdValues(fieldValues(bars, "close"));
      return {
        series: {
          line: seriesFromValues(bars, data.line),
          signal: seriesFromValues(bars, data.signal),
          histogram: seriesFromValues(bars, data.histogram, (value) =>
            value >= 0 ? "rgba(34, 197, 94, 0.48)" : "rgba(239, 83, 80, 0.48)",
          ),
        },
      };
    },
  });

  registerIndicator({
    key: "awesome",
    label: "Awesome Oscillator",
    category: "动量",
    series: [paneHistogram("histogram", "macd")],
    calculate(bars) {
      const median = medianPrices(bars);
      const fast = smaValues(median, 5);
      const slow = smaValues(median, 34);
      const values = median.map((_value, index) => (fast[index] === null || slow[index] === null ? null : fast[index] - slow[index]));
      return {
        series: {
          histogram: seriesFromValues(bars, values, (value, index, list) =>
            index > 0 && value >= (list[index - 1] || value) ? "rgba(34, 197, 94, 0.52)" : "rgba(239, 83, 80, 0.52)",
          ),
        },
      };
    },
  });

  registerIndicator({
    key: "adx",
    label: "ADX/DMI14",
    category: "趋势",
    series: [paneLine("adx", "trend", COLORS.amber), paneLine("plus", "trend", COLORS.green), paneLine("minus", "trend", COLORS.red)],
    calculate(bars) {
      const plusDm = Array(bars.length).fill(0);
      const minusDm = Array(bars.length).fill(0);
      for (let index = 1; index < bars.length; index += 1) {
        const upMove = bars[index].high - bars[index - 1].high;
        const downMove = bars[index - 1].low - bars[index].low;
        plusDm[index] = upMove > downMove && upMove > 0 ? upMove : 0;
        minusDm[index] = downMove > upMove && downMove > 0 ? downMove : 0;
      }
      const atr = atrValues(bars, 14);
      const plus = rmaValues(plusDm, 14).map((value, index) => (!atr[index] ? null : (100 * value) / atr[index]));
      const minus = rmaValues(minusDm, 14).map((value, index) => (!atr[index] ? null : (100 * value) / atr[index]));
      const dx = plus.map((value, index) => {
        const total = value + minus[index];
        return !total ? null : (100 * Math.abs(value - minus[index])) / total;
      });
      const adx = rmaValues(dx.map((value) => (value === null ? 0 : value)), 14).map((value, index) => (dx[index] === null ? null : value));
      return { series: { adx: seriesFromValues(bars, adx), plus: seriesFromValues(bars, plus), minus: seriesFromValues(bars, minus) } };
    },
  });

  registerIndicator({
    key: "aroon",
    label: "Aroon 14",
    category: "趋势",
    series: [paneLine("up", "trend", COLORS.green), paneLine("down", "trend", COLORS.red), paneLine("osc", "macd", COLORS.blue)],
    calculate(bars) {
      const period = 14;
      const up = Array(bars.length).fill(null);
      const down = Array(bars.length).fill(null);
      for (let index = period - 1; index < bars.length; index += 1) {
        const window = bars.slice(index - period + 1, index + 1);
        const highIndex = window.reduce((best, bar, pos) => (bar.high >= window[best].high ? pos : best), 0);
        const lowIndex = window.reduce((best, bar, pos) => (bar.low <= window[best].low ? pos : best), 0);
        up[index] = ((highIndex + 1) / period) * 100;
        down[index] = ((lowIndex + 1) / period) * 100;
      }
      return {
        series: {
          up: seriesFromValues(bars, up),
          down: seriesFromValues(bars, down),
          osc: seriesFromValues(bars, up.map((value, index) => (value === null ? null : value - down[index]))),
        },
      };
    },
  });

  registerIndicator({
    key: "ultimate",
    label: "Ultimate Oscillator",
    category: "动量",
    series: [paneLine("line", "momentum", "#fde047")],
    calculate(bars) {
      const bp = Array(bars.length).fill(0);
      const tr = Array(bars.length).fill(0);
      for (let index = 0; index < bars.length; index += 1) {
        const prevClose = index === 0 ? bars[index].close : bars[index - 1].close;
        bp[index] = bars[index].close - Math.min(bars[index].low, prevClose);
        tr[index] = Math.max(bars[index].high, prevClose) - Math.min(bars[index].low, prevClose);
      }
      const sum7 = rollingSum(bp, 7);
      const tr7 = rollingSum(tr, 7);
      const sum14 = rollingSum(bp, 14);
      const tr14 = rollingSum(tr, 14);
      const sum28 = rollingSum(bp, 28);
      const tr28 = rollingSum(tr, 28);
      const values = bars.map((_bar, index) =>
        !tr7[index] || !tr14[index] || !tr28[index]
          ? null
          : (100 * (4 * (sum7[index] / tr7[index]) + 2 * (sum14[index] / tr14[index]) + sum28[index] / tr28[index])) / 7,
      );
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "cmo",
    label: "CMO14",
    category: "动量",
    series: [paneLine("line", "macd", "#22d3ee")],
    calculate(bars) {
      const gains = Array(bars.length).fill(0);
      const losses = Array(bars.length).fill(0);
      for (let index = 1; index < bars.length; index += 1) {
        const change = bars[index].close - bars[index - 1].close;
        gains[index] = Math.max(change, 0);
        losses[index] = Math.max(-change, 0);
      }
      const gainSum = rollingSum(gains, 14);
      const lossSum = rollingSum(losses, 14);
      const values = gainSum.map((gain, index) => {
        const total = gain + lossSum[index];
        return !total ? null : (100 * (gain - lossSum[index])) / total;
      });
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "fisher",
    label: "Fisher Transform",
    category: "动量",
    series: [paneLine("line", "macd", COLORS.purple), paneLine("signal", "macd", COLORS.amber)],
    calculate(bars) {
      const median = medianPrices(bars);
      const highest = highestValues(median, 10);
      const lowest = lowestValues(median, 10);
      const value = Array(bars.length).fill(null);
      const fisher = Array(bars.length).fill(null);
      for (let index = 1; index < bars.length; index += 1) {
        if (highest[index] === null || highest[index] === lowest[index]) continue;
        const normalized = 2 * ((median[index] - lowest[index]) / (highest[index] - lowest[index]) - 0.5);
        value[index] = Math.max(Math.min(0.33 * normalized + 0.67 * (value[index - 1] || 0), 0.999), -0.999);
        fisher[index] = 0.5 * Math.log((1 + value[index]) / (1 - value[index])) + 0.5 * (fisher[index - 1] || 0);
      }
      const signal = fisher.map((item, index) => (index === 0 ? null : fisher[index - 1]));
      return { series: { line: seriesFromValues(bars, fisher), signal: seriesFromValues(bars, signal) } };
    },
  });

  registerIndicator({
    key: "tsi",
    label: "TSI",
    category: "动量",
    series: [paneLine("line", "macd", COLORS.teal), paneLine("signal", "macd", COLORS.amber)],
    calculate(bars) {
      const momentum = bars.map((bar, index) => (index === 0 ? 0 : bar.close - bars[index - 1].close));
      const absMomentum = momentum.map(Math.abs);
      const double = emaValues(emaValues(momentum, 25).map((value) => value || 0), 13);
      const doubleAbs = emaValues(emaValues(absMomentum, 25).map((value) => value || 0), 13);
      const tsi = double.map((value, index) => (!doubleAbs[index] ? null : (100 * value) / doubleAbs[index]));
      const signal = emaValues(tsi.map((value) => value || 0), 7).map((value, index) => (tsi[index] === null ? null : value));
      return { series: { line: seriesFromValues(bars, tsi), signal: seriesFromValues(bars, signal) } };
    },
  });

  registerIndicator({
    key: "trix",
    label: "TRIX",
    category: "动量",
    series: [paneLine("line", "macd", COLORS.cyan), paneLine("signal", "macd", COLORS.pink)],
    calculate(bars) {
      const closes = fieldValues(bars, "close");
      const triple = emaValues(emaValues(emaValues(closes, 15).map((value) => value || 0), 15).map((value) => value || 0), 15);
      const trix = triple.map((value, index) => (index === 0 || !triple[index - 1] ? null : ((value - triple[index - 1]) / triple[index - 1]) * 100));
      const signal = emaValues(trix.map((value) => value || 0), 9).map((value, index) => (trix[index] === null ? null : value));
      return { series: { line: seriesFromValues(bars, trix), signal: seriesFromValues(bars, signal) } };
    },
  });

  registerIndicator({
    key: "ppo",
    label: "PPO",
    category: "动量",
    series: [paneLine("line", "macd", COLORS.blue), paneLine("signal", "macd", COLORS.amber), paneHistogram("histogram", "macd")],
    calculate(bars) {
      const closes = fieldValues(bars, "close");
      const fast = emaValues(closes, 12);
      const slow = emaValues(closes, 26);
      const line = closes.map((_value, index) => (!slow[index] || fast[index] === null ? null : ((fast[index] - slow[index]) / slow[index]) * 100));
      const signal = emaValues(line.map((value) => value || 0), 9).map((value, index) => (line[index] === null ? null : value));
      const histogram = line.map((value, index) => (value === null || signal[index] === null ? null : value - signal[index]));
      return {
        series: {
          line: seriesFromValues(bars, line),
          signal: seriesFromValues(bars, signal),
          histogram: seriesFromValues(bars, histogram, (value) => (value >= 0 ? "rgba(34,197,94,0.45)" : "rgba(239,83,80,0.45)")),
        },
      };
    },
  });

  registerIndicator({
    key: "dpo",
    label: "DPO20",
    category: "动量",
    series: [paneLine("line", "macd", "#a3e635")],
    calculate(bars) {
      const period = 20;
      const offset = Math.floor(period / 2) + 1;
      const sma = smaValues(fieldValues(bars, "close"), period);
      const values = bars.map((_bar, index) => (index < offset || sma[index] === null ? null : bars[index - offset].close - sma[index]));
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "kst",
    label: "KST",
    category: "动量",
    series: [paneLine("line", "macd", COLORS.teal), paneLine("signal", "macd", COLORS.amber)],
    calculate(bars) {
      const closes = fieldValues(bars, "close");
      const roc = (period) => closes.map((close, index) => (index < period ? null : ((close - closes[index - period]) / closes[index - period]) * 100));
      const a = smaValues(roc(10).map((value) => value || 0), 10);
      const b = smaValues(roc(15).map((value) => value || 0), 10);
      const c = smaValues(roc(20).map((value) => value || 0), 10);
      const d = smaValues(roc(30).map((value) => value || 0), 15);
      const kst = closes.map((_value, index) => (index < 44 ? null : a[index] + 2 * b[index] + 3 * c[index] + 4 * d[index]));
      const signal = smaValues(kst.map((value) => value || 0), 9).map((value, index) => (kst[index] === null ? null : value));
      return { series: { line: seriesFromValues(bars, kst), signal: seriesFromValues(bars, signal) } };
    },
  });

  registerIndicator({
    key: "bop",
    label: "Balance of Power",
    category: "动量",
    series: [paneHistogram("histogram", "macd")],
    calculate(bars) {
      const values = bars.map((bar) => {
        const range = bar.high - bar.low;
        return !range ? null : (bar.close - bar.open) / range;
      });
      return {
        series: {
          histogram: seriesFromValues(bars, values, (value) => (value >= 0 ? "rgba(34,197,94,0.45)" : "rgba(239,83,80,0.45)")),
        },
      };
    },
  });

  registerIndicator({
    key: "atr",
    label: "ATR14",
    category: "波动率",
    series: [paneLine("line", "volatility", COLORS.orange)],
    calculate(bars) {
      return { series: { line: seriesFromValues(bars, atrValues(bars, 14)) } };
    },
  });

  registerIndicator({
    key: "stddev",
    label: "标准差20",
    category: "波动率",
    series: [paneLine("line", "volatility", COLORS.blue)],
    calculate(bars) {
      return { series: { line: seriesFromValues(bars, stdDevValues(fieldValues(bars, "close"), 20)) } };
    },
  });

  registerIndicator({
    key: "hv",
    label: "历史波动率20",
    category: "波动率",
    series: [paneLine("line", "volatility", COLORS.purple)],
    calculate(bars) {
      const logReturns = bars.map((bar, index) => (index === 0 ? 0 : Math.log(bar.close / bars[index - 1].close)));
      const sd = stdDevValues(logReturns, 20);
      const values = sd.map((value) => (value === null ? null : value * Math.sqrt(365) * 100));
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "bb_width",
    label: "布林带宽度",
    category: "波动率",
    series: [paneLine("line", "volatility", COLORS.cyan)],
    calculate(bars) {
      const closes = fieldValues(bars, "close");
      const basis = smaValues(closes, 20);
      const dev = stdDevValues(closes, 20);
      const values = basis.map((value, index) => (!value ? null : ((4 * dev[index]) / value) * 100));
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "bb_percent",
    label: "布林%B",
    category: "波动率",
    series: [paneLine("line", "momentum", "#93c5fd")],
    calculate(bars) {
      const closes = fieldValues(bars, "close");
      const basis = smaValues(closes, 20);
      const dev = stdDevValues(closes, 20);
      const values = closes.map((close, index) => {
        if (basis[index] === null || dev[index] === 0) return null;
        const upper = basis[index] + 2 * dev[index];
        const lower = basis[index] - 2 * dev[index];
        return ((close - lower) / (upper - lower)) * 100;
      });
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "chop",
    label: "Choppiness Index",
    category: "波动率",
    series: [paneLine("line", "volatility", "#fda4af")],
    calculate(bars) {
      const period = 14;
      const trSum = rollingSum(trueRanges(bars), period);
      const highs = highestValues(fieldValues(bars, "high"), period);
      const lows = lowestValues(fieldValues(bars, "low"), period);
      const values = bars.map((_bar, index) => {
        const range = highs[index] - lows[index];
        return !range || !trSum[index] ? null : (100 * Math.log10(trSum[index] / range)) / Math.log10(period);
      });
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "vortex",
    label: "Vortex 14",
    category: "趋势",
    series: [paneLine("plus", "trend", COLORS.green), paneLine("minus", "trend", COLORS.red)],
    calculate(bars) {
      const plus = Array(bars.length).fill(0);
      const minus = Array(bars.length).fill(0);
      for (let index = 1; index < bars.length; index += 1) {
        plus[index] = Math.abs(bars[index].high - bars[index - 1].low);
        minus[index] = Math.abs(bars[index].low - bars[index - 1].high);
      }
      const tr = rollingSum(trueRanges(bars), 14);
      const plusSum = rollingSum(plus, 14);
      const minusSum = rollingSum(minus, 14);
      return {
        series: {
          plus: seriesFromValues(bars, plusSum.map((value, index) => (!tr[index] ? null : value / tr[index]))),
          minus: seriesFromValues(bars, minusSum.map((value, index) => (!tr[index] ? null : value / tr[index]))),
        },
      };
    },
  });

  registerIndicator({
    key: "mass_index",
    label: "Mass Index",
    category: "波动率",
    series: [paneLine("line", "volatility", "#fbbf24")],
    calculate(bars) {
      const range = bars.map((bar) => bar.high - bar.low);
      const ema1 = emaValues(range, 9);
      const ema2 = emaValues(ema1.map((value) => value || 0), 9);
      const ratio = ema1.map((value, index) => (!ema2[index] ? null : value / ema2[index]));
      const values = rollingSum(ratio.map((value) => value || 0), 25).map((value, index) => (ratio[index] === null ? null : value));
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "ulcer",
    label: "Ulcer Index",
    category: "波动率",
    series: [paneLine("line", "volatility", "#fb7185")],
    calculate(bars) {
      const closes = fieldValues(bars, "close");
      const highs = highestValues(closes, 14);
      const values = closes.map((_close, index) => {
        if (!highs[index]) return null;
        const slice = closes.slice(index - 13, index + 1).map((close) => ((close - highs[index]) / highs[index]) * 100);
        return Math.sqrt(slice.reduce((sum, value) => sum + value * value, 0) / slice.length);
      });
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "obv",
    label: "OBV",
    category: "量能",
    series: [paneLine("line", "volume", COLORS.teal)],
    calculate(bars) {
      let current = 0;
      const values = bars.map((bar, index) => {
        if (index === 0) return current;
        if (bar.close > bars[index - 1].close) current += bar.volume || 0;
        else if (bar.close < bars[index - 1].close) current -= bar.volume || 0;
        return current;
      });
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "adline",
    label: "Accum/Dist",
    category: "量能",
    series: [paneLine("line", "volume", COLORS.amber)],
    calculate(bars) {
      let current = 0;
      const values = bars.map((bar) => {
        const range = bar.high - bar.low;
        const multiplier = range ? ((bar.close - bar.low) - (bar.high - bar.close)) / range : 0;
        current += multiplier * (bar.volume || 0);
        return current;
      });
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "cmf",
    label: "Chaikin Money Flow",
    category: "量能",
    series: [paneLine("line", "volume", COLORS.green)],
    calculate(bars) {
      const mfv = bars.map((bar) => {
        const range = bar.high - bar.low;
        const multiplier = range ? ((bar.close - bar.low) - (bar.high - bar.close)) / range : 0;
        return multiplier * (bar.volume || 0);
      });
      const mfvSum = rollingSum(mfv, 20);
      const volSum = rollingSum(bars.map((bar) => bar.volume || 0), 20);
      return { series: { line: seriesFromValues(bars, mfvSum.map((value, index) => (!volSum[index] ? null : value / volSum[index]))) } };
    },
  });

  registerIndicator({
    key: "chaikin_osc",
    label: "Chaikin Oscillator",
    category: "量能",
    series: [paneLine("line", "volume", COLORS.purple)],
    calculate(bars) {
      let current = 0;
      const adl = bars.map((bar) => {
        const range = bar.high - bar.low;
        const multiplier = range ? ((bar.close - bar.low) - (bar.high - bar.close)) / range : 0;
        current += multiplier * (bar.volume || 0);
        return current;
      });
      const fast = emaValues(adl, 3);
      const slow = emaValues(adl, 10);
      const values = adl.map((_value, index) => (fast[index] === null || slow[index] === null ? null : fast[index] - slow[index]));
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "efi",
    label: "Elder Force Index",
    category: "量能",
    series: [paneLine("line", "volume", COLORS.red)],
    calculate(bars) {
      const raw = bars.map((bar, index) => (index === 0 ? 0 : (bar.close - bars[index - 1].close) * (bar.volume || 0)));
      return { series: { line: seriesFromValues(bars, emaValues(raw, 13)) } };
    },
  });

  registerIndicator({
    key: "pvt",
    label: "PVT",
    category: "量能",
    series: [paneLine("line", "volume", COLORS.blue)],
    calculate(bars) {
      let current = 0;
      const values = bars.map((bar, index) => {
        if (index > 0 && bars[index - 1].close) {
          current += ((bar.close - bars[index - 1].close) / bars[index - 1].close) * (bar.volume || 0);
        }
        return current;
      });
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "nvi",
    label: "NVI",
    category: "量能",
    series: [paneLine("line", "volume", "#eab308")],
    calculate(bars) {
      let current = 1000;
      const values = bars.map((bar, index) => {
        if (index > 0 && (bar.volume || 0) < (bars[index - 1].volume || 0)) {
          current *= 1 + (bar.close - bars[index - 1].close) / bars[index - 1].close;
        }
        return current;
      });
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "pvi",
    label: "PVI",
    category: "量能",
    series: [paneLine("line", "volume", "#84cc16")],
    calculate(bars) {
      let current = 1000;
      const values = bars.map((bar, index) => {
        if (index > 0 && (bar.volume || 0) > (bars[index - 1].volume || 0)) {
          current *= 1 + (bar.close - bars[index - 1].close) / bars[index - 1].close;
        }
        return current;
      });
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "volume_osc",
    label: "Volume Oscillator",
    category: "量能",
    series: [paneLine("line", "volume", COLORS.cyan)],
    calculate(bars) {
      const volumes = bars.map((bar) => bar.volume || 0);
      const fast = emaValues(volumes, 5);
      const slow = emaValues(volumes, 20);
      const values = volumes.map((_value, index) => (!slow[index] ? null : ((fast[index] - slow[index]) / slow[index]) * 100));
      return { series: { line: seriesFromValues(bars, values) } };
    },
  });

  registerIndicator({
    key: "eom",
    label: "Ease of Movement",
    category: "量能",
    series: [paneLine("line", "volume", "#f472b6")],
    calculate(bars) {
      const raw = bars.map((bar, index) => {
        if (index === 0) return 0;
        const midpointMove = (bar.high + bar.low) / 2 - (bars[index - 1].high + bars[index - 1].low) / 2;
        const range = bar.high - bar.low;
        const boxRatio = range ? (bar.volume || 0) / range : 0;
        return boxRatio ? midpointMove / boxRatio : 0;
      });
      return { series: { line: seriesFromValues(bars, smaValues(raw, 14)) } };
    },
  });

  window.TWIndicatorEngine = {
    COLORS,
    registerIndicator,
    getIndicators,
    getPaneMeta,
  };
})();
