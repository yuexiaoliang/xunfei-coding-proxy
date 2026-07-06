/**
 * 讯飞 Coding Plan 代理 - 监控仪表盘
 *
 * 独立 Web 服务，读取 proxy 的日志文件，展示：
 * - 成功率 / 请求数 / 失败数
 * - 重试次数分布
 * - 响应时长
 * - 实时日志流
 *
 * 不依赖任何第三方包，纯 Node.js 内置模块。
 *
 * 启动：
 *   node monitor.js
 *   MONITOR_PORT=9092 node monitor.js
 *   MONITOR_LOG=/path/to/out.log node monitor.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ============ 配置 ============
const CONFIG = {
  port: parseInt(process.env.MONITOR_PORT || '9091', 10),
  // 日志文件路径（默认指向 PM2 输出）
  logFile: process.env.MONITOR_LOG || path.join(__dirname, 'logs', 'out.log'),
  // 解析日志的最大尾部字节数（避免读取超大文件）
  tailBytes: parseInt(process.env.MONITOR_TAIL_BYTES || (2 * 1024 * 1024), 10),
  // 实时日志 SSE 推送间隔
  pollIntervalMs: parseInt(process.env.MONITOR_POLL_MS || '2000', 10),
};

// ============ 日志解析 ============
// PM2 日志行格式：
//   2026-07-05 19:05:03 +08:00: [2026-07-05T11:05:03.068Z] [INFO] 消息 {"meta":...}
// proxy 内部 log() 输出：
//   [2026-07-05T11:05:03.068Z] [INFO] 消息 {"meta":...}
// 两种都要能解析。

const LINE_RE = /^\[([^\]]+)\]\s+\[(DEBUG|INFO|WARN|ERROR)\]\s+(.*?)(\s+\{.*\})?\s*$/;
const PM2_PREFIX_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{2}:\d{2}:\s+/;

function parseLine(raw) {
  if (!raw) return null;
  // 去掉 PM2 时间前缀
  const line = raw.replace(PM2_PREFIX_RE, '');
  const m = line.match(LINE_RE);
  if (!m) return null;
  const ts = m[1];
  const level = m[2];
  const msg = m[3];
  let meta = null;
  if (m[4]) {
    try { meta = JSON.parse(m[4].trim()); } catch { meta = null; }
  }
  return { ts, level, msg, meta, raw: line };
}

/**
 * 读取日志文件尾部并按行解析
 */
function readRecentLogs(maxLines = 2000) {
  let data;
  try {
    const stat = fs.statSync(CONFIG.logFile);
    const start = Math.max(0, stat.size - CONFIG.tailBytes);
    const fd = fs.openSync(CONFIG.logFile, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    data = buf.toString('utf8');
  } catch (e) {
    return [];
  }
  const lines = data.split('\n');
  // 第一行可能被截断，丢掉
  if (lines.length > 1) lines.shift();
  const parsed = [];
  for (let i = lines.length - 1; i >= 0 && parsed.length < maxLines; i--) {
    const p = parseLine(lines[i]);
    if (p) parsed.push(p);
  }
  return parsed.reverse();
}


// ============ 指标计算 ============
/**
 * 归一化路径：把上游完整 URL 的 pathname 映射回本地路径风格
 * 上游: https://maas-coding-api.../v2/chat/completions → /v2/chat/completions
 * 上游: https://maas-coding-api.../anthropic/v1/messages → /anthropic/v1/messages
 */
function normalizePath(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return u.pathname;
  } catch {
    return rawUrl.split('?')[0];
  }
}

/**
 * 从上游错误响应体中提取讯飞错误信息
 * body 格式: {"error":{"code":10310,"message":"...","type":"..."}, ...}
 */
function extractUpstreamError(body) {
  if (!body) return null;
  const text = typeof body === 'string' ? body : String(body);
  try {
    const json = JSON.parse(text);
    const err = json.error || json;
    if (err && (err.code !== undefined || err.message || err.type)) {
      // 无 code 时用 type 作为分组 key（如 one_api_error），比 unknown 更有意义
      let code = err.code !== undefined ? String(err.code) : '';
      if (!code) code = err.type || 'unknown';
      return {
        code,
        message: err.message || '',
        type: err.type || '',
      };
    }
  } catch {
    // body 可能不是完整 JSON 或被截断，尝试正则提取
    // 注意：body 里的引号可能被转义为 \"，正则要兼容
    const codeMatch = text.match(/"code"\s*:\s*"?(-?\d+)/);
    const msgMatch = text.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    const typeMatch = text.match(/"type"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (codeMatch || msgMatch || typeMatch) {
      let code = codeMatch ? codeMatch[1] : '';
      if (!code) code = typeMatch ? typeMatch[1] : 'unknown';
      // 反转义消息里的 \" 等转义字符
      const unescape = s => s ? s.replace(/\\(.)/g, '$1') : '';
      return {
        code,
        message: msgMatch ? unescape(msgMatch[1]) : '',
        type: typeMatch ? typeMatch[1] : '',
      };
    }
  }
  return null;
}

/**
 * 基于日志条目计算统计指标
 */
function computeStats(entries) {
  const stats = {
    total: 0,           // 请求总数（收到请求）
    success: 0,         // 成功数
    failed: 0,          // 失败数（所有重试失败）
    retried: 0,         // 发生过重试的请求数
    totalRetries: 0,    // 重试总次数（= 收到可重试错误的次数）
    durations: [],      // 响应时长列表
    byPath: {},         // 按路径统计
    byHttpStatus: {},   // 按上游 HTTP 状态码统计
    upstreamErrors: {}, // 按讯飞错误码统计 { code: { count, message, type, lastTs } }
    upstreamErrorList: [], // 错误码列表（前端表格用）
    errorSamples: [],   // 失败样本（最终失败）
    retryHistogram: {   // 重试次数直方图
      '0': 0, '1-3': 0, '4-10': 0, '11-30': 0, '31+': 0,
    },
    windowStart: null,
    windowEnd: null,
  };

  function ensurePath(p) {
    if (!stats.byPath[p]) stats.byPath[p] = { total: 0, success: 0, failed: 0 };
    return stats.byPath[p];
  }

  function recordUpstreamError(errInfo, ts) {
    if (!errInfo) return;
    const key = errInfo.code;
    if (!stats.upstreamErrors[key]) {
      stats.upstreamErrors[key] = { code: key, count: 0, message: errInfo.message, type: errInfo.type, lastTs: ts };
    }
    stats.upstreamErrors[key].count++;
    stats.upstreamErrors[key].lastTs = ts;
    if (errInfo.message && !stats.upstreamErrors[key].message) {
      stats.upstreamErrors[key].message = errInfo.message;
    }
    if (errInfo.type && !stats.upstreamErrors[key].type) {
      stats.upstreamErrors[key].type = errInfo.type;
    }
  }

  for (const e of entries) {
    if (!stats.windowStart) stats.windowStart = e.ts;
    stats.windowEnd = e.ts;

    // 收到请求 → 计入总数
    const recvMatch = e.msg.match(/^收到请求:\s+(\S+)\s+(\S+)/);
    if (recvMatch) {
      stats.total++;
      const urlPath = recvMatch[2].split('?')[0];
      ensurePath(urlPath).total++;
      continue;
    }

    // 请求成功（流式/非流式）
    const okMatch = e.msg.match(/^(流式|非流式)请求成功\s*\(重试\s+(\d+)\s*次/);
    if (okMatch) {
      stats.success++;
      const retries = parseInt(okMatch[2], 10);
      if (retries > 0) stats.retried++;
      // 直方图
      if (retries === 0) stats.retryHistogram['0']++;
      else if (retries <= 3) stats.retryHistogram['1-3']++;
      else if (retries <= 10) stats.retryHistogram['4-10']++;
      else if (retries <= 30) stats.retryHistogram['11-30']++;
      else stats.retryHistogram['31+']++;
      // HTTP 状态码（成功日志的 statusCode 是上游返回的）
      if (e.meta && e.meta.statusCode) {
        stats.byHttpStatus[e.meta.statusCode] = (stats.byHttpStatus[e.meta.statusCode] || 0) + 1;
      }
      // 路径归并（成功日志里是上游完整 URL，归一化后匹配本地路径）
      if (e.meta && e.meta.url) {
        const p = normalizePath(e.meta.url);
        // 尝试匹配已存在的路径，找不到就新建（至少记录成功数）
        ensurePath(p).success++;
      }
      continue;
    }

    // 上游可重试错误（流式/非流式收到可重试状态码、非SSE可重试响应、缓冲阶段错误）
    const retryErrMatch = e.msg.match(/(流式请求收到可重试状态码|非流式请求遇到可重试错误|流式请求收到非 SSE 可重试响应|缓冲阶段检测到可重试错误)/);
    if (retryErrMatch) {
      stats.totalRetries++;
      // 提取 HTTP 状态码
      const httpCodeMatch = e.msg.match(/状态码:\s*(\d+)/);
      if (httpCodeMatch) {
        const httpCode = httpCodeMatch[1];
        stats.byHttpStatus[httpCode] = (stats.byHttpStatus[httpCode] || 0) + 1;
      }
      // 提取讯飞错误信息
      const bodyField = e.meta && (e.meta.body || e.meta.bodyPreview || e.meta.eventData);
      const errInfo = extractUpstreamError(bodyField);
      recordUpstreamError(errInfo, e.ts);
      continue;
    }

    // 所有重试失败
    if (/所有重试失败/.test(e.msg)) {
      stats.failed++;
      if (e.meta && e.meta.url) {
        const p = normalizePath(e.meta.url);
        ensurePath(p).failed++;
      }
      if (stats.errorSamples.length < 30) {
        stats.errorSamples.push({ ts: e.ts, msg: e.msg, meta: e.meta });
      }
      continue;
    }

    // 请求处理完成 → 拿 duration
    if (/请求处理完成/.test(e.msg) && e.meta && e.meta.duration) {
      const d = parseInt(String(e.meta.duration).replace(/[^\d]/g, ''), 10);
      if (!isNaN(d) && d >= 500) stats.durations.push(d);  // 过滤 <500ms 的探测请求
    }
  }

  // 衍生指标
  const completed = stats.success + stats.failed;
  stats.successRate = completed > 0 ? (stats.success / completed) : 0;
  stats.avgDurationMs = stats.durations.length > 0
    ? Math.round(stats.durations.reduce((a, b) => a + b, 0) / stats.durations.length)
    : 0;
  if (stats.durations.length > 0) {
    const sorted = [...stats.durations].sort((a, b) => a - b);
    stats.p50DurationMs = sorted[Math.floor(sorted.length * 0.5)];
    stats.p95DurationMs = sorted[Math.floor(sorted.length * 0.95)];
    stats.maxDurationMs = sorted[sorted.length - 1];
  } else {
    stats.p50DurationMs = 0;
    stats.p95DurationMs = 0;
    stats.maxDurationMs = 0;
  }
  stats.avgRetries = stats.success > 0
    ? +(stats.totalRetries / stats.success).toFixed(2)
    : 0;

  // 上游错误列表（按出现次数排序）
  stats.upstreamErrorList = Object.values(stats.upstreamErrors)
    .sort((a, b) => b.count - a.count);

  return stats;
}

/**
 * 按时间窗口（最近 N 分钟）过滤
 */
function filterByMinutes(entries, minutes) {
  if (!minutes || minutes <= 0) return entries;
  const cutoff = Date.now() - minutes * 60 * 1000;
  return entries.filter(e => {
    const t = Date.parse(e.ts);
    return !isNaN(t) && t >= cutoff;
  });
}

// ============ HTTP 服务 ============

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function handleStats(res, url) {
  const minutes = parseInt(url.searchParams.get('minutes') || '0', 10);
  const entries = readRecentLogs(5000);
  const filtered = filterByMinutes(entries, minutes);
  const stats = computeStats(filtered);
  sendJson(res, 200, stats);
}

function handleLogs(res, url) {
  const lines = parseInt(url.searchParams.get('lines') || '300', 10);
  const level = (url.searchParams.get('level') || '').toUpperCase();
  const q = (url.searchParams.get('q') || '').toLowerCase();
  let entries = readRecentLogs(Math.min(lines * 3, 5000));
  if (level) entries = entries.filter(e => e.level === level);
  if (q) entries = entries.filter(e => e.raw.toLowerCase().includes(q));
  entries = entries.slice(-lines);
  sendJson(res, 200, entries);
}

// 实时日志 SSE
function handleSSE(res, req) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  let lastSize = 0;
  try { lastSize = fs.statSync(CONFIG.logFile).size; } catch {}

  const tick = () => {
    try {
      const stat = fs.statSync(CONFIG.logFile);
      if (stat.size > lastSize) {
        const fd = fs.openSync(CONFIG.logFile, 'r');
        const len = stat.size - lastSize;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, lastSize);
        fs.closeSync(fd);
        lastSize = stat.size;
        const text = buf.toString('utf8');
        for (const raw of text.split('\n')) {
          const p = parseLine(raw);
          if (p) {
            res.write(`data: ${JSON.stringify(p)}\n\n`);
          }
        }
      } else if (stat.size < lastSize) {
        // 日志被轮转，重置
        lastSize = stat.size;
      }
    } catch {}
  };

  const timer = setInterval(tick, CONFIG.pollIntervalMs);
  req.on('close', () => clearInterval(timer));
}

function handleDashboard(res) {
  sendHtml(res, DASHBOARD_HTML);
}

// ============ 路由 ============
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${CONFIG.port}`);
  // CORS（方便本地调试）
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    return handleDashboard(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/stats') {
    return handleStats(res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/logs') {
    return handleLogs(res, url);
  }
  if (req.method === 'GET' && url.pathname === '/api/stream') {
    return handleSSE(res, req);
  }
  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, {
      status: 'ok',
      service: 'xunfei-proxy-monitor',
      logFile: CONFIG.logFile,
      logExists: fs.existsSync(CONFIG.logFile),
    });
  }
  sendJson(res, 404, { error: 'Not Found' });
});

server.listen(CONFIG.port, () => {
  console.log(`监控仪表盘已启动: http://localhost:${CONFIG.port}`);
  console.log(`日志文件: ${CONFIG.logFile}`);
});

// ============ 仪表盘 HTML ============
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=5.0">
<meta name="theme-color" content="#f5f5f5">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<title>讯飞代理监控</title>
<style>
  :root {
    --bg: #f5f5f5; --card: #fff; --border: #d9d9d9;
    --text: #333; --muted: #999;
    --accent: #1677ff; --ok: #52c41a; --warn: #faad14; --err: #ff4d4f;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --safe-top: env(safe-area-inset-top, 0px);
    --safe-bottom: env(safe-area-inset-bottom, 0px);
  }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  html { -webkit-text-size-adjust: 100%; overflow-x: hidden; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px; line-height: 1.5;
    padding-top: var(--safe-top);
    padding-bottom: var(--safe-bottom);
    overflow-x: hidden;
  }

  header {
    position: sticky; top: 0; z-index: 20;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: #fff;
  }
  .header-row {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  header h1 { margin: 0; font-size: 15px; font-weight: 600; white-space: nowrap; }
  header .meta {
    color: var(--muted); font-size: 11px; font-family: var(--mono);
    margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .header-right { display: flex; align-items: center; gap: 6px; flex-shrink: 0; }
  select, button, input { font-family: inherit; }
  select {
    background: #fff; color: var(--text); border: 1px solid var(--border);
    padding: 6px 8px; border-radius: 4px; font-size: 13px; cursor: pointer;
    max-width: 120px;
  }
  .btn-icon {
    background: #fff; color: var(--text); border: 1px solid var(--border);
    width: 30px; height: 30px; border-radius: 4px; font-size: 15px;
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .spinner {
    width: 6px; height: 6px; border-radius: 50%; background: var(--ok);
    display: inline-block; flex-shrink: 0;
  }

  main { padding: 12px; max-width: 1200px; margin: 0 auto; }

  .grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
  .card {
    min-width: 0;
    background: var(--card); border: 1px solid var(--border); border-radius: 4px;
    padding: 10px 12px;
  }
  .card .label { color: var(--muted); font-size: 12px; margin-bottom: 2px; }
  .card .value { font-size: 20px; font-weight: 600; font-family: var(--mono); line-height: 1.3; }
  .card .sub { color: var(--muted); font-size: 11px; margin-top: 2px; word-break: break-word; }
  .card.ok .value { color: var(--ok); }
  .card.err .value { color: var(--err); }
  .card.warn .value { color: var(--warn); }
  .big-rate { grid-column: span 2; }
  .big-rate .value { font-size: 28px; }

  section { margin-top: 16px; }
  section h2 {
    font-size: 13px; font-weight: 600; margin: 0 0 8px;
    color: var(--text); display: flex; align-items: center; gap: 8px;
  }
  .badge {
    display: inline-block; padding: 1px 6px; border-radius: 2px;
    font-size: 11px; font-family: var(--mono); background: #f0f0f0; color: var(--muted);
  }

  .table-wrap { overflow-x: auto; -webkit-overflow-scrolling: touch; }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); font-size: 13px; white-space: nowrap; }
  th { color: var(--muted); font-weight: 400; font-size: 12px; }
  td.num { font-family: var(--mono); text-align: right; }
  td.path { font-family: var(--mono); font-size: 12px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; }
  .bar { height: 4px; background: #e8e8e8; border-radius: 2px; overflow: hidden; min-width: 40px; }
  .bar > div { height: 100%; background: var(--accent); border-radius: 2px; }

  .scroll-card { max-height: 240px; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  #errors { font-family: var(--mono); font-size: 12px; color: var(--err); line-height: 1.5; word-break: break-all; }

  .log-controls { display: flex; flex-direction: column; gap: 8px; margin-bottom: 8px; }
  .toggle { display: flex; gap: 4px; flex-wrap: wrap; }
  .toggle button {
    background: #fff; color: var(--text); border: 1px solid var(--border);
    padding: 4px 10px; border-radius: 2px; font-size: 12px; cursor: pointer;
  }
  .toggle button.active { background: var(--accent); color: #fff; border-color: var(--accent); }
  .log-controls-bottom { display: flex; gap: 8px; align-items: center; }
  #search {
    background: #fff; color: var(--text); border: 1px solid var(--border);
    padding: 6px 10px; border-radius: 4px; font-size: 13px; flex: 1; min-width: 0;
  }
  #search::placeholder { color: var(--muted); }
  .checkbox-label { color: var(--muted); font-size: 12px; display: flex; align-items: center; gap: 4px; white-space: nowrap; }

  #logBox {
    min-width: 0;
    background: #fafafa; border: 1px solid var(--border); border-radius: 4px;
    padding: 8px; height: 55vh; max-height: 500px; min-height: 240px;
    overflow-y: auto; -webkit-overflow-scrolling: touch;
    font-family: var(--mono); font-size: 12px; line-height: 1.6;
  }
  .log-line { white-space: pre-wrap; word-break: break-all; padding: 1px 0; }
  .log-line .lv { display: inline-block; min-width: 38px; font-weight: 600; }
  .lv-INFO { color: var(--accent); }
  .lv-WARN { color: var(--warn); }
  .lv-ERROR { color: var(--err); }
  .lv-DEBUG { color: var(--muted); }
  .log-line .ts { color: var(--muted); margin-right: 4px; font-size: 11px; }
  .log-line .meta-inline { color: #bbb; font-size: 11px; }

  @media (min-width: 640px) {
    main { padding: 16px 20px 40px; }
    header { padding: 10px 20px; }
    header h1 { font-size: 16px; }
    .grid { grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; }
    .card { padding: 12px 16px; }
    .card .value { font-size: 24px; }
    .big-rate .value { font-size: 32px; }
    .log-controls { flex-direction: row; flex-wrap: wrap; align-items: center; }
    .log-controls-bottom { flex: 1; }
    #logBox { font-size: 12px; height: 420px; }
  }
  @media (min-width: 900px) {
    .grid { grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); }
  }
</style>
</head>
<body>
<header>
  <div class="header-row">
    <div style="min-width:0;flex:1">
      <h1>讯飞代理监控</h1>
      <div class="meta" id="winInfo">—</div>
    </div>
    <div class="header-right">
      <select id="windowSel">
        <option value="0">全部</option>
        <option value="5">5分钟</option>
        <option value="15" selected>15分钟</option>
        <option value="60">1小时</option>
        <option value="360">6小时</option>
        <option value="1440">24小时</option>
      </select>
      <button class="btn-icon" id="refreshBtn" aria-label="刷新">↻</button>
      <span class="spinner" title="实时"></span>
    </div>
  </div>
</header>

<main>
  <div class="grid" id="kpi">
    <div class="card big-rate ok">
      <div class="label">成功率</div>
      <div class="value" id="rate">—</div>
      <div class="sub" id="rateSub">成功 / 完成</div>
    </div>
    <div class="card">
      <div class="label">请求总数</div>
      <div class="value" id="total">—</div>
      <div class="sub" id="totalSub">收到请求数</div>
    </div>
    <div class="card ok">
      <div class="label">成功</div>
      <div class="value" id="success">—</div>
      <div class="sub" id="successSub">含重试后成功</div>
    </div>
    <div class="card err">
      <div class="label">失败</div>
      <div class="value" id="failed">—</div>
      <div class="sub" id="failedSub">重试耗尽</div>
    </div>
    <div class="card warn">
      <div class="label">重试总次</div>
      <div class="value" id="retries">—</div>
      <div class="sub" id="retriesSub">总计 / 平均</div>
    </div>
    <div class="card">
      <div class="label">中位数耗时</div>
      <div class="value" id="avgDur">—</div>
      <div class="sub" id="durSub">P50 / P95 / Max</div>
    </div>
  </div>

  <section>
    <h2>按路径分布 <span class="badge" id="pathCount">0</span></h2>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>路径</th><th class="num">总数</th><th class="num">成功</th><th class="num">失败</th><th class="num">成功率</th></tr></thead>
          <tbody id="pathTable"></tbody>
        </table>
      </div>
    </div>
  </section>

  <section>
    <h2>重试次数分布</h2>
    <div class="card">
      <div class="table-wrap">
        <table>
          <thead><tr><th>重试区间</th><th class="num">请求数</th><th>占比</th></tr></thead>
          <tbody id="retryTable"></tbody>
        </table>
      </div>
    </div>
  </section>

  <section>
    <h2>上游状态码</h2>
      <div class="card" id="statusCard" style="display:flex;flex-wrap:wrap;gap:8px">
        <span style="color:var(--muted)">—</span>
      </div>
    </section>
    <section>
      <h2>原平台报错统计 <span class="badge" id="upErrCount">0</span></h2>
    <div class="card" id="upErrCard" style="padding:0">
      <div id="upErrTable"></div>
    </div>
  </section>

  <section>
    <h2>失败样本</h2>
    <div class="card scroll-card">
      <div id="errors">—</div>
    </div>
  </section>

  <section>
    <h2>实时日志 <span class="badge" id="liveBadge">LIVE</span></h2>
    <div class="log-controls">
      <div class="toggle" id="levelToggle">
        <button data-lv="">全部</button>
        <button data-lv="INFO">INFO</button>
        <button data-lv="WARN">WARN</button>
        <button data-lv="ERROR">ERROR</button>
      </div>
      <div class="log-controls-bottom">
        <input id="search" placeholder="搜索关键字…" autocomplete="off">
        <label class="checkbox-label">
          <input type="checkbox" id="autoscroll" checked> 置顶新日志
        </label>
      </div>
    </div>
    <div id="logBox"></div>
  </section>
</main>

<script>
const $ = id => document.getElementById(id);
let curLevel = '';
let curSearch = '';
const MAX_LOG_LINES = 400;
const logBuf = [];

async function fetchStats() {
  try {
    const minutes = $('windowSel').value;
    const r = await fetch('/api/stats?minutes=' + minutes);
    const s = await r.json();
    $('rate').textContent = (s.successRate * 100).toFixed(1) + '%';
    $('rateSub').textContent = s.success + ' / ' + (s.success + s.failed) + ' 完成';
    $('total').textContent = s.total;
    const unaccounted = Math.max(0, s.total - s.success - s.failed);
    $('totalSub').textContent = unaccounted > 0 ? '收到请求数 · ' + unaccounted + ' 个进行中/未归类' : '收到请求数';
    $('success').textContent = s.success;
    $('successSub').textContent = '含重试后成功';
    $('failed').textContent = s.failed;
    $('failedSub').textContent = '重试耗尽';
    $('retries').textContent = s.totalRetries;
    $('retriesSub').textContent = '平均 ' + s.avgRetries + ' 次/成功请求';
    $('avgDur').textContent = s.p50DurationMs + 'ms';
    $('durSub').textContent = 'P95 ' + s.p95DurationMs + 'ms · Max ' + s.maxDurationMs + 'ms · n=' + s.durations.length;
    $('winInfo').textContent = toBJT(s.windowStart) + ' → ' + toBJT(s.windowEnd);

    const paths = Object.entries(s.byPath).sort((a,b) => b[1].total - a[1].total);
    $('pathCount').textContent = paths.length + ' 条';
    $('pathTable').innerHTML = paths.map(([p, d]) => {
      const done = d.success + d.failed;
      const rate = done > 0 ? (d.success / done * 100).toFixed(1) + '%' : '—';
      return '<tr><td class="path" title="' + esc(p) + '">' + esc(p) + '</td>'
        + '<td class="num">' + d.total + '</td>'
        + '<td class="num" style="color:var(--ok)">' + d.success + '</td>'
        + '<td class="num" style="color:var(--err)">' + d.failed + '</td>'
        + '<td class="num">' + rate + '</td></tr>';
    }).join('') || '<tr><td colspan="5" style="color:var(--muted)">—</td></tr>';

    const totalHist = Object.values(s.retryHistogram).reduce((a,b)=>a+b,0) || 1;
    $('retryTable').innerHTML = Object.entries(s.retryHistogram).map(([k, v]) => {
      const pct = (v / totalHist * 100).toFixed(1);
      return '<tr><td>重试 ' + k + ' 次</td><td class="num">' + v + '</td>'
        + '<td><div style="display:flex;align-items:center;gap:6px"><div class="bar"><div style="width:' + pct + '%"></div></div><span style="color:var(--muted);font-size:11px">' + pct + '%</span></div></td></tr>';
    }).join('');

    const codes = Object.entries(s.byHttpStatus).sort((a,b) => b[1]-a[1]);
    $('statusCard').innerHTML = codes.length ? codes.map(([code, n]) => {
      const color = code == 200 ? 'var(--ok)' : (code >= 500 ? 'var(--err)' : 'var(--warn)');
      const total = codes.reduce((a,[,c])=>a+c,0);
      const pct = (n / total * 100).toFixed(0);
      return '<div style="display:flex;flex-direction:column;align-items:center;min-width:64px;padding:8px 6px;border-radius:8px;background:#f5f5f5;border:1px solid var(--border)">'
        + '<span style="color:'+color+';font-weight:700;font-family:var(--mono);font-size:16px">'+esc(code)+'</span>'
        + '<span style="font-family:var(--mono);font-size:12px;color:var(--text);margin-top:2px">'+n+'</span>'
        + '<span style="font-size:9px;color:var(--muted)">'+pct+'%</span>'
        + '</div>';
    }).join('') : '<span style="color:var(--muted)">—</span>';

    $('errors').innerHTML = s.errorSamples.length
      ? s.errorSamples.map(e => '<div>[' + toBJT(e.ts) + '] ' + esc(e.msg) + (e.meta && e.meta.url ? '<br>↳ ' + esc(e.meta.url) : '') + '</div>').join('<hr style="border-color:var(--border);margin:6px 0">')
      : '<span style="color:var(--ok)">无失败记录 🎉</span>';

    // 原平台报错统计（卡片式，移动端友好）
    const upErrs = s.upstreamErrorList || [];
    $('upErrCount').textContent = upErrs.length + ' 种 / ' + upErrs.reduce((a,b)=>a+b.count,0) + ' 次';
    $('upErrTable').innerHTML = upErrs.length ? upErrs.map(e => {
      const codeColor = e.code === '200' ? 'var(--ok)' : (parseInt(e.code) >= 500 || parseInt(e.code) >= 10000 ? 'var(--err)' : 'var(--warn)');
      return '<div style="padding:10px 12px;border-bottom:1px solid var(--border);min-width:0">'
        + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">'
        + '<span style="color:'+codeColor+';font-weight:700;font-family:var(--mono);font-size:13px">'+esc(e.code)+'</span>'
        + '<span style="color:var(--muted);font-size:10px;background:#f0f0f0;padding:1px 6px;border-radius:999px">'+esc(e.type||'—')+'</span>'
        + '<span style="margin-left:auto;font-family:var(--mono);font-size:13px;font-weight:600">'+e.count+' 次</span>'
        + '</div>'
        + '<div style="font-size:11px;color:var(--muted);word-break:break-all;line-height:1.4">'+esc(e.message||'—')+'</div>'
        + '</div>';
    }).join('') : '<div style="padding:16px;color:var(--muted);text-align:center">无报错 🎉</div>';
  } catch (e) { console.error(e); }
}

function esc(s) { return String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

// ISO UTC 时间 -> 北京时间显示 (YYYY-MM-DD HH:mm:ss)
function toBJT(iso) {
  if (!iso) return '—';
  const t = new Date(iso);
  if (isNaN(t)) return iso; // 不是合法日期则原样返回
  // 用 Asia/Shanghai 时区格式化
  const s = t.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  // toLocaleString 在 zh-CN 下格式: 2026/07/05 22:16:18，统一改为 -
  return s.split("/").join("-");
}

// ISO UTC 时间 -> 北京时间短格式 (HH:mm:ss)
function toBJTShort(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (isNaN(t)) return String(iso).substr(11, 8);
  return t.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
}

// 批量渲染：用 rAF 合并高频 SSE 日志，避免每条都全量 innerHTML
let pendingLogs = [];
let rafScheduled = false;

function appendLog(e) {
  logBuf.push(e);
  if (logBuf.length > MAX_LOG_LINES) {
    logBuf.splice(0, logBuf.length - MAX_LOG_LINES);
  }
  pendingLogs.push(e);
  scheduleRender();
}

function scheduleRender() {
  if (rafScheduled) return;
  rafScheduled = true;
  requestAnimationFrame(() => {
    rafScheduled = false;
    flushLogs();
  });
}

// 倒序显示：最新日志在最上面，无需滚动即可看到
function flushLogs() {
  const box = $('logBox');
  if (!box) return;
  // 倒序模式：用户在顶部看最新日志。"在顶部"才需要保持滚动到顶
  const atTop = box.scrollTop <= 30;

  // 如果有过滤条件或积压太多，退化为全量重建
  if (curLevel || curSearch || pendingLogs.length > 50) {
    renderLogsFull();
    pendingLogs = [];
    if (atTop && $('autoscroll').checked) box.scrollTop = 0;
    return;
  }

  // 增量插入到顶部（倒序：pendingLogs 按时间正序，插入时反转）
  const frag = document.createDocumentFragment();
  for (let i = pendingLogs.length - 1; i >= 0; i--) {
    const e = pendingLogs[i];
    const div = document.createElement('div');
    div.className = 'log-line';
    div.innerHTML = '<span class="ts">' + toBJTShort(e.ts) + '</span>'
      + '<span class="lv lv-' + esc(e.level) + '">' + esc(e.level) + '</span> '
      + esc(e.msg) + (e.meta ? ' <span class="meta-inline">' + esc(JSON.stringify(e.meta).slice(0, 300)) + '</span>' : '');
    frag.appendChild(div);
  }
  // 插到最前面
  box.insertBefore(frag, box.firstChild);

  // 超出上限移除尾部旧节点
  while (box.childNodes.length > MAX_LOG_LINES) {
    box.removeChild(box.lastChild);
  }

  pendingLogs = [];
  // 勾选自动滚动时，新日志进来后保持在顶部
  if (atTop && $('autoscroll').checked) box.scrollTop = 0;
}

function renderLogs() {
  renderLogsFull();
}

function renderLogsFull() {
  let items = logBuf;
  if (curLevel) items = items.filter(e => e.level === curLevel);
  if (curSearch) items = items.filter(e => e.raw.toLowerCase().includes(curSearch));
  const box = $('logBox');
  // 倒序：最新（数组末尾）排在最上面
  const arr = items.slice(-MAX_LOG_LINES).reverse();
  box.innerHTML = arr.map(e =>
    '<div class="log-line"><span class="ts">' + toBJTShort(e.ts) + '</span>'
    + '<span class="lv lv-' + esc(e.level) + '">' + esc(e.level) + '</span> '
    + esc(e.msg) + (e.meta ? ' <span class="meta-inline">' + esc(JSON.stringify(e.meta).slice(0, 300)) + '</span>' : '')
    + '</div>'
  ).join('');
}

async function loadHistory() {
  try {
    const r = await fetch('/api/logs?lines=200');
    const arr = await r.json();
    logBuf.length = 0;
    // 批量插入，只触发一次渲染
    for (const e of arr) logBuf.push(e);
    if (logBuf.length > MAX_LOG_LINES) logBuf.splice(0, logBuf.length - MAX_LOG_LINES);
    pendingLogs = [...logBuf];
    // 首次加载走全量重建（确保过滤生效）
    renderLogsFull();
    pendingLogs = [];
  } catch (e) { console.error(e); }
}

function connectSSE() {
  try {
    const es = new EventSource('/api/stream');
    es.onmessage = ev => {
      try { appendLog(JSON.parse(ev.data)); } catch {}
    };
    es.onopen = () => { $('liveBadge').textContent = 'LIVE'; $('liveBadge').style.background = '#22c55e'; };
    es.onerror = () => { $('liveBadge').textContent = '断开'; $('liveBadge').style.background = 'var(--err)'; };
  } catch (e) { console.error(e); }
}

// 事件绑定(用 touch 友好的 click)
$('windowSel').addEventListener('change', fetchStats);
$('refreshBtn').addEventListener('click', fetchStats);
$('levelToggle').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  curLevel = b.dataset.lv;
  $('levelToggle').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
  renderLogs();
});
$('search').addEventListener('input', e => { curSearch = e.target.value.toLowerCase(); renderLogs(); });
document.querySelector('#levelToggle button[data-lv=""]').classList.add('active');

// 下拉刷新手势(移动端):页面顶部下拉时刷新
let touchStartY = 0, pullDistance = 0;
document.addEventListener('touchstart', e => { touchStartY = e.touches[0].clientY; }, { passive: true });
document.addEventListener('touchmove', e => {
  if (window.scrollY === 0 && e.touches[0].clientY > touchStartY) {
    pullDistance = e.touches[0].clientY - touchStartY;
  }
}, { passive: true });
document.addEventListener('touchend', () => {
  if (pullDistance > 80) { fetchStats(); loadHistory(); }
  pullDistance = 0;
}, { passive: true });

// 初始化
loadHistory().then(connectSSE);
fetchStats();
setInterval(fetchStats, 15000);
</script>
</body>
</html>`;
