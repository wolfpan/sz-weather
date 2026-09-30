'use strict';
/*
 * 大模型分析模块（OpenAI 兼容接口直连）
 * 配置：data/config.json → { "llm": { "baseUrl": "...", "apiKey": "...", "model": "...", "maxTokens": 8000 } }
 *       环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 可覆盖
 * 产出：data/analysis.json（简报，保留最近 30 次）；预测 AI 判定写回 predictions.json 的 aiJudge 字段
 */

const fs = require('fs');
const path = require('path');

const F_CONF = path.join(__dirname, 'data', 'config.json');
const F_ANALYSIS = path.join(__dirname, 'data', 'analysis.json');
const TIMEOUT = 300000; // 推理类模型生成完整简报可能需要数分钟

function loadConfig() {
  let conf = {};
  try { conf = JSON.parse(fs.readFileSync(F_CONF, 'utf8')); } catch { /* 未配置 */ }
  const llm = conf.llm || {};
  const baseUrl = String(process.env.LLM_BASE_URL || llm.baseUrl || '').replace(/\/+$/, '');
  const apiKey = String(process.env.LLM_API_KEY || llm.apiKey || '');
  const model = String(process.env.LLM_MODEL || llm.model || '');
  return { baseUrl, apiKey, model, maxTokens: Number(llm.maxTokens) || 8000, enabled: !!(baseUrl && apiKey && model) };
}

/* ---------- 通用 OpenAI 兼容调用 ---------- */

async function callChat(conf, messages) {
  // baseUrl 兼容两种写法：API 根地址（自动拼接）或完整 endpoint（已含 /chat/completions）
  const endpoint = conf.baseUrl.endsWith('/chat/completions')
    ? conf.baseUrl
    : `${conf.baseUrl}/chat/completions`;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conf.apiKey}` },
    body: JSON.stringify({
      model: conf.model,
      messages,
      temperature: 0.4,
      // 推理类模型（DeepSeek-R 系等）的思考 token 计入 max_tokens，需给足余量
      max_tokens: conf.maxTokens,
    }),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`LLM HTTP ${r.status}：${t.slice(0, 200)}`);
  }
  const data = await r.json();
  if (data.error) {
    const msg = typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    throw new Error(`LLM 返回错误：${msg.slice(0, 300)}`);
  }
  const md = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  if (!md || !String(md).trim()) throw new Error(`LLM 返回内容为空：${JSON.stringify(data).slice(0, 300)}`);
  return String(md).trim();
}

/* ---------- 共享快照构造（只喂看板内数据，约束模型不得引入外部事实） ---------- */

function recentObs(state, metric, n) {
  return state.observations
    .filter((o) => o.metric === metric && !o.background)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-n)
    .map((o) => ({ date: o.date, value: o.value, note: o.note }));
}

function recentEvents(state, n) {
  return [...state.events]
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .slice(0, n)
    .map((e) => ({ date: e.date, level: e.level, 自动: !!e.auto, title: e.title }));
}

function baseSnapshot(state) {
  return {
    数据截至: state.now,
    nino34_近期: recentObs(state, 'nino34_ssta', 8),
    深圳月均温: recentObs(state, 'sz_temp_month', 6),
    深圳月雨量: recentObs(state, 'sz_rain_month', 6),
    本月至今: state.sync && state.sync.currentMonth ? state.sync.currentMonth : undefined,
    近期事件: recentEvents(state, 20),
    常年值参考: {
      入秋: state.normals.enter_autumn_normal,
      入冬: state.normals.enter_winter_normal,
      冬季均温: state.normals.winter_temp_normal,
      冬季雨量: state.normals.winter_rain_normal,
    },
  };
}

/* ---------- 简报生成 ---------- */

function buildPrompt(state) {
  const snapshot = baseSnapshot(state);
  snapshot['预测与判定'] = state.predictions.map((p) => ({
    id: p.id, phase: p.phase, title: p.title,
    状态: p._eval.statusLabel, 窗口: `${p.window.start} ~ ${p.window.end}`,
    判定明细: p._eval.detail, 基准口径: p.verify.baseline_label || undefined, 备注: p.note || undefined,
  }));
  const system = [
    '你是助理气候分析师，为「深圳气温 × 厄尔尼诺预测跟踪看板」撰写结构化研判简报。规则：',
    '1) 只允许引用用户输入 JSON 中的数据与事实；禁止引入输入之外的资讯或数值；某项数据缺失就写"数据不足"。',
    '2) 每个结论必须标注依据（引用具体数值、状态或日期）。',
    '3) 用简体中文 markdown；仅使用二级/三级标题、列表与粗体；不要输出表格、不要输出一级标题与结尾客套。',
    '4) 固定三节：## 当前形势 / ## 下阶段关注点 / ## 风险提示。',
    '5) 不要输出"预测逐项对照"表格——逐项状态由看板以实时数据另行渲染；但文字中可引用具体预测的 id、状态与数值展开点评。',
    '6) 客观克制，区分"已发生事实"与"概率研判"，不渲染、不加免责声明。',
  ].join('\n');
  const user = `看板状态快照 JSON：\n${JSON.stringify(snapshot, null, 1)}\n\n请按系统规则输出研判简报。`;
  return { system, user };
}

async function generateBriefing(state) {
  const conf = loadConfig();
  if (!conf.enabled) {
    const e = new Error('未配置 LLM：请复制 data/config.example.json 为 data/config.json 并填入 baseUrl / apiKey / model');
    e.code = 'NO_CONFIG';
    throw e;
  }
  const { system, user } = buildPrompt(state);
  const md = await callChat(conf, [{ role: 'system', content: system }, { role: 'user', content: user }]);
  return { md, model: conf.model };
}

/* ---------- 预测 AI 判定 ---------- */

const VERDICTS = ['verified', 'partial', 'missed', 'active_ok', 'active', 'pending'];

function buildJudgePrompt(state) {
  const snapshot = baseSnapshot(state);
  snapshot['预测清单'] = state.predictions.map((p) => ({
    id: p.id, title: p.title,
    规则状态: p._eval.statusLabel, 判定明细: p._eval.detail,
    窗口: `${p.window.start} ~ ${p.window.end}`, 窗口已结束: p._eval.windowClosed, 窗口进行中: p._eval.windowOpen,
    判定规则: {
      指标: p.verify.metric, 聚合: p.verify.agg || 'latest', 规则: p.verify.op,
      目标: p.verify.target !== undefined ? p.verify.target : undefined,
      目标2: p.verify.target2 !== undefined ? p.verify.target2 : undefined,
      分档: p.verify.tiers, 基准日期: p.verify.op.startsWith('date') ? p.verify.baseline : undefined,
      基准说明: p.verify.baseline_label || undefined,
    },
    备注: p.note || undefined,
  }));
  const system = [
    '你是预测验证助理，对跟踪看板的预测清单逐项给出 AI 判定。规则：',
    '1) 只依据输入 JSON 中的数据；禁止引入外部信息；数据不足要如实判定为 active 或 pending。',
    '2) verdict 仅允许取值：verified（已达标/兑现）、partial（落入次级档/部分达标）、missed（窗口已结束且未达标）、active_ok（窗口进行中且当前数据已支持）、active（窗口进行中且数据不足或暂不支持）、pending（窗口未开始或无数据）。',
    '3) 判定须与预测自带的阈值/分档一致；窗口进行中时禁止给出 verified/missed 这类终局判定。',
    '4) reason ≤40 字，必须引用关键数值或日期。',
    '5) 只输出 JSON 数组（禁止 markdown 代码块与任何解释），逐项形如 {"id":"P0-1","verdict":"pending","confidence":0.9,"reason":"…"}，必须覆盖预测清单全部项。',
  ].join('\n');
  const user = `看板状态快照 JSON：\n${JSON.stringify(snapshot, null, 1)}\n\n请输出判定 JSON 数组。`;
  return { system, user };
}

function parseJudgements(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```\s*$/, '').trim();
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a < 0 || b <= a) throw new Error('判定输出中未找到 JSON 数组');
  const arr = JSON.parse(t.slice(a, b + 1));
  const seen = new Set();
  const items = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const { id, verdict, confidence, reason } = it;
    if (!id || !VERDICTS.includes(verdict)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      id,
      verdict,
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
      reason: String(reason || '').slice(0, 80),
    });
  }
  if (!items.length) throw new Error('判定解析结果为空');
  return items;
}

async function judgePredictions(state) {
  const conf = loadConfig();
  if (!conf.enabled) {
    const e = new Error('未配置 LLM：请复制 data/config.example.json 为 data/config.json 并填入 baseUrl / apiKey / model');
    e.code = 'NO_CONFIG';
    throw e;
  }
  const { system, user } = buildJudgePrompt(state);
  const out = await callChat(conf, [{ role: 'system', content: system }, { role: 'user', content: user }]);
  const items = parseJudgements(out);
  return { items, model: conf.model };
}

/* ---------- 存取 ---------- */

function readAnalysis() {
  try { return JSON.parse(fs.readFileSync(F_ANALYSIS, 'utf8')); } catch { return { runs: [] }; }
}

function saveRun(run) {
  const store = readAnalysis();
  store.runs = [run, ...(store.runs || [])].slice(0, 30);
  fs.writeFileSync(F_ANALYSIS, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return store;
}

module.exports = { loadConfig, generateBriefing, judgePredictions, readAnalysis, saveRun };
