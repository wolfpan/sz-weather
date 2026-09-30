'use strict';
/*
 * 大模型分析模块（OpenAI 兼容接口直连）
 * 配置：data/config.json → { "llm": { "baseUrl": "...", "apiKey": "...", "model": "..." } }
 *       环境变量 LLM_BASE_URL / LLM_API_KEY / LLM_MODEL 可覆盖
 * 产出：data/analysis.json（保留最近 30 次），前端「AI 研判」面板渲染
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
  return { baseUrl, apiKey, model, enabled: !!(baseUrl && apiKey && model) };
}

/* 由看板结构化状态构造快照（只喂看板内数据，约束模型不得引入外部事实） */
function buildSnapshot(state) {
  const recent = (metric, n) => state.observations
    .filter((o) => o.metric === metric && !o.background)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-n)
    .map((o) => ({ date: o.date, value: o.value, note: o.note }));

  return {
    数据截至: state.now,
    nino34_近期: recent('nino34_ssta', 8),
    深圳月均温: recent('sz_temp_month', 6),
    深圳月雨量: recent('sz_rain_month', 6),
    本月至今: state.sync && state.sync.currentMonth ? state.sync.currentMonth : undefined,
    预测与判定: state.predictions.map((p) => ({
      id: p.id, phase: p.phase, title: p.title,
      状态: p._eval.statusLabel, 窗口: `${p.window.start} ~ ${p.window.end}`,
      判定明细: p._eval.detail, 基准口径: p.verify.baseline_label || undefined, 备注: p.note || undefined,
    })),
    近期事件: [...state.events]
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .slice(0, 20)
      .map((e) => ({ date: e.date, level: e.level, 自动: !!e.auto, title: e.title })),
    常年值参考: {
      入秋: state.normals.enter_autumn_normal,
      入冬: state.normals.enter_winter_normal,
      冬季均温: state.normals.winter_temp_normal,
      冬季雨量: state.normals.winter_rain_normal,
    },
  };
}

function buildPrompt(state) {
  const system = [
    '你是助理气候分析师，为「深圳气温 × 厄尔尼诺预测跟踪看板」撰写结构化研判简报。规则：',
    '1) 只允许引用用户输入 JSON 中的数据与事实；禁止引入输入之外的资讯或数值；某项数据缺失就写"数据不足"。',
    '2) 每个结论必须标注依据（引用具体数值、状态或日期）。',
    '3) 用简体中文 markdown；仅使用二级/三级标题、列表、表格与粗体；不要输出一级标题与结尾客套。',
    '4) 固定四节：## 当前形势 / ## 预测逐项对照 / ## 下阶段关注点 / ## 风险提示。',
    '5) "预测逐项对照"必须覆盖输入中全部预测项，逐项给出：状态 + 判定依据 + （进行中的）下阶段关注点。',
    '6) 客观克制，区分"已发生事实"与"概率研判"，不渲染、不加免责声明。',
  ].join('\n');
  const user = `看板状态快照 JSON：\n${JSON.stringify(buildSnapshot(state), null, 1)}\n\n请按系统规则输出研判简报。`;
  return { system, user };
}

async function callLLM(state) {
  const conf = loadConfig();
  if (!conf.enabled) {
    const e = new Error('未配置 LLM：请复制 data/config.example.json 为 data/config.json 并填入 baseUrl / apiKey / model');
    e.code = 'NO_CONFIG';
    throw e;
  }
  const { system, user } = buildPrompt(state);
  // baseUrl 兼容两种写法：API 根地址（自动拼接）或完整 endpoint（已含 /chat/completions）
  const endpoint = conf.baseUrl.endsWith('/chat/completions')
    ? conf.baseUrl
    : `${conf.baseUrl}/chat/completions`;
  // 推理类模型（DeepSeek-R 系等）的思考 token 计入 max_tokens，默认给足余量，可在 config.llm.maxTokens 覆盖
  const maxTokens = Number(conf.maxTokens) || 8000;
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conf.apiKey}` },
    body: JSON.stringify({
      model: conf.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0.4,
      max_tokens: maxTokens,
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
  return { md: String(md).trim(), model: conf.model };
}

function readAnalysis() {
  try { return JSON.parse(fs.readFileSync(F_ANALYSIS, 'utf8')); } catch { return { runs: [] }; }
}

function saveRun(run) {
  const store = readAnalysis();
  store.runs = [run, ...(store.runs || [])].slice(0, 30);
  fs.writeFileSync(F_ANALYSIS, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return store;
}

module.exports = { loadConfig, callLLM, readAnalysis, saveRun };
