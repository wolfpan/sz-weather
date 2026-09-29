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

const SZ = { lat: 22.5431, lon: 114.0579 }; // 深圳市区（Open-Meteo 邻近格点）
const SERIES_START = '2026-05-01'; // 日值序列起点（本轮厄尔尼诺 5 月进入状态）
const TIMEOUT = 20000;

const today = () => new Date().toISOString().slice(0, 10);
const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
const lastDayOfMonth = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 0)).toISOString().slice(0, 10);

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

const DAILY_KEYS = ['temperature_2m_mean', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum'];

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
      try {
        const cw = await getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${SZ.lat}&longitude=${SZ.lon}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code&timezone=Asia%2FShanghai`);
        currentWeather = { time: cw.current.time, temp: cw.current.temperature_2m, humidity: cw.current.relative_humidity_2m, wind: cw.current.wind_speed_10m };
        status.results.push({ name: 'Open-Meteo 深圳实况', ok: true, detail: `${cw.current.temperature_2m}℃ @ ${cw.current.time}` });
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

module.exports = { syncAll, readStatus };
