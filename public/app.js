'use strict';
/* 深圳气温 × 超强厄尔尼诺 · 预测跟踪看板 前端逻辑（零依赖，原生 JS + SVG） */

let STATE = null;

/* ---------- 基础工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ISO(UTC) → 本地 "YYYY-MM-DD HH:mm" */
function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtNum(v) {
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return String(v).length <= 6 ? String(v) : v.toFixed(2);
  }
  return String(v);
}

const STATUS_META = {
  pending: { cls: 'st-pending' },
  active: { cls: 'st-active' },
  active_ok: { cls: 'st-ok' },
  partial: { cls: 'st-partial' },
  verified: { cls: 'st-verified' },
  missed: { cls: 'st-missed' },
  review: { cls: 'st-review' },
};

const API = {
  async state() {
    const r = await fetch('/api/state');
    if (!r.ok) throw new Error('加载状态失败');
    return r.json();
  },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '请求失败');
    return data;
  },
  async del(url) {
    const r = await fetch(url, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '删除失败');
    return data;
  },
};

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (bad ? ' bad' : '');
  clearTimeout(t._h);
  t._h = setTimeout(() => { t.className = 'toast'; }, 2600);
}

function monthsBetween(a, b) {
  const out = [];
  let [y, m] = a.split('-').map(Number);
  const [ey, em] = b.split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m > 12) { m = 1; y += 1; }
  }
  return out;
}

function latestValue(metric) {
  const rows = STATE.observations
    .filter((o) => o.metric === metric)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  return rows[rows.length - 1] || null;
}

/* ---------- KPI ---------- */

/* 时节变化卡：入秋进度 + 气温同比 + 报告分期前瞻，全部由实时数据计算 */
function seasonCard() {
  const now = new Date();
  const pd = (n) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pd(now.getMonth() + 1)}-${pd(now.getDate())}`;
  const normalMd = STATE.normals.enter_autumn_normal || '11-08';

  // 入秋状态：以录入（自动判定/人工）的入秋日期与常年基准比较
  const autumnObs = latestValue('sz_enter_autumn');
  let big, cap1;
  if (autumnObs) {
    const d = String(autumnObs.value);
    const diff = Math.round((new Date(d) - new Date(`${d.slice(0, 4)}-${normalMd}`)) / 86400000);
    big = diff > 0 ? `入秋推迟 ${diff} 天` : diff < 0 ? `入秋早到 ${-diff} 天` : '入秋准时';
    cap1 = `入秋日 ${d}（常年 ${normalMd}）`;
  } else {
    const normalFull = `${now.getFullYear()}-${normalMd}`;
    const late = Math.round((new Date(todayStr) - new Date(normalFull)) / 86400000);
    if (late > 0) {
      big = `入秋推迟中 ${late} 天`;
      cap1 = `常年 ${normalMd} 入秋，今尚未入秋`;
    } else {
      big = '未入秋';
      cap1 = `距常年入秋（${normalMd}）约 ${-late} 天`;
    }
  }

  // 气温同比：优先本月至今（自动同步），无则取最近一个整月，与常年比较
  const cm = STATE.sync && STATE.sync.currentMonth;
  const normalOf = (ym) => Number(STATE.normals.month_temp[String(Number(ym.slice(5, 7)))]);
  let tempLine = '气温同比：暂无数据';
  const anomalyLine = (label, v, ym) => {
    const n = normalOf(ym);
    if (!Number.isFinite(n)) return null;
    const anom = Math.round((v - n) * 10) / 10;
    return `气温同比：${label} ${fmtNum(v)}℃，较常年${anom >= 0 ? '偏高' : '偏低'} ${fmtNum(Math.abs(anom))}℃`;
  };
  if (cm && cm.temp !== null && cm.temp !== undefined) {
    tempLine = anomalyLine(`${cm.ym.slice(5)}月至今`, cm.temp, cm.ym) || tempLine;
  } else {
    const o = latestValue('sz_temp_month');
    if (o) tempLine = anomalyLine(o.date.slice(0, 7), Number(o.value), o.date) || tempLine;
  }

  // 前瞻：报告分期研判（时节 → 气温方向）
  const ym = todayStr.slice(0, 7);
  const PHASE_HINTS = [
    { from: '2026-09', to: '2026-11', text: '发展年秋季：气温大概率升高，偏暖延长、少雨干燥' },
    { from: '2026-12', to: '2027-02', text: '峰值期冬季：气温可能升高（暖冬基准），警惕冷暖过山车' },
    { from: '2027-03', to: '2027-05', text: '衰减年春季：回南天或加剧，防旱涝急转' },
    { from: '2027-06', to: '2027-09', text: '衰减年夏季：气温同比升高（热浪较 2026 更显著），龙舟水偏强' },
  ];
  const phase = PHASE_HINTS.find((h) => ym >= h.from && ym <= h.to);

  return kpiCard(
    '时节变化',
    big,
    `${cap1}<br>${tempLine}${phase ? `<br>前瞻：${esc(phase.text)}` : ''}`,
    'accent'
  );
}

function kpiCard(label, big, caption, tone) {
  return `<div class="kpi ${tone || ''}"><div class="kpi-label">${esc(label)}</div><div class="kpi-big">${big}</div><div class="kpi-cap">${caption}</div></div>`;
}

function renderKpis() {
  const nino = latestValue('nino34_ssta');
  const diff = nino ? Math.round((Number(nino.value) - 2.9) * 100) / 100 : null;
  const next = STATE.summary.nextChecks[0];
  const cards = [
    kpiCard(
      'Niño3.4 最新指数',
      nino ? `${fmtNum(Number(nino.value))}℃` : '—',
      nino ? `${esc(nino.date)} · ${esc(nino.note || '')}` : '暂无观测',
      'accent'
    ),
    kpiCard(
      '较 2015/16 峰值 2.9℃',
      diff === null ? '—' : (diff >= 0 ? `+${fmtNum(diff)}℃` : `−${fmtNum(-diff)}℃`),
      diff === null ? '' : (diff >= 0
        ? '候/旬口径已超越（正式定强以 3 个月滑动平均为准）'
        : '候/旬口径尚未超越，峰值预计 11 月前后'),
      diff !== null && diff >= 0 ? 'good' : 'warn'
    ),
    kpiCard('峰值预测（11 月前后）', '3.2~3.5℃', '央视新闻 2026-09-29 · 将成有监测记录以来最强'),
    kpiCard(
      '超强阈值 2.5℃',
      nino && Number(nino.value) >= 2.5 ? '已越过' : '未越过',
      '中国口径：峰值 ≥2.5℃ 为超强厄尔尼诺',
      nino && Number(nino.value) >= 2.5 ? 'good' : 'muted'
    ),
    seasonCard(),
    kpiCard(
      '下一个验证节点',
      next ? esc(next.end) : '—',
      next ? `${esc(next.id)} ${esc(next.title)}` : ''
    ),
  ];
  $('#kpis').innerHTML = cards.join('');
  $('#updated-at').textContent = `更新于 ${fmtTime(STATE.now)}`;
}

/* ---------- 同步状态 ---------- */
/* ---------- 同步状态与顶部实况条 ---------- */

function renderLiveStrip() {
  const el = $('#live-strip');
  const s = STATE.sync;
  const cw = s && s.currentWeather;
  if (!cw || cw.temp === null || cw.temp === undefined) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = '';
  const item = (label, val) => `<div class="ls-item"><span class="ls-label">${label}</span><span class="ls-val">${val}</span></div>`;
  el.innerHTML = `
    <span class="ls-title">深圳实况</span>
    ${item('天气', esc(cw.codeText || '—'))}
    ${item('气温', `${fmtNum(cw.temp)}℃`)}
    ${item('体感', cw.feels !== null && cw.feels !== undefined ? `${fmtNum(cw.feels)}℃` : '—')}
    ${item('湿度', cw.humidity !== null && cw.humidity !== undefined ? `${fmtNum(cw.humidity)}%` : '—')}
    ${item('紫外线', cw.uvText ? esc(cw.uvText) : '—')}
    ${item('风', `${esc(cw.windDir || '—')} ${cw.wind !== null && cw.wind !== undefined ? fmtNum(cw.wind) + 'km/h' : ''}`)}
    <span class="ls-time">${esc(cw.time.slice(5, 16).replace('T', ' '))} · Open-Meteo</span>`;
}

function renderSync() {
  const s = STATE.sync;
  const st = $('#sync-status');
  if (!s) { st.textContent = '同步未初始化'; return; }
  if (s.running) { st.textContent = '同步中…'; st.className = 'muted'; return; }
  const results = s.results || [];
  const bad = results.filter((r) => !r.ok).length;
  const t = s.finishedAt ? fmtTime(s.finishedAt).slice(5) : '';
  st.textContent = `已同步 ${t} · 源 ${results.length - bad}✓${bad ? ` ${bad}✗` : ''}`;
  st.className = bad ? 'sync-err' : 'muted';
  st.title = results.map((r) => `${r.name}：${r.ok ? r.detail : `失败 ${r.error}`}`).join('\n') || '尚未运行';
}

/* ---------- Niño3.4 折线图 ---------- */
function renderNinoChart() {
  const W = 900, H = 340, padL = 46, padR = 175, padT = 18, padB = 34;
  const t0 = +new Date('2026-05-01T00:00:00Z'), t1 = +new Date('2027-03-31T00:00:00Z');
  const X = (d) => padL + ((+new Date(d + 'T00:00:00Z') - t0) / (t1 - t0)) * (W - padL - padR);
  const yMax = 4;
  const Y = (v) => padT + (1 - v / yMax) * (H - padT - padB);

  const pts = STATE.observations
    .filter((o) => o.metric === 'nino34_ssta')
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  const s = [];
  s.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Niño3.4 海温指数追踪图">`);

  // 横向网格与 y 轴刻度
  for (let g = 0; g <= 4; g++) {
    const v = g, yy = Y(v);
    s.push(`<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#1d2942" stroke-width="1"/>`);
    s.push(`<text x="${padL - 7}" y="${yy + 3.5}" text-anchor="end" font-size="10" fill="#66799b">${v}</text>`);
  }
  // x 轴刻度
  [['2026-05-01', '26-05'], ['2026-07-01', '26-07'], ['2026-09-01', '26-09'], ['2026-11-01', '26-11'], ['2027-01-01', '27-01'], ['2027-03-01', '27-03']]
    .forEach(([d, lb]) => {
      s.push(`<line x1="${X(d)}" y1="${H - padB}" x2="${X(d)}" y2="${H - padB + 4}" stroke="#3a4a6e"/>`);
      s.push(`<text x="${X(d)}" y="${H - padB + 16}" text-anchor="middle" font-size="10" fill="#66799b">${lb}</text>`);
    });

  // 阈值线：0.5 厄尔尼诺标准 / 2.5 超强标准 / 2.9 2015/16 峰值
  const thresholds = [
    { v: 0.5, color: '#5a6d92', dash: '4 4', label: '厄尔尼诺标准 0.5℃' },
    { v: 2.5, color: '#ff6b6b', dash: '5 4', label: '超强标准 2.5℃' },
    { v: 2.9, color: '#ffb454', dash: '2 4', label: '2015/16 峰值 2.9℃' },
  ];
  for (const t of thresholds) {
    s.push(`<line x1="${padL}" y1="${Y(t.v)}" x2="${W - padR}" y2="${Y(t.v)}" stroke="${t.color}" stroke-width="1" stroke-dasharray="${t.dash}" opacity="0.85"/>`);
    s.push(`<text x="${padL + 6}" y="${Y(t.v) - 5}" font-size="10" fill="${t.color}">${t.label}</text>`);
  }

  // 预测峰值区间带（2026-11）
  const bx = X('2026-11-01'), bw = X('2026-11-30') - X('2026-11-01');
  s.push(`<rect x="${bx}" y="${Y(3.5)}" width="${bw}" height="${Y(3.2) - Y(3.5)}" fill="rgba(77,163,255,0.18)" stroke="#4da3ff" stroke-width="1" stroke-dasharray="3 3"/>`);
  s.push(`<text x="${bx + bw / 2}" y="${Y(3.5) - 6}" text-anchor="middle" font-size="10.5" fill="#7cc0ff">预测峰值 3.2~3.5℃</text>`);

  // 实况折线
  if (pts.length) {
    const path = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.date).toFixed(1)},${Y(Number(p.value)).toFixed(1)}`).join('');
    s.push(`<path d="${path}" fill="none" stroke="#4da3ff" stroke-width="2"/>`);
    // 虚线连接实况末点 → 预测区间中心
    const last = pts[pts.length - 1];
    if (last.date < '2026-11-01') {
      s.push(`<line x1="${X(last.date)}" y1="${Y(Number(last.value))}" x2="${X('2026-11-15')}" y2="${Y(3.35)}" stroke="#4da3ff" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.7"/>`);
    }
    for (const p of pts) {
      s.push(`<circle cx="${X(p.date).toFixed(1)}" cy="${Y(Number(p.value)).toFixed(1)}" r="4" fill="#0b1220" stroke="#4da3ff" stroke-width="2"><title>${esc(p.date)}：${fmtNum(Number(p.value))}℃（${esc(p.note || '')}）</title></circle>`);
    }
    // 数值标签：带描边光晕，按横向间距稀疏标注，避免陡升段互相压叠
    let lastLabelX = -1e9;
    pts.forEach((p, i) => {
      const px = X(p.date);
      const isLast = i === pts.length - 1;
      if (isLast || px - lastLabelX > 36) {
        lastLabelX = px;
        s.push(`<text x="${(px - 6).toFixed(1)}" y="${(Y(Number(p.value)) - 7).toFixed(1)}" text-anchor="end" font-size="9.5" fill="#9fc5f5" stroke="#0b1220" stroke-width="3" paint-order="stroke">${fmtNum(Number(p.value))}</text>`);
      }
    });
  }

  // 历史三次超强事件的 9 月均值（对照散点）
  for (const [v, lb] of [[1.24, '82/83'], [1.84, '97/98'], [1.79, '15/16']]) {
    const cx = X('2026-09-20'), cy = Y(v);
    s.push(`<rect x="${cx - 4}" y="${cy - 4}" width="8" height="8" fill="none" stroke="#8aa0c2" stroke-width="1.2" transform="rotate(45 ${cx} ${cy})"><title>历史超强事件同期（9月）均值：${v}℃（${lb}）</title></rect>`);
  }

  // 右侧注释区
  const ax = W - padR + 16;
  const notes = [
    ['预测（央视 2026-09-29）', '#7cc0ff', 11.5, true],
    ['峰值 3.2~3.5℃ · 11 月前后', '#7cc0ff', 11, false],
    ['', '#8aa0c2', 10, false],
    ['历史三次超强（Niño3.4 峰值）', '#8aa0c2', 10.5, true],
    ['1982/83　2.8℃', '#8aa0c2', 10.5, false],
    ['1997/98　2.6℃', '#8aa0c2', 10.5, false],
    ['2015/16　2.9℃（原纪录）', '#8aa0c2', 10.5, false],
    ['', '#8aa0c2', 10, false],
    ['历史超强事件 9 月均值', '#8aa0c2', 10.5, true],
    ['1.24 / 1.84 / 1.79℃', '#8aa0c2', 10.5, false],
    ['（图中 9 月处菱形对照）', '#5a6d92', 9.5, false],
  ];
  notes.forEach(([txt, color, size, bold], i) => {
    if (txt) s.push(`<text x="${ax}" y="${padT + 16 + i * 17}" font-size="${size}" fill="${color}" ${bold ? 'font-weight="600"' : ''}>${txt}</text>`);
  });

  if (!pts.length) s.push(`<text x="${(padL + W - padR) / 2}" y="${H / 2}" text-anchor="middle" fill="#5a6d92" font-size="12">暂无 Niño3.4 观测数据</text>`);
  s.push('</svg>');
  s.push(`<div class="legend">
    <span><span class="dot" style="background:#4da3ff"></span>实况（候/旬/月尺度录入）</span>
    <span><span class="dot" style="background:rgba(77,163,255,0.4)"></span>预测峰值区间</span>
    <span><span class="dot" style="background:none;border:1.2px solid #8aa0c2;border-radius:0"></span>历史超强事件 9 月均值</span>
  </div>`);
  $('#chart-nino').innerHTML = s.join('');
}

/* ---------- 月度柱状图（气温 / 降雨 vs 常年） ---------- */
function obsByMonth(metric) {
  const map = {};
  for (const o of STATE.observations) {
    if (o.metric !== metric || o.background) continue;
    const ym = o.date.slice(0, 7);
    if (!map[ym] || o.date >= map[ym].date) map[ym] = o;
  }
  return map;
}

function renderMonthBars(containerSel, opts) {
  const months = monthsBetween('2026-05', '2027-02');
  const W = 470, H = 270, padL = 38, padR = 10, padT = 18, padB = 34;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const Y = (v) => padT + (1 - Math.min(v, opts.yMax) / opts.yMax) * plotH;
  const slot = plotW / months.length;
  const data = obsByMonth(opts.metric);
  const normalsMap = STATE.normals[opts.normalsKey] || {};

  const s = [];
  s.push(`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.title)}">`);
  for (let g = 0; g <= 4; g++) {
    const v = (opts.yMax * g) / 4, yy = Y(v);
    s.push(`<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="#1d2942"/>`);
    s.push(`<text x="${padL - 6}" y="${yy + 3.5}" text-anchor="end" font-size="9.5" fill="#66799b">${fmtNum(Math.round(v))}</text>`);
  }

  months.forEach((ym, i) => {
    const cx = padL + slot * (i + 0.5);
    const mm = Number(ym.slice(5, 7));
    const n = Number(normalsMap[String(mm)]);
    const bw = slot * 0.34;
    const markerHere = opts.marker && opts.marker.ym === ym;
    if (Number.isFinite(n)) {
      s.push(`<rect x="${(cx - bw - 1).toFixed(1)}" y="${Y(n).toFixed(1)}" width="${bw.toFixed(1)}" height="${(plotH + padT - Y(n)).toFixed(1)}" fill="#2c3b5c"><title>${ym} 常年值（近似）：${fmtNum(n)}${esc(opts.unit)}</title></rect>`);
      // 有纪录标记线的月份，标签上移会与虚线相撞：该月省略常年数值标签（tooltip 仍有）
      if (!markerHere) s.push(`<text x="${(cx - bw / 2 - 1).toFixed(1)}" y="${(Y(n) - 3).toFixed(1)}" text-anchor="middle" font-size="8" fill="#66799b">${fmtNum(n)}</text>`);
    }
    const o = data[ym];
    if (o && Number.isFinite(n)) {
      const color = opts.colorFor(Number(o.value), n);
      s.push(`<rect x="${(cx + 1).toFixed(1)}" y="${Y(Number(o.value)).toFixed(1)}" width="${bw.toFixed(1)}" height="${(plotH + padT - Y(Number(o.value))).toFixed(1)}" fill="${color}"><title>${o.date} 实况：${fmtNum(Number(o.value))}${esc(opts.unit)}（常年 ${fmtNum(n)}，距平 ${fmtNum(Math.round((Number(o.value) - n) * 10) / 10)}）</title></rect>`);
      s.push(`<text x="${(cx + 1 + bw / 2).toFixed(1)}" y="${(Y(Number(o.value)) - 3).toFixed(1)}" text-anchor="middle" font-size="8" fill="#dbe7ff">${fmtNum(Number(o.value))}</text>`);
    } else {
      s.push(`<text x="${(cx + 1 + bw / 2).toFixed(1)}" y="${(Y(0) - 3).toFixed(1)}" text-anchor="middle" font-size="9" fill="#44557a">待录</text>`);
    }
    s.push(`<text x="${cx.toFixed(1)}" y="${H - padB + 15}" text-anchor="middle" font-size="9.5" fill="#8aa0c2">${mm}月</text>`);
    if (mm === 5 || mm === 1) {
      s.push(`<text x="${cx.toFixed(1)}" y="${H - padB + 27}" text-anchor="middle" font-size="8.5" fill="#5a6d92">${ym.slice(0, 4)}</text>`);
    }
  });

  // 当前月"月内至今"虚柱（来自自动同步，未定月，不参与判定）
  if (opts.partial && opts.partial.value !== null && opts.partial.value !== undefined) {
    const pi = months.indexOf(opts.partial.ym);
    if (pi >= 0 && !data[opts.partial.ym]) {
      const cx = padL + slot * (pi + 0.5);
      const bw = slot * 0.34;
      const v = Number(opts.partial.value);
      const n = Number(normalsMap[String(Number(opts.partial.ym.slice(5, 7)))]);
      const color = Number.isFinite(n) ? opts.colorFor(v, n) : '#7cc0ff';
      s.push(`<rect x="${(cx + 1).toFixed(1)}" y="${Y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(plotH + padT - Y(v)).toFixed(1)}" fill="${color}" opacity="0.45"><title>${opts.partial.ym} 月内至 ${esc(opts.partial.asOf)}（${opts.partial.days} 天）：${fmtNum(v)}${esc(opts.unit)} · 未定月，自动同步</title></rect>`);
      s.push(`<text x="${(cx + 1 + bw / 2).toFixed(1)}" y="${(Y(v) - 3).toFixed(1)}" text-anchor="middle" font-size="8" fill="#8fa5c8">${fmtNum(v)}</text>`);
    }
  }

  // 2025 年同期纪录标记（仅气温图）
  if (opts.marker) {
    const ym = opts.marker.ym;
    const i = months.indexOf(ym);
    if (i >= 0) {
      const cx = padL + slot * (i + 0.5);
      const yy = Y(opts.marker.value);
      s.push(`<line x1="${cx - slot * 0.4}" y1="${yy}" x2="${cx + slot * 0.4}" y2="${yy}" stroke="#ffb454" stroke-width="1" stroke-dasharray="3 3"/>`);
      s.push(`<text x="${(cx + slot * 0.42).toFixed(1)}" y="${(yy - 3).toFixed(1)}" text-anchor="start" font-size="8.5" fill="#ffb454">${esc(opts.marker.label)}</text>`);
    }
  }

  s.push('</svg>');
  s.push(`<div class="legend">
    <span><span class="dot" style="background:#2c3b5c"></span>常年值（近似）</span>
    ${opts.legendExtra || ''}
  </div>`);
  $(containerSel).innerHTML = s.join('');
}

function chartPartial(metric) {
  const cm = STATE.sync && STATE.sync.currentMonth;
  if (!cm) return null;
  const value = metric === 'sz_temp_month' ? cm.temp : cm.rain;
  if (value === null || value === undefined) return null;
  return { ym: cm.ym, value, asOf: cm.asOf, days: cm.days };
}

function renderTempChart() {
  renderMonthBars('#chart-temp', {
    metric: 'sz_temp_month',
    normalsKey: 'month_temp',
    unit: '℃',
    yMax: 32,
    title: '深圳月平均气温 vs 常年',
    colorFor: (v, n) => (v > n + 0.3 ? '#ff6b6b' : v < n - 0.3 ? '#4da3ff' : '#3ddc97'),
    marker: { ym: '2026-10', value: 26.4, label: '2025 同期 26.4（纪录）' },
    partial: chartPartial('sz_temp_month'),
    legendExtra: '<span><span class="dot" style="background:#ff6b6b"></span>实况高于常年</span><span><span class="dot" style="background:#3ddc97"></span>实况接近常年</span><span><span class="dot" style="background:#4da3ff"></span>实况低于常年</span><span><span class="dot" style="background:#8fa5c8;opacity:0.45"></span>本月至今（虚，按偏常着色）</span>',
  });
}

function renderRainChart() {
  renderMonthBars('#chart-rain', {
    metric: 'sz_rain_month',
    normalsKey: 'month_rain',
    unit: 'mm',
    yMax: 360,
    title: '深圳月降雨量 vs 常年',
    colorFor: (v, n) => (v >= n ? '#4da3ff' : '#ffb454'),
    partial: chartPartial('sz_rain_month'),
    legendExtra: '<span><span class="dot" style="background:#4da3ff"></span>实况偏多</span><span><span class="dot" style="background:#ffb454"></span>实况偏少</span><span><span class="dot" style="background:#8fa5c8;opacity:0.45"></span>本月至今（虚，按偏常着色）</span>',
  });
}

/* ---------- 预测跟踪板 ---------- */
function renderBoard() {
  const phases = [];
  for (const p of STATE.predictions) if (!phases.includes(p.phase)) phases.push(p.phase);

  const html = phases.map((phase) => {
    const items = STATE.predictions.filter((p) => p.phase === phase);
    const stat = {};
    items.forEach((p) => { stat[p._eval.status] = (stat[p._eval.status] || 0) + 1; });
    const statText = Object.entries(stat).map(([k, n]) => `${n} ${STATUS_META[k] ? esc(p_label(k)) : k}`).join(' · ');
    const cards = items.map(renderPredCard).join('');
    return `<div class="phase-block">
      <div class="phase-head"><h3>${esc(phase)}</h3><span class="hint">${items.length} 项 · ${statText}</span></div>
      ${cards}
    </div>`;
  }).join('');
  $('#board').innerHTML = html;
}

function p_label(status) {
  const map = { pending: '待验证', active: '进行中', active_ok: '暂符合', partial: '部分兑现', verified: '已兑现', missed: '未兑现', review: '复核' };
  return map[status] || status;
}

function renderPredCard(p) {
  const ev = p._eval;
  const meta = STATUS_META[ev.status] || STATUS_META.pending;
  const m = STATE.metrics[p.verify.metric] || {};
  const override = p.statusOverride;
  const autoLine = override ? `<div class="eval-sub">自动判定原为：${esc(ev.autoStatusLabel || '')}${ev.windowClosed ? '（窗口已结束）' : ''}</div>` : '';
  return `<article class="pred" id="pred-${esc(p.id)}">
    <div class="pred-top">
      <span class="badge ${meta.cls}">${esc(ev.statusLabel)}</span>
      <h4>${esc(p.id)} · ${esc(p.title)}</h4>
      <span class="period">${esc(p.period)}</span>
    </div>
    <details class="claim">
      <summary>研判原文与来源</summary>
      <p>${esc(p.claim)}${p.note ? `<br><br>判定口径：${esc(p.note)}` : ''}</p>
      <p class="src">来源：${esc(p.source)}</p>
    </details>
    <div class="pred-eval">
      <div class="eval-main">${esc(ev.detail)}</div>
      ${p.verify.baseline_label ? `<div class="eval-sub">基准：${esc(p.verify.baseline_label)}</div>` : ''}
      ${autoLine}
      <div class="eval-sub">验证窗口 ${esc(p.window.start)} ~ ${esc(p.window.end)} · 指标：${esc(m.label || p.verify.metric)} · 窗口${ev.windowClosed ? '已结束' : ev.windowOpen ? '进行中' : '未开始'}${ev.obsCount ? ` · 窗口内观测 ${ev.obsCount} 条` : ''}</div>
    </div>
    ${p.aiJudge ? renderAiJudge(p.aiJudge) : ''}
    <div class="pred-actions">
      <label>人工复核
        <select class="override" data-id="${esc(p.id)}">
          <option value="">自动判定</option>
          <option value="verified" ${override && override.status === 'verified' ? 'selected' : ''}>已兑现</option>
          <option value="partial" ${override && override.status === 'partial' ? 'selected' : ''}>部分兑现</option>
          <option value="missed" ${override && override.status === 'missed' ? 'selected' : ''}>未兑现</option>
          <option value="pending" ${override && override.status === 'pending' ? 'selected' : ''}>待验证</option>
        </select>
      </label>
    </div>
  </article>`;
}

const AI_VERDICT_LABEL = {
  verified: '已兑现', partial: '部分兑现', missed: '未兑现',
  active_ok: '走向兑现', active: '暂不支持/数据不足', pending: '待验证',
};

function renderAiJudge(j) {
  const label = AI_VERDICT_LABEL[j.verdict] || j.verdict;
  const conf = Number.isFinite(Number(j.confidence)) && j.verdict ? ` · ${Math.round(Number(j.confidence) * 100)}%` : '';
  return `<div class="ai-judge">
    <span class="badge ai-judge-badge">AI ${esc(label)}${conf}</span>
    <span class="ai-judge-reason">${esc(j.reason)}</span>
    <span class="ai-judge-at">${fmtTime(j.at)} · ${esc(j.model || '')}</span>
  </div>`;
}

/* ---------- AI 研判面板 ---------- */

function md2html(md) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let inUl = false, inTable = false, thPending = false;
  const closeUl = () => { if (inUl) { out.push('</ul>'); inUl = false; } };
  const closeTable = () => { if (inTable) { out.push('</tbody></table>'); inTable = false; } };
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`([^`]+?)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const t = raw.trim();
    if (/^#{1,3}\s/.test(t)) {
      closeUl(); closeTable();
      out.push(`<h4>${inline(t.replace(/^#{1,3}\s/, ''))}</h4>`);
    } else if (/^####\s/.test(t)) {
      closeUl(); closeTable();
      out.push(`<h5>${inline(t.slice(5))}</h5>`);
    } else if (/^[-*]\s/.test(t)) {
      closeTable();
      if (!inUl) { out.push('<ul>'); inUl = true; }
      out.push(`<li>${inline(t.slice(2))}</li>`);
    } else if (t.startsWith('|')) {
      closeUl();
      const cells = t.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length && cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // 表头分隔行
      if (!inTable) { out.push('<table class="md-table"><tbody>'); inTable = true; thPending = true; }
      const tag = thPending ? 'th' : 'td';
      thPending = false;
      out.push(`<tr>${cells.map((c) => `<${tag}>${inline(c)}</${tag}>`).join('')}</tr>`);
    } else if (!t) {
      closeUl(); closeTable();
    } else {
      closeUl(); closeTable();
      out.push(`<p>${inline(t)}</p>`);
    }
  }
  closeUl(); closeTable();
  return out.join('');
}

/* 旧版简报内嵌"预测逐项对照"表格（时点快照），展示时整节剔除，
 * 逐项对照由下方实时表格承担 */
function stripCompareSection(md) {
  const lines = String(md).split(/\r?\n/);
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (/^#{1,3}\s*预测逐项对照/.test(t)) { skipping = true; continue; }
    if (skipping && /^##\s/.test(t)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join('\n').trim();
}

/* 实时"预测逐项对照"表：规则状态 + 最新 AI 判定，永远与跟踪板/顶部 KPI 同步 */
function renderLiveCompareTable() {
  const rows = STATE.predictions.map((p) => {
    const meta = STATUS_META[p._eval.status] || STATUS_META.pending;
    const j = p.aiJudge;
    const aiCell = j
      ? `<span class="badge ai-judge-badge">${esc(AI_VERDICT_LABEL[j.verdict] || j.verdict)}${Number.isFinite(Number(j.confidence)) ? ' · ' + Math.round(Number(j.confidence) * 100) + '%' : ''}</span>`
      : '<span class="muted">—</span>';
    const aiReason = j ? esc(j.reason) : '<span class="muted">尚未判定</span>';
    return `<tr>
      <td>${esc(p.id)}</td>
      <td>${esc(p.title)}</td>
      <td><span class="badge ${meta.cls}">${esc(p._eval.statusLabel)}</span></td>
      <td>${aiCell}</td>
      <td>${esc(p._eval.detail)}</td>
      <td>${aiReason}</td>
    </tr>`;
  }).join('');
  return `<div class="live-note">📋 下表为<b>实时对照</b>（规则状态 + 最新 AI 判定），始终与预测跟踪板、顶部「下一个验证节点」同步；其后 AI 文字为生成时点的点评。</div>
  <div class="table-wrap"><table class="md-table">
    <thead><tr><th>ID</th><th>预测项</th><th>规则状态</th><th>AI 判定</th><th>当前判定依据</th><th>AI 点评</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function renderAI() {
  const a = STATE.analysis || { llmConfigured: false, runs: [] };
  const body = $('#ai-body');
  const btn = $('#btn-analysis');
  btn.style.display = a.llmConfigured ? '' : 'none';
  if (!a.llmConfigured) {
    body.innerHTML = `<div class="empty">尚未配置大模型：复制 <code>data/config.example.json</code> 为 <code>data/config.json</code>，填入 OpenAI 兼容接口的 <code>baseUrl / apiKey / model</code>（支持智谱 GLM、DeepSeek、OpenAI 等），保存后刷新本页即可启用「生成简报」与每日自动研判。</div>`;
    return;
  }
  // 对照表实时渲染，即使尚未生成简报也可用
  let html = renderLiveCompareTable();
  if (a.runs.length) {
    const [latest, ...rest] = a.runs;
    html += `
    <div class="ai-meta">
      <span>AI 点评</span>
      <span>· ${fmtTime(latest.at)}</span>
      <span>· ${esc(latest.model)}</span>
      <span>· 触发：${esc(latest.trigger || '手动')}</span>
      <span>· 数据截至 ${fmtTime(latest.dataAsOf)}</span>
      ${rest.length ? `<span>· 历史 ${rest.length} 次</span>` : ''}
    </div>`;
    if (latest.cards) {
      // 结构化简报：焦点卡片（卡片可绑定实时指标值 / 关联预测实时状态）
      html += focusSection('当前形势', latest.cards.situation)
        + focusSection('下阶段关注点', latest.cards.focus)
        + focusSection('风险提示', latest.cards.risks);
    } else {
      // 旧版 markdown 简报：剔除内嵌对照表后按原文展示
      html += `<div class="ai-content">${md2html(stripCompareSection(latest.md || ''))}</div>`;
    }
    html += rest.length ? `<details class="ai-history"><summary>历史简报</summary><ul>${rest.map((r) => `<li>${fmtTime(r.at)} · ${esc(r.model)} · ${esc(r.trigger || '手动')}${r.cards ? ' · 结构化' : ''}</li>`).join('')}</ul></details>` : '';
  } else {
    html += '<div class="empty">AI 点评尚未生成，点击右上角「生成简报」。</div>';
  }
  body.innerHTML = html;
}

/* 焦点栏目：结构化简报卡片。卡片可绑定指标键（实时显示最新观测值）
 * 或关联预测 id（实时显示其规则状态），"与数据同步"由渲染层保证 */
function liveMetricChip(metricKey) {
  const o = latestValue(metricKey);
  const m = STATE.metrics[metricKey];
  if (!o || !m) return '';
  const val = m.kind === 'date' ? esc(o.value) : `${fmtNum(Number(o.value))}${esc(m.unit || '')}`;
  return `<span class="live-chip-mini">实时 · ${esc(m.label)} ${val}（${esc(o.date)}）</span>`;
}

function focusCardHtml(c) {
  let head = '';
  if (c.target) {
    const p = STATE.predictions.find((x) => x.id === c.target);
    if (p) {
      const meta = STATUS_META[p._eval.status] || STATUS_META.pending;
      head = `<div class="fc-head"><span class="badge ${meta.cls}">${esc(p.id)} · ${esc(p._eval.statusLabel)}</span></div>`;
    }
  }
  const live = c.metric ? liveMetricChip(c.metric) : '';
  return `<div class="focus-card">
    ${head}
    <div class="fc-title">${esc(c.title)}</div>
    <div class="fc-text">${esc(c.text)}</div>
    ${live ? `<div class="fc-live">${live}</div>` : ''}
  </div>`;
}

function focusSection(title, items) {
  if (!items || !items.length) return '';
  return `<div class="focus-section">
    <h4>${esc(title)}</h4>
    <div class="focus-grid">${items.map((c) => focusCardHtml(c)).join('')}</div>
  </div>`;
}

/* ---------- 分页 ---------- */
const PAGE_SIZE = 20;
let tlPage = 1, tlTotal = 0, tlTotalPages = 1;
let obsPage = 1, obsTotal = 0, obsTotalPages = 1;

function pagerHtml(page, totalPages, total) {
  if (!total) return '';
  if (totalPages <= 1) return `<div class="pager">共 ${total} 条</div>`;
  return `<div class="pager">
    <button type="button" class="pg-btn" data-pg="first" ${page <= 1 ? 'disabled' : ''}>«</button>
    <button type="button" class="pg-btn" data-pg="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="pg-info">第 ${page} / ${totalPages} 页 · 共 ${total} 条</span>
    <button type="button" class="pg-btn" data-pg="next" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
    <button type="button" class="pg-btn" data-pg="last" ${page >= totalPages ? 'disabled' : ''}>»</button>
  </div>`;
}

function applyPage(current, action, totalPages) {
  if (action === 'first') return 1;
  if (action === 'prev') return Math.max(1, current - 1);
  if (action === 'next') return Math.min(totalPages, current + 1);
  if (action === 'last') return totalPages;
  return current;
}

/* ---------- 事件时间线（含来源筛选与分页） ---------- */

const TL_FILTERS = [
  ['all', '全部'], ['auto', '自动生成'], ['manual', '人工录入'],
  ['披露', '披露'], ['媒体', '媒体'], ['研判', '研判'], ['历史对照', '历史对照'],
];
let tlFilter = 'all';

function renderTlFilters() {
  $('#tl-filters').innerHTML = TL_FILTERS.map(([k, label]) =>
    `<button type="button" class="chip-btn ${tlFilter === k ? 'active' : ''}" data-k="${k}">${label}</button>`
  ).join('');
}

function renderTimeline() {
  renderTlFilters();
  const all = [...STATE.events].sort((a, b) => (a.date < b.date ? 1 : -1));
  const filtered = all.filter((e) => {
    if (tlFilter === 'all') return true;
    if (tlFilter === 'auto') return !!e.auto;
    if (tlFilter === 'manual') return !e.auto;
    return e.level === tlFilter;
  });
  tlTotal = filtered.length;
  tlTotalPages = Math.max(1, Math.ceil(tlTotal / PAGE_SIZE));
  tlPage = Math.min(Math.max(1, tlPage), tlTotalPages);
  const events = filtered.slice((tlPage - 1) * PAGE_SIZE, tlPage * PAGE_SIZE);
  const listHtml = events.length
    ? `<ol class="timeline">${events.map((e) => `
    <li>
      <span class="t-date">${esc(e.date)}</span>
      <div class="t-body">
        <span class="chip lv-${esc(e.level)}">${esc(e.level)}</span>${e.auto ? '<span class="tag-auto">自动</span> ' : ''}${esc(e.title)}
        ${e.source ? `<div class="t-src">来源：${esc(e.source)}</div>` : ''}
      </div>
    </li>`).join('')}</ol>`
    : '<div class="empty">该筛选下暂无事件</div>';
  $('#timeline').innerHTML = listHtml + pagerHtml(tlPage, tlTotalPages, tlTotal);
}

/* ---------- 观测记录表（分页） ---------- */
function renderObsTable() {
  const all = [...STATE.observations].sort((a, b) => (a.date < b.date ? 1 : -1));
  obsTotal = all.length;
  obsTotalPages = Math.max(1, Math.ceil(obsTotal / PAGE_SIZE));
  obsPage = Math.min(Math.max(1, obsPage), obsTotalPages);
  const rows = all.slice((obsPage - 1) * PAGE_SIZE, obsPage * PAGE_SIZE);
  if (!rows.length) { $('#obs-table').innerHTML = '<div class="empty">暂无观测记录</div>' + pagerHtml(obsPage, obsTotalPages, obsTotal); return; }
  $('#obs-table').innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>日期</th><th>指标</th><th>数值</th><th>来源</th><th>备注</th><th></th></tr></thead>
    <tbody>${rows.map((o) => {
      const m = STATE.metrics[o.metric] || {};
      const val = m.kind === 'date' ? esc(o.value) : `${fmtNum(Number(o.value))}${esc(m.unit || '')}`;
      return `<tr class="${o.background ? 'bg-row' : ''}">
        <td>${esc(o.date)}</td>
        <td>${esc(m.label || o.metric)}${o.background ? '<span class="tag-bg">背景</span>' : ''}${o.auto ? '<span class="tag-auto">自动</span>' : ''}</td>
        <td>${val}</td>
        <td>${esc(o.source || '')}</td>
        <td>${esc(o.note || '')}</td>
        <td><button class="del-btn" data-id="${esc(o.id)}" title="删除该记录${o.auto ? '（自动记录会在下次同步恢复）' : ''}">✕</button></td>
      </tr>`;
    }).join('')}</tbody>
  </table></div>` + pagerHtml(obsPage, obsTotalPages, obsTotal);
}

/* ---------- 录入表单 ---------- */
function fillMetricSelect() {
  const groups = {};
  for (const [key, m] of Object.entries(STATE.metrics)) (groups[m.group || '其他'] ||= []).push({ key, m });
  $('#f-metric').innerHTML = Object.entries(groups).map(([g, items]) =>
    `<optgroup label="${esc(g)}">${items.map(({ key, m }) => `<option value="${esc(key)}">${esc(m.label)}</option>`).join('')}</optgroup>`
  ).join('');
  updateValueInput();
}

function updateValueInput() {
  const key = $('#f-metric').value;
  const m = STATE.metrics[key];
  const input = $('#f-value');
  const isDate = m && m.kind === 'date';
  input.type = isDate ? 'date' : 'number';
  input.placeholder = isDate ? '' : '如 3.2';
  $('#f-value-label').firstChild.textContent = isDate ? '日期值 ' : '数值 ';
  $('#f-hint').textContent = m && m.desc ? `口径：${m.desc}` : '';
}

async function submitObservation(e) {
  e.preventDefault();
  const f = e.target;
  const body = {
    metric: f.metric.value,
    date: f.date.value,
    value: f.value.value,
    source: f.source.value.trim(),
    note: f.note.value.trim(),
  };
  try {
    await API.post('/api/observations', body);
    toast('观测已录入，判定已更新');
    f.date.value = ''; f.value.value = ''; f.note.value = '';
    obsPage = 1; // 新记录排在最前，跳回第 1 页可见
    await refresh();
  } catch (err) { toast(err.message, true); }
}

async function submitEvent(e) {
  e.preventDefault();
  const f = e.target;
  try {
    await API.post('/api/events', { date: f.date.value, level: f.level.value, title: f.title.value.trim(), source: f.source.value.trim() });
    toast('事件已添加');
    f.title.value = ''; f.source.value = '';
    tlPage = 1;
    await refresh();
  } catch (err) { toast(err.message, true); }
}

/* ---------- 事件委托 ---------- */
$('#board').addEventListener('change', async (e) => {
  const sel = e.target.closest('select.override');
  if (!sel) return;
  const id = sel.dataset.id;
  try {
    if (!sel.value) await API.post(`/api/predictions/${id}/status`, { clear: true });
    else {
      const reason = prompt('复核理由（可留空）：') || '';
      await API.post(`/api/predictions/${id}/status`, { status: sel.value, reason });
    }
    toast('复核状态已更新');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

$('#obs-table').addEventListener('click', async (e) => {
  const pg = e.target.closest('.pg-btn');
  if (pg) {
    if (!pg.disabled) {
      obsPage = applyPage(obsPage, pg.dataset.pg, obsTotalPages);
      renderObsTable();
    }
    return;
  }
  const btn = e.target.closest('.del-btn');
  if (!btn) return;
  try {
    await API.del(`/api/observations/${btn.dataset.id}`);
    toast('记录已删除');
    await refresh();
  } catch (err) { toast(err.message, true); }
});

$('#f-metric').addEventListener('change', updateValueInput);
$('#obs-form').addEventListener('submit', submitObservation);
$('#event-form').addEventListener('submit', submitEvent);
$('#btn-refresh').addEventListener('click', () => refresh().catch(() => toast('刷新失败', true)));

$('#tl-filters').addEventListener('click', (e) => {
  const btn = e.target.closest('.chip-btn');
  if (!btn) return;
  tlFilter = btn.dataset.k;
  tlPage = 1;
  renderTimeline();
});

$('#timeline').addEventListener('click', (e) => {
  const btn = e.target.closest('.pg-btn');
  if (!btn || btn.disabled) return;
  tlPage = applyPage(tlPage, btn.dataset.pg, tlTotalPages);
  renderTimeline();
});

$('#btn-analysis').addEventListener('click', async () => {
  const btn = $('#btn-analysis');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = '生成中…（30 秒 ~ 3 分钟）';
  try {
    const r = await API.post('/api/analysis', {});
    await refresh();
    toast(`AI 简报已生成（判定：${r._judgeNote || '未执行'}）`);
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = old;
});

$('#btn-judge').addEventListener('click', async () => {
  const btn = $('#btn-judge');
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'AI 判定中…';
  try {
    const r = await API.post('/api/ai/judge', {});
    await refresh();
    toast(`AI 判定完成：${r._judgeNote || ''}`);
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = old;
});

/* 顶栏：滚动折叠/展开
 * 采用绝对阈值迟滞：滚过 COLLAPSE_AT 折叠，滚回 EXPAND_BELOW 以内展开。
 * 两个阈值间隔必须大于折叠节省的高度差（约 70px）：顶栏折叠会使页面内容
 * 上移，浏览器滚动锚定会反向回调 scrollY，若用"方向判定"或间隔过小，
 * 锚定回弹会被误判为反向滚动，造成无输入时反复放大缩小。 */
const COLLAPSE_AT = 200;
const EXPAND_BELOW = 90;
let topbarCollapsed = false;
const updateTopbar = () => {
  const y = window.scrollY || document.documentElement.scrollTop || 0;
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  if (!topbarCollapsed && y > COLLAPSE_AT) {
    topbarCollapsed = true;
    bar.classList.add('collapsed');
  } else if (topbarCollapsed && y < EXPAND_BELOW) {
    topbarCollapsed = false;
    bar.classList.remove('collapsed');
  }
};
window.addEventListener('scroll', updateTopbar, { passive: true, capture: true });
document.addEventListener('scroll', updateTopbar, { passive: true, capture: true });
setInterval(updateTopbar, 300);

$('#btn-sync').addEventListener('click', async () => {
  const btn = $('#btn-sync');
  btn.disabled = true;
  btn.textContent = '同步中…';
  try {
    await API.post('/api/sync', {});
    await refresh();
    const s = STATE.sync || {};
    const sums = (s.results || []).reduce(
      (t, r) => { const m = (r.detail || '').match(/落库新增 (\d+) \/ 更新 (\d+)/); if (m) { t[0] += +m[1]; t[1] += +m[2]; } return t; },
      [0, 0]
    );
    const fail = (s.results || []).some((r) => !r.ok);
    toast(`同步完成：新增 ${sums[0]} · 更新 ${sums[1]}` + (fail ? '（部分源失败，悬停状态提示查看）' : ''));
  } catch (err) { toast(err.message, true); }
  btn.disabled = false;
  btn.textContent = '立即同步';
});

/* ---------- 主流程 ---------- */
async function refresh() {
  STATE = await API.state();
  renderKpis();
  renderLiveStrip();
  renderSync();
  renderNinoChart();
  renderTempChart();
  renderRainChart();
  renderBoard();
  renderAI();
  renderTimeline();
  renderObsTable();
}

refresh().catch((err) => {
  document.body.insertAdjacentHTML('afterbegin', `<div class="empty" style="padding:20px">看板加载失败：${esc(err.message)}（请确认 node server.js 已启动）</div>`);
});
setInterval(() => refresh().catch(() => {}), 5 * 60 * 1000);
