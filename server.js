#!/usr/bin/env node
'use strict';
/*
 * 深圳气温 × 超强厄尔尼诺 · 预测跟踪看板
 * 零依赖 Node 服务：静态页面 + JSON API + data/ 目录 JSON 落盘
 * 启动：node server.js （默认 http://localhost:3000，可用 PORT 环境变量覆盖）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { syncAll, readStatus, refreshCurrentWeather } = require('./sync');
const llm = require('./llm');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const PORT = Number(process.env.PORT || 3000);

const F = {
  metrics: path.join(DATA_DIR, 'metrics.json'),
  normals: path.join(DATA_DIR, 'normals.json'),
  predictions: path.join(DATA_DIR, 'predictions.json'),
  observations: path.join(DATA_DIR, 'observations.json'),
  events: path.join(DATA_DIR, 'events.json'),
  sync: path.join(DATA_DIR, 'sync.json'),
  analysis: path.join(DATA_DIR, 'analysis.json'),
  config: path.join(DATA_DIR, 'config.json'),
  auth: path.join(DATA_DIR, 'auth.json'),
};

/* ---------- 操作密码验证 ----------
 * config.json → { "auth": { "password": "..." } }，留空或缺失即不启用。
 * 登录成功签发 UUID 存入 data/auth.json（服务重启仍有效）；
 * 客户端以 X-Auth-Token 头携带，localStorage 记忆，输入一次持久有效。 */
const authPassword = () => {
  try { return String(JSON.parse(fs.readFileSync(F.config, 'utf8')).auth.password || ''); }
  catch { return ''; }
};
const readTokens = () => {
  try { return JSON.parse(fs.readFileSync(F.auth, 'utf8')).tokens || []; }
  catch { return []; }
};
const saveTokens = (tokens) => fs.writeFileSync(F.auth, JSON.stringify({ tokens }, null, 2) + '\n', 'utf8');
const hasValidToken = (req) => {
  const tok = req.headers['x-auth-token'];
  return !!tok && readTokens().includes(String(tok));
};

const readJSON = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
};
const writeJSON = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
const today = () => new Date().toISOString().slice(0, 10);
const round = (x, n) => Math.round(x * 10 ** n) / 10 ** n;
const fmtVal = (x) => {
  const n = Number(x);
  return Number.isInteger(n) ? String(n) : String(round(n, 2));
};

/* ---------------- 预测判定 ---------------- */

const AGG_NAME = { latest: '最新值', max: '最大值', min: '最小值', sum: '累计', avg: '均值', count: '条数' };
const STATUS_NAME = { verified: '已兑现', partial: '部分兑现', missed: '未兑现', pending: '待验证' };

function aggregate(records, agg) {
  const last = records[records.length - 1];
  switch (agg) {
    case 'max': return records.reduce((a, b) => (Number(b.value) > Number(a.value) ? b : a));
    case 'min': return records.reduce((a, b) => (Number(b.value) < Number(a.value) ? b : a));
    case 'sum': return { ...last, value: round(records.reduce((t, o) => t + Number(o.value), 0), 1) };
    case 'avg': return { ...last, value: round(records.reduce((t, o) => t + Number(o.value), 0) / records.length, 2) };
    case 'count': return { ...last, value: records.length };
    default: return last; // latest
  }
}

function matchTier(value, tier) {
  if (tier.else) return true;
  if (tier.gte !== undefined && !(value >= tier.gte)) return false;
  if (tier.lte !== undefined && !(value <= tier.lte)) return false;
  if (tier.gt !== undefined && !(value > tier.gt)) return false;
  if (tier.lt !== undefined && !(value < tier.lt)) return false;
  return true;
}

function targetText(v) {
  switch (v.op) {
    case 'gte': return `目标 ≥${v.target}`;
    case 'lte': return `目标 ≤${v.target}`;
    case 'between': return `目标 ${v.target}~${v.target2}`;
    case 'tiers': return '分级判定';
    case 'dateAfter': return `基准 ${v.baseline} 之后`;
    case 'dateAfterOrNever': return `基准 ${v.baseline} 之后（或未发生）`;
    case 'dateBefore': return `基准 ${v.baseline} 之前`;
    case 'dateBeforeOrNever': return `基准 ${v.baseline} 之前（或未发生）`;
    default: return '';
  }
}

function evaluatePrediction(pred, observations, metrics) {
  const v = pred.verify;
  const m = metrics[v.metric] || {};
  const unit = m.unit || '';
  const isDate = m.kind === 'date';
  const now = today();
  const started = now >= pred.window.start;
  const closed = now > pred.window.end;
  const meta = { windowStarted: started, windowClosed: closed, windowOpen: started && !closed };

  const rows = observations
    .filter((o) => o.metric === v.metric && !o.background && o.date >= pred.window.start && o.date <= pred.window.end)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  meta.obsCount = rows.length;

  if (!rows.length) {
    if (!started) return { ...meta, status: 'pending', statusLabel: '待验证', detail: '验证窗口未开始' };
    if (closed && (v.op === 'dateAfterOrNever' || v.op === 'dateBeforeOrNever'))
      return { ...meta, status: 'verified', statusLabel: '已兑现', detail: v.neverLabel || '窗口内无记录，按规则视为兑现' };
    if (closed) return { ...meta, status: 'pending', statusLabel: '待补数据', detail: '窗口已结束但未录入观测' };
    return { ...meta, status: 'active', statusLabel: '进行中', detail: '窗口内暂无观测' };
  }

  const rec = aggregate(rows, v.agg || 'latest');
  const val = rec.value;
  const valText = isDate ? String(val) : `${fmtVal(val)}${unit}`;
  const detail = `${AGG_NAME[v.agg || 'latest']} ${valText}（${targetText(v)}）· 已录入 ${rows.length} 条`;

  if (v.op.startsWith('date')) {
    const md = String(val).slice(5, 10);
    const after = v.op.startsWith('dateAfter');
    const ok = after ? md > v.baseline : md < v.baseline;
    return ok
      ? { ...meta, status: closed ? 'verified' : 'active_ok', statusLabel: closed ? '已兑现' : '进行中·暂符合', detail, value: val }
      : { ...meta, status: closed ? 'missed' : 'active', statusLabel: closed ? '未兑现' : '进行中·暂未符合', detail, value: val };
  }

  if (v.op === 'tiers') {
    const tier = (v.tiers || []).find((t) => matchTier(val, t));
    if (tier && !tier.else && tier.status !== 'missed') {
      return {
        ...meta,
        status: closed ? tier.status : 'active_ok',
        statusLabel: closed ? (STATUS_NAME[tier.status] || tier.status) : `进行中·${tier.label}`,
        detail: `${detail} — ${tier.label}`,
        value: val,
      };
    }
    return {
      ...meta,
      status: closed ? 'missed' : 'active',
      statusLabel: closed ? '未兑现' : '进行中',
      detail: tier ? `${detail} — ${tier.label}` : detail,
      value: val,
    };
  }

  let ok = false;
  if (v.op === 'gte') ok = val >= v.target;
  else if (v.op === 'lte') ok = val <= v.target;
  else if (v.op === 'between') ok = val >= v.target && (v.target2 === undefined || val <= v.target2);

  return ok
    ? { ...meta, status: closed ? 'verified' : 'active_ok', statusLabel: closed ? '已兑现' : '进行中·暂符合', detail, value: val }
    : { ...meta, status: closed ? 'missed' : 'active', statusLabel: closed ? '未兑现' : '进行中·暂未符合', detail, value: val };
}

function buildState() {
  const metrics = readJSON(F.metrics, {});
  const normals = readJSON(F.normals, {});
  const preds = readJSON(F.predictions, { predictions: [] }).predictions || [];
  const obs = readJSON(F.observations, { observations: [] }).observations || [];
  const events = readJSON(F.events, { events: [] }).events || [];

  const predictions = preds.map((p) => {
    const ev = evaluatePrediction(p, obs, metrics);
    if (p.statusOverride) {
      const o = p.statusOverride;
      return {
        ...p,
        _eval: {
          ...ev,
          status: 'review',
          statusLabel: '手动复核',
          autoStatus: ev.status,
          autoStatusLabel: ev.statusLabel,
          detail: `${ev.detail} · 复核为「${STATUS_NAME[o.status] || o.status}」：${o.reason || '（无说明）'}`,
        },
      };
    }
    return { ...p, _eval: ev };
  });

  const counts = {};
  for (const p of predictions) counts[p._eval.status] = (counts[p._eval.status] || 0) + 1;

  const nextChecks = predictions
    .filter((p) => ['pending', 'active', 'active_ok'].includes(p._eval.status) && p.window.end >= today())
    .sort((a, b) => (a.window.end < b.window.end ? -1 : 1))
    .slice(0, 3)
    .map((p) => ({ id: p.id, title: p.title, end: p.window.end, statusLabel: p._eval.statusLabel }));

  const runs = (readJSON(F.analysis, { runs: [] }).runs || []).slice(0, 10);

  return {
    now: new Date().toISOString(),
    metrics,
    normals,
    predictions,
    observations: obs,
    events,
    sync: readStatus(),
    analysis: { llmConfigured: llm.loadConfig().enabled, runs },
    summary: { total: predictions.length, counts, nextChecks },
  };
}

/* ---------------- HTTP ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
  '.ico': 'image/x-icon',
};

const json = (res, obj, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    // 本地看板更新频繁：禁用缓存协商，保证刷新即拿到最新前端代码
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* 把 AI 逐项判定写回 predictions.json（字段 aiJudge，不覆盖人工复核 statusOverride） */
function persistJudge(items, model) {
  const store = readJSON(F.predictions, { predictions: [] });
  const at = new Date().toISOString();
  const done = [];
  for (const j of items || []) {
    const p = store.predictions.find((x) => x.id === j.id);
    if (!p) continue;
    p.aiJudge = { verdict: j.verdict, confidence: j.confidence, reason: j.reason, at, model };
    done.push(j.id);
  }
  writeJSON(F.predictions, store);
  return done;
}

async function handleApi(req, res, pathname) {
  const state = () => buildState();

  // 登录签发 UUID（密码正确时；未启用密码则直接返回空 token）
  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readBody(req);
    const pw = authPassword();
    if (!pw) return json(res, { token: null, note: '未启用密码验证' });
    if (String(body.password || '') !== pw) return json(res, { error: '密码错误' }, 401);
    const tokens = readTokens();
    const token = crypto.randomUUID();
    tokens.push(token);
    saveTokens(tokens);
    return json(res, { token });
  }

  // 写操作验证：启用密码后，除登录外的 POST/DELETE 均需有效 token（GET 查看不设限）
  if (req.method !== 'GET' && authPassword() && !hasValidToken(req)) {
    return json(res, { error: '此操作需要密码验证', needAuth: true }, 401);
  }

  if (req.method === 'GET' && pathname === '/api/state') return json(res, state());

  if (req.method === 'POST' && pathname === '/api/sync') {
    await syncAll(true);
    return json(res, state());
  }

  if (req.method === 'POST' && pathname === '/api/analysis') {
    const st = state();
    const { cards, md, model } = await llm.generateBriefing(st);
    const run = {
      id: 'A' + Date.now().toString(36),
      at: new Date().toISOString(),
      model,
      dataAsOf: st.now,
      trigger: '手动',
    };
    if (cards) run.cards = cards; else run.md = md;
    llm.saveRun(run);
    // 简报之外顺带更新逐项 AI 判定（失败不影响简报）
    let judgeNote = '未执行';
    try { judgeNote = `已判定 ${persistJudge(await llm.judgePredictions(st)).length} 项`; }
    catch (e) { judgeNote = `失败：${e.message.slice(0, 80)}`; }
    return json(res, { ...state(), _judgeNote: judgeNote });
  }

  if (req.method === 'POST' && pathname === '/api/ai/judge') {
    const st = state();
    const { items, model } = await llm.judgePredictions(st);
    const done = persistJudge(items, model);
    return json(res, { ...state(), _judgeNote: `已判定 ${done.length} 项` });
  }

  if (req.method === 'POST' && pathname === '/api/observations') {
    const body = await readBody(req);
    const metrics = readJSON(F.metrics, {});
    const m = metrics[body.metric];
    if (!m) throw new Error(`未知指标：${body.metric}`);
    if (!DATE_RE.test(String(body.date || ''))) throw new Error('日期格式应为 YYYY-MM-DD');
    let value;
    if (m.kind === 'date') {
      if (!DATE_RE.test(String(body.value || ''))) throw new Error('该指标要求录入日期（YYYY-MM-DD）');
      value = body.value;
    } else {
      value = Number(body.value);
      if (!Number.isFinite(value)) throw new Error('数值不合法');
    }
    const store = readJSON(F.observations, { observations: [] });
    const rec = {
      id: 'O' + Date.now().toString(36),
      date: body.date,
      metric: body.metric,
      value,
      source: String(body.source || '').slice(0, 120),
      note: String(body.note || '').slice(0, 300),
    };
    if (body.background) rec.background = true;
    store.observations.push(rec);
    writeJSON(F.observations, store);
    return json(res, state());
  }

  const delObs = pathname.match(/^\/api\/observations\/([^/]+)$/);
  if (req.method === 'DELETE' && delObs) {
    const store = readJSON(F.observations, { observations: [] });
    const before = store.observations.length;
    store.observations = store.observations.filter((o) => o.id !== delObs[1]);
    if (store.observations.length === before) throw new Error('未找到该观测记录');
    writeJSON(F.observations, store);
    return json(res, state());
  }

  const predStatus = pathname.match(/^\/api\/predictions\/([^/]+)\/status$/);
  if (req.method === 'POST' && predStatus) {
    const body = await readBody(req);
    const store = readJSON(F.predictions, { predictions: [] });
    const pred = store.predictions.find((p) => p.id === predStatus[1]);
    if (!pred) throw new Error('未找到该预测项');
    if (body.clear) delete pred.statusOverride;
    else {
      const allowed = ['pending', 'partial', 'verified', 'missed'];
      if (!allowed.includes(body.status)) throw new Error(`status 须为 ${allowed.join('/')}`);
      pred.statusOverride = { status: body.status, reason: String(body.reason || '').slice(0, 200), at: new Date().toISOString() };
    }
    writeJSON(F.predictions, store);
    return json(res, state());
  }

  if (req.method === 'POST' && pathname === '/api/events') {
    const body = await readBody(req);
    if (!DATE_RE.test(String(body.date || ''))) throw new Error('日期格式应为 YYYY-MM-DD');
    const title = String(body.title || '').trim();
    if (!title) throw new Error('事件描述不能为空');
    const store = readJSON(F.events, { events: [] });
    store.events.push({
      id: 'E' + Date.now().toString(36),
      date: body.date,
      level: ['披露', '媒体', '研判', '历史对照', '其他'].includes(body.level) ? body.level : '其他',
      title: title.slice(0, 300),
      source: String(body.source || '').slice(0, 120),
    });
    writeJSON(F.events, store);
    return json(res, state());
  }

  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ error: '接口不存在' }));
}

const server = http.createServer(async (req, res) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname); }
  catch { res.writeHead(400); return res.end('Bad Request'); }

  try {
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, pathname);
  } catch (e) {
    json(res, { error: e.message || '服务器内部错误' }, 400);
  }
});

server.listen(PORT, () => {
  console.log(`[sz-weather] 预测跟踪看板已启动 → http://localhost:${PORT}`);
  console.log(`[sz-weather] 数据目录：${DATA_DIR}`);
});

// 自动同步：启动后 2.5 秒首跑，之后每 30 分钟一次（外部源为日/周级更新，30 分钟足够"实时"）
setTimeout(() => { syncAll().catch((e) => console.error('[sync]', e.message)); }, 2500);
setInterval(() => { syncAll().catch((e) => console.error('[sync]', e.message)); }, 30 * 60 * 1000);
// 深圳实况轻刷新：每 5 分钟只更新 currentWeather，顶部实况条保持新鲜
setInterval(() => { refreshCurrentWeather().catch(() => {}); }, 5 * 60 * 1000);

// AI 简报：每日一次（每 10 分钟检查一次当天是否已生成）；需在 data/config.json 配置 LLM
setInterval(() => {
  try {
    const conf = llm.loadConfig();
    if (!conf.enabled) return;
    const todayStr = new Date().toISOString().slice(0, 10);
    const lastRun = (llm.readAnalysis().runs || [])[0]; // 手动生成同样计入"每日一次"，避免重复调用
    if (lastRun && lastRun.at.slice(0, 10) === todayStr) return;
    const st = buildState();
    llm.generateBriefing(st)
      .then(({ cards, md, model }) => {
        const run = { id: 'A' + Date.now().toString(36), at: new Date().toISOString(), model, dataAsOf: st.now, trigger: '自动' };
        if (cards) run.cards = cards; else run.md = md;
        llm.saveRun(run);
        console.log('[llm] 每日 AI 简报已生成');
        return llm.judgePredictions(st);
      })
      .then(({ items, model }) => {
        const done = persistJudge(items, model);
        console.log(`[llm] 预测 AI 判定已更新（${done.length} 项）`);
      })
      .catch((e) => console.error('[llm] 每日任务失败：', e.message));
  } catch { /* 忽略定时任务异常 */ }
}, 10 * 60 * 1000);
