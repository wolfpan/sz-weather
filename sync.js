'use strict';
/*
 * 开放数据源自动同步
 * - 深圳日值（日均温/最高/最低/降雨）：Open-Meteo（分析场 forecast + ERA5 archive，免密钥，开源数据）
 * - 深圳当前实况：Open-Meteo current
 * - Niño3.4 月距平指数：NOAA CPC sstoi.indices（1991-2020 基准，免密钥）
 *
 * 落库规则：自动记录 id 固定为 auto-<metric>-<date>，幂等覆盖；
 * 同指标同日期若存在人工录入（无 auto 标记）则保留人工、跳过自动；
 * 月值仅在整月数据齐备后落库，未整月通过 sync.json.currentMonth 供图表画"月内至今"虚柱。
 * 状态写入 data/sync.json，页面经 /api/state 读取。
 */

const fs = require('fs');
const path = require('path');

const F_OBS = path.join(__dirname, 'data', 'observations.json');
const F_SYNC = path.join(__dirname, 'data', 'sync.json');
const F_EVENTS = path.join(__dirname, 'data', 'events.json');
const F_NORMALS = path.join(__dirname, 'data', 'normals.json');

const SZ = { lat: 22.5431, lon: 114.0579 }; // 深圳市区（Open-Meteo 邻近格点）
const SERIES_START = '2026-05-01'; // 日值序列起点（本轮厄尔尼诺 5 月进入状态）
const TIMEOUT = 20000;

const today = () => new Date().toISOString().slice(0, 10);
const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
const lastDayOfMonth = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);
const pad2 = (n) => String(n).padStart(2, '0');

/* ---------- 实况换算 ---------- */

const WMO_CODE = {
  0: '晴', 1: '晴间多云', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '毛毛雨', 55: '浓毛毛雨', 56: '冻毛毛雨', 57: '冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '霰',
  80: '阵雨', 81: '阵雨', 82: '强阵雨', 85: '阵雪', 86: '阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '雷阵雨伴冰雹',
};

function windDirCN(deg) {
  const d = Number(deg);
  if (!Number.isFinite(d)) return '—';
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
  return dirs[Math.round(d / 45) % 8] + '风';
}

function uvLevelCN(uv) {
  if (uv < 3) return '最弱';
  if (uv < 5) return '弱';
  if (uv < 7) return '中等';
  if (uv < 10) return '强';
  return '很强';
}

/* 深圳当前实况（含体感/紫外线/风向等），供顶部实况条使用 */
async function fetchCurrentWeather() {
  const cur = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${SZ.lat}&longitude=${SZ.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,uv_index,wind_speed_10m,wind_direction_10m,weather_code,is_day&hourly=uv_index&forecast_days=1&timezone=Asia%2FShanghai`);
  const c = cur.current || {};
  let uv = c.uv_index;
  if ((uv === null || uv === undefined) && cur.hourly && Array.isArray(cur.hourly.time)) {
    // current 不含 uv 时回退：取当前小时的逐时 uv_index
    const now = new Date();
    const key = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}T${pad2(now.getHours())}`;
    const i = cur.hourly.time.findIndex((t) => String(t).startsWith(key));
    if (i >= 0) uv = cur.hourly.uv_index[i];
  }
  return {
    time: c.time,
    temp: c.temperature_2m,
    feels: c.apparent_temperature,
    humidity: c.relative_humidity_2m,
    uv: uv !== null && uv !== undefined ? round(Number(uv), 1) : null,
    uvText: uv !== null && uv !== undefined ? `${uvLevelCN(Number(uv))} ${round(Number(uv), 1)}` : null,
    wind: c.wind_speed_10m,
    windDir: windDirCN(c.wind_direction_10m),
    codeText: WMO_CODE[c.weather_code] || '—',
    isDay: c.is_day === 1,
  };
}

const readStatus = () => { try { return JSON.parse(fs.readFileSync(F_SYNC, 'utf8')); } catch { return null; } };
const writeStatus = (s) => fs.writeFileSync(F_SYNC, JSON.stringify(s, null, 2) + '\n', 'utf8');

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
async function getText(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

/* ---------- Open-Meteo：深圳日值序列 ---------- */

const DAILY_KEYS = ['temperature_2m_mean', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'relative_humidity_2m_mean'];

async function fetchSzDaily() {
  const end = today();
  const base = `latitude=${SZ.lat}&longitude=${SZ.lon}&daily=${DAILY_KEYS.join(',')}&timezone=Asia%2FShanghai`;
  // forecast 提供最近 92 天（分析场、滞后最小）；archive 提供 2026-05 起全序列（ERA5，滞后约 5 天）
  const urls = [
    `https://api.open-meteo.com/v1/forecast?${base}&past_days=92&forecast_days=1`,
    `https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${SERIES_START}&end_date=${end}`,
  ];
  const responses = await Promise.all(urls.map((u) => getJSON(u).catch(() => null)));
  const map = new Map();
  for (const d of responses) {
    if (!d || !d.daily || !Array.isArray(d.daily.time)) continue;
    d.daily.time.forEach((t, i) => {
      if (t > end) return;
      const rec = { ...(map.get(t) || {}) };
      for (const k of DAILY_KEYS) {
        const v = d.daily[k] ? d.daily[k][i] : undefined;
        if (v !== null && v !== undefined) rec[k] = v; // 后处理优先 → archive 在后，ERA5 覆盖分析场
      }
      map.set(t, rec);
    });
  }
  return [...map.entries()]
    .map(([date, r]) => ({ date, ...r }))
    .filter((r) => r.temperature_2m_mean !== undefined)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/* ---------- 由日值推导观测记录 ---------- */

function deriveDaily(daily, manualMetrics) {
  const obs = [];

  const months = new Map();
  for (const r of daily) {
    const ym = r.date.slice(0, 7);
    if (!months.has(ym)) months.set(ym, []);
    months.get(ym).push(r);
  }
  const expectedDays = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).getUTCDate();

  // 月值：整月齐备才落库
  for (const [ym, rows] of months) {
    const n = expectedDays(ym);
    const means = rows.map((r) => r.temperature_2m_mean).filter((v) => v !== undefined);
    const rains = rows.map((r) => r.precipitation_sum).filter((v) => v !== undefined);
    if (means.length >= n) {
      obs.push({
        metric: 'sz_temp_month', date: lastDayOfMonth(ym),
        value: round(means.reduce((a, b) => a + b, 0) / means.length, 2),
        source: 'Open-Meteo（ERA5/分析场）', note: `自动同步：${ym} 整月日均温平均（${means.length} 天）`,
      });
    }
    if (rains.length >= n) {
      obs.push({
        metric: 'sz_rain_month', date: lastDayOfMonth(ym),
        value: round(rains.reduce((a, b) => a + b, 0), 1),
        source: 'Open-Meteo（ERA5/分析场）', note: `自动同步：${ym} 整月降雨合计（${rains.length} 天）`,
      });
    }
  }

  // 事件型日值（只落库达到跟踪意义的日期，避免刷屏）
  for (let i = 0; i < daily.length; i++) {
    const r = daily[i];
    if (r.temperature_2m_max !== undefined && r.temperature_2m_max >= 33)
      obs.push({ metric: 'sz_temp_daily_max', date: r.date, value: round(r.temperature_2m_max, 1), source: 'Open-Meteo', note: '自动同步：日最高 ≥33℃（炎热日）' });
    if (r.temperature_2m_min !== undefined && r.temperature_2m_min <= 10)
      obs.push({ metric: 'sz_temp_daily_min', date: r.date, value: round(r.temperature_2m_min, 1), source: 'Open-Meteo', note: '自动同步：日最低 ≤10℃（寒冷日）' });
    if (r.precipitation_sum !== undefined && r.precipitation_sum >= 50)
      obs.push({ metric: 'sz_rain_daily', date: r.date, value: round(r.precipitation_sum, 1), source: 'Open-Meteo', note: '自动同步：日雨量 ≥50mm' });
    const prev = i > 0 ? daily[i - 1].temperature_2m_mean : undefined;
    if (prev !== undefined && r.temperature_2m_mean !== undefined) {
      const drop = round(prev - r.temperature_2m_mean, 1);
      if (drop >= 8)
        obs.push({ metric: 'sz_temp_drop_24h', date: r.date, value: drop, source: 'Open-Meteo', note: '自动同步：日均温环比降幅（寒潮代理）' });
    }
  }

  // 累计型（取最后一次累计值）
  const last = daily[daily.length - 1];
  const asOf = last.date;
  const year = asOf.slice(0, 4);
  const hot = daily.filter((r) => r.date >= `${year}-01-01` && r.temperature_2m_max !== undefined && r.temperature_2m_max >= 33).length;
  if (hot > 0) obs.push({ metric: 'sz_hot_days_cum', date: asOf, value: hot, source: 'Open-Meteo', note: '自动同步：年内炎热日（≥33℃）累计（自序列起点）' });
  const mm = asOf.slice(5, 7);
  if (['12', '01', '02', '03'].includes(mm)) {
    const winterStart = mm === '12' ? `${year}-12-01` : `${+year - 1}-12-01`;
    const cold = daily.filter((r) => r.date >= winterStart && r.temperature_2m_min !== undefined && r.temperature_2m_min <= 10).length;
    obs.push({ metric: 'sz_cold_days_cum', date: asOf, value: cold, source: 'Open-Meteo', note: '自动同步：本冬季寒冷日（≤10℃）累计' });
  }

  // 入秋/入冬：五天滑动平均首破（若该指标已有人工/官方录入则不自动判定）
  const slidingAt = (i, n) => {
    if (i - n + 1 < 0) return null;
    const win = daily.slice(i - n + 1, i + 1).map((r) => r.temperature_2m_mean);
    if (win.some((v) => v === undefined)) return null;
    return win.reduce((a, b) => a + b, 0) / n;
  };
  const detect = (metric, fromMM, thresh, label) => {
    if (manualMetrics.has(metric)) return;
    for (let i = 0; i < daily.length; i++) {
      const r = daily[i];
      if (r.date < `${r.date.slice(0, 4)}-${fromMM}-01`) continue;
      const s = slidingAt(i, 5);
      if (s !== null && s <= thresh) {
        obs.push({ metric, date: r.date, value: r.date, source: 'Open-Meteo', note: `自动判定：${label}五天滑动平均 ≤${thresh}℃ 首日（${round(s, 1)}℃）` });
        return;
      }
    }
  };
  detect('sz_enter_autumn', '09', 22, '入秋：');
  detect('sz_enter_winter', '12', 10, '入冬：');

  // 当前月（未整月）→ 供图表画"月内至今"虚柱，不参与判定
  const curYm = asOf.slice(0, 7);
  const curRows = months.get(curYm) || [];
  let currentMonth = null;
  if (curRows.length < expectedDays(curYm)) {
    const means = curRows.map((r) => r.temperature_2m_mean).filter((v) => v !== undefined);
    const rains = curRows.map((r) => r.precipitation_sum).filter((v) => v !== undefined);
    currentMonth = {
      ym: curYm, asOf, days: curRows.length,
      temp: means.length ? round(means.reduce((a, b) => a + b, 0) / means.length, 2) : null,
      rain: rains.length ? round(rains.reduce((a, b) => a + b, 0), 1) : null,
    };
  }

  return { obs, currentMonth };
}

/* ---------- 事件检测器（数据驱动，规则见 README） ---------- */

function detectEvents(daily, derivedObs) {
  const events = [];
  if (!daily || daily.length < 3) return events;

  // 寒潮过程：24h 日均温降幅（连续日合并进 note，逐日生成便于对照 P2-2）
  for (let i = 1; i < daily.length; i++) {
    const a = daily[i - 1], b = daily[i];
    if (a.temperature_2m_mean === undefined || b.temperature_2m_mean === undefined) continue;
    const drop = round(a.temperature_2m_mean - b.temperature_2m_mean, 1);
    if (drop >= 8) {
      events.push({
        type: 'cold_wave', date: b.date,
        title: drop >= 10
          ? `强寒潮过程：单日日均温降幅 ${drop}℃`
          : `寒潮预警：单日日均温降幅 ${drop}℃`,
        note: `${a.date} → ${b.date}，日均温 ${round(a.temperature_2m_mean, 1)}℃ → ${round(b.temperature_2m_mean, 1)}℃（降幅 ≥8℃ 预警 / ≥10℃ 强寒潮）`,
      });
    }
  }

  // 高温热浪：连续 ≥3 天日最高 ≥33℃
  let heat = [];
  const flushHeat = () => {
    if (heat.length >= 3) {
      const peak = Math.max(...heat.map((r) => r.temperature_2m_max));
      events.push({
        type: 'heatwave', date: heat[0].date,
        title: `高温热浪：连续 ${heat.length} 天 ≥33℃，峰值 ${round(peak, 1)}℃`,
        note: `${heat[0].date} ~ ${heat[heat.length - 1].date}`,
      });
    }
    heat = [];
  };
  for (const r of daily) {
    if (r.temperature_2m_max !== undefined && r.temperature_2m_max >= 33) heat.push(r); else flushHeat();
  }
  flushHeat();

  // 暴雨 / 大暴雨
  for (const r of daily) {
    if (r.precipitation_sum === undefined) continue;
    if (r.precipitation_sum >= 100)
      events.push({ type: 'heavy_rain', date: r.date, title: `大暴雨：日雨量 ${round(r.precipitation_sum, 1)}mm`, note: '日雨量 ≥100mm（P3-3 判定阈值）' });
    else if (r.precipitation_sum >= 50)
      events.push({ type: 'heavy_rain', date: r.date, title: `暴雨：日雨量 ${round(r.precipitation_sum, 1)}mm`, note: '日雨量 ≥50mm' });
  }

  // 干旱少雨段：连续 ≥20 天有效降水 <1mm
  let dry = [];
  const flushDry = () => {
    if (dry.length >= 20)
      events.push({ type: 'dry_spell', date: dry[0].date, title: `干旱少雨段：连续 ${dry.length} 天有效降水 <1mm`, note: `${dry[0].date} ~ ${dry[dry.length - 1].date}` });
    dry = [];
  };
  for (const r of daily) {
    if (r.precipitation_sum !== undefined && r.precipitation_sum < 1) dry.push(r); else flushDry();
  }
  flushDry();

  // 湿冷时段：连续 ≥3 天 日均温 ≤12℃ 且日湿度 ≥80%
  let hc = [];
  const flushHc = () => {
    if (hc.length >= 3) {
      const minT = Math.min(...hc.map((r) => r.temperature_2m_mean));
      events.push({
        type: 'humid_cold', date: hc[0].date,
        title: `湿冷时段：连续 ${hc.length} 天 日均温≤12℃ 且湿度≥80%（最冷日均 ${round(minT, 1)}℃）`,
        note: `${hc[0].date} ~ ${hc[hc.length - 1].date}`,
      });
    }
    hc = [];
  };
  for (const r of daily) {
    if (r.temperature_2m_mean !== undefined && r.relative_humidity_2m_mean !== undefined
      && r.temperature_2m_mean <= 12 && r.relative_humidity_2m_mean >= 80) hc.push(r); else flushHc();
  }
  flushHc();

  // 月值显著偏离常年（月值记录落库时触发）
  let normals = {};
  try { normals = JSON.parse(fs.readFileSync(F_NORMALS, 'utf8')); } catch { /* 常年值缺失则跳过 */ }
  for (const o of derivedObs.filter((o) => o.metric === 'sz_temp_month')) {
    const n = Number(normals.month_temp && normals.month_temp[String(Number(o.date.slice(5, 7)))]);
    if (!Number.isFinite(n)) continue;
    const anom = round(o.value - n, 1);
    if (Math.abs(anom) >= 1.0)
      events.push({ type: 'month_anomaly', date: o.date, title: `${o.date.slice(0, 7)} 均温 ${fmtVal(o.value)}℃：较常年${anom > 0 ? '偏高' : '偏低'} ${Math.abs(anom)}℃`, note: '月均温偏离 ≥1.0℃ 触发' });
  }
  for (const o of derivedObs.filter((o) => o.metric === 'sz_rain_month')) {
    const n = Number(normals.month_rain && normals.month_rain[String(Number(o.date.slice(5, 7)))]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const ratio = (o.value - n) / n;
    if (ratio <= -0.5 && n - o.value >= 20)
      events.push({ type: 'month_anomaly', date: o.date, title: `${o.date.slice(0, 7)} 雨量 ${fmtVal(o.value)}mm：较常年偏少 ${Math.round(-ratio * 100)}%`, note: '月雨量偏离 ≥50% 且 ≥20mm 触发' });
    else if (ratio >= 0.5)
      events.push({ type: 'month_anomaly', date: o.date, title: `${o.date.slice(0, 7)} 雨量 ${fmtVal(o.value)}mm：较常年偏多 ${Math.round(ratio * 100)}%`, note: '月雨量偏离 ≥50% 触发' });
  }

  // 季节转换（入秋/入冬自动判定成功时）
  for (const o of derivedObs.filter((o) => o.metric === 'sz_enter_autumn' || o.metric === 'sz_enter_winter')) {
    const label = o.metric === 'sz_enter_autumn' ? '入秋' : '入冬';
    events.push({ type: 'season_shift', date: o.date, title: `${label}：${o.date}`, note: o.note });
  }

  return events.map((e) => ({
    ...e,
    id: `auto-evt-${e.type}-${e.date}`,
    level: '研判',
    source: '跟踪看板 · 数据检测',
    auto: true,
  }));
}

function upsertEvents(store, records) {
  let added = 0, updated = 0;
  for (const rec of records) {
    const i = store.events.findIndex((e) => e.id === rec.id);
    const full = { ...rec, fetchedAt: new Date().toISOString() };
    if (i >= 0) { store.events[i] = full; updated++; } else { store.events.push(full); added++; }
  }
  return { added, updated };
}

const fmtVal = (x) => { const n = Number(x); return Number.isInteger(n) ? String(n) : String(round(n, 2)); };

/* ---------- NOAA CPC：Niño3.4 月距平 ---------- */

async function fetchNino() {
  const text = await getText('https://www.cpc.ncep.noaa.gov/data/indices/sstoi.indices');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (!f[0] || isNaN(+f[0])) continue; // 表头行
    const yr = +f[0], mon = +f[1];
    if (yr < 2025 || !mon) continue;
    const v = parseFloat(f[9]); // 表头：YR MON NINO1+2 ANOM NINO3 ANOM NINO4 ANOM NINO3.4 ANOM
    if (!isFinite(v)) continue;
    const ym = `${yr}-${String(mon).padStart(2, '0')}`;
    out.push({
      metric: 'nino34_ssta', date: lastDayOfMonth(ym), value: v,
      source: 'NOAA CPC', note: '自动同步：Niño3.4 月距平指数（1991-2020 基准）',
    });
  }
  return out;
}

/* ---------- 落库与编排 ---------- */

function upsert(store, records) {
  let added = 0, updated = 0, skipped = 0;
  for (const rec of records) {
    const id = `auto-${rec.metric}-${rec.date}`;
    const manualDup = store.observations.some((o) => o.metric === rec.metric && o.date === rec.date && !o.auto);
    if (manualDup) { skipped++; continue; }
    const full = { id, ...rec, auto: true, fetchedAt: new Date().toISOString() };
    const i = store.observations.findIndex((o) => o.id === id);
    if (i >= 0) { store.observations[i] = full; updated++; } else { store.observations.push(full); added++; }
  }
  return { added, updated, skipped };
}

let running = false;

async function syncAll(manual = false) {
  if (running) return { ...(readStatus() || {}), alreadyRunning: true };
  running = true;
  const status = { running: true, startedAt: new Date().toISOString(), trigger: manual ? '手动' : '定时', results: [] };
  writeStatus(status);
  try {
    const store = JSON.parse(fs.readFileSync(F_OBS, 'utf8'));
    const manualMetrics = new Set(store.observations.filter((o) => !o.auto).map((o) => o.metric));
    let currentMonth = null, currentWeather = null;

    try {
      const daily = await fetchSzDaily();
      const derived = deriveDaily(daily, manualMetrics);
      const c = upsert(store, derived.obs);
      currentMonth = derived.currentMonth;
      status.results.push({ name: 'Open-Meteo 深圳日值', ok: true, detail: `${daily.length} 天日值 · 落库新增 ${c.added} / 更新 ${c.updated} / 保留人工 ${c.skipped}` });

      // 数据驱动事件检测（时间线）
      try {
        const evStore = JSON.parse(fs.readFileSync(F_EVENTS, 'utf8'));
        const evts = detectEvents(daily, derived.obs);
        const c3 = upsertEvents(evStore, evts);
        fs.writeFileSync(F_EVENTS, JSON.stringify(evStore, null, 2) + '\n', 'utf8');
        status.results.push({ name: '事件检测', ok: true, detail: `自动事件新增 ${c3.added} / 更新 ${c3.updated}（时间线现共 ${evStore.events.length} 条）` });
      } catch (e) {
        status.results.push({ name: '事件检测', ok: false, error: e.message });
      }

      try {
        currentWeather = await fetchCurrentWeather();
        status.results.push({ name: 'Open-Meteo 深圳实况', ok: true, detail: `${currentWeather.temp}℃（体感 ${currentWeather.feels}℃）@ ${currentWeather.time}` });
      } catch (e) {
        status.results.push({ name: 'Open-Meteo 深圳实况', ok: false, error: e.message });
      }
    } catch (e) {
      status.results.push({ name: 'Open-Meteo 深圳日值', ok: false, error: e.message });
    }

    try {
      const nino = await fetchNino();
      const c2 = upsert(store, nino);
      status.results.push({ name: 'NOAA CPC Niño3.4 月指数', ok: true, detail: `${nino.length} 条月值 · 落库新增 ${c2.added} / 更新 ${c2.updated} / 保留人工 ${c2.skipped}` });
    } catch (e) {
      status.results.push({ name: 'NOAA CPC Niño3.4 月指数', ok: false, error: e.message });
    }

    fs.writeFileSync(F_OBS, JSON.stringify(store, null, 2) + '\n', 'utf8');
    status.currentMonth = currentMonth;
    status.currentWeather = currentWeather;
  } catch (e) {
    status.fatal = e.message;
  }
  status.running = false;
  status.finishedAt = new Date().toISOString();
  writeStatus(status);
  running = false;
  return status;
}

/* 实况轻刷新：只更新 currentWeather（5 分钟一轮），不触碰其余数据 */
async function refreshCurrentWeather() {
  if (running) return;
  try {
    const cw = await fetchCurrentWeather();
    const s = readStatus() || {};
    s.currentWeather = cw;
    writeStatus(s);
  } catch { /* 静默，下轮再试 */ }
}

module.exports = { syncAll, readStatus, refreshCurrentWeather };
