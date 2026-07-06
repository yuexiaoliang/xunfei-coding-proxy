/**
 * 讯飞 Coding Plan 代理 - 监控仪表盘
 *
 * 独立 Web 服务，读取 proxy 的日志文件，展示：
 * - 成功率 / 请求数 / 失败数
 * - 重试次数分布
 * - 响应时长
 * - 实时日志流
 *
 * HTTP 层用 express，图表用 Chart.js（CDN），日志解析/统计为业务逻辑。
 *
 * 启动：
 *   node monitor.js
 *   MONITOR_PORT=9092 node monitor.js
 *   MONITOR_LOG=/path/to/out.log node monitor.js
 */

const express = require('express');
const fs = require('fs');
const path = require('path');

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
    byPath: {},         // 按路径统计（= 上游接口路径）
    byModel: {},        // 按模型统计
    byHttpStatus: {},   // 按上游 HTTP 状态码统计
    upstreamErrors: {}, // 按讯飞错误码统计 { code: { count, message, type, lastTs } }
    upstreamErrorList: [], // 错误码列表（前端表格用）
    errorSamples: [],   // 失败样本（最终失败）
    retryHistogram: {   // 重试次数直方图
      '0': 0, '1-3': 0, '4-10': 0, '11-30': 0, '31+': 0,
    },
    hourlyBuckets: {},  // { 'YYYY-MM-DD HH:00': { success, failed, retries } }
    windowStart: null,
    windowEnd: null,
  };

  // 滚动小时桶：用相对于"当前整点"的偏移量做 key
  // 例如当前 09:xx，offset=0 是 09:00-10:00 的桶，offset=-1 是 08:00-09:00
  function hourOffset(iso) {
    const t = new Date(iso);
    if (isNaN(t)) return null;
    const now = new Date();
    // 对齐到当前整点
    const curHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
    const diff = t.getTime() - curHour.getTime();
    return Math.floor(diff / (3600 * 1000));
  }
  function ensureHour(offset) {
    if (!stats.hourlyBuckets[offset]) stats.hourlyBuckets[offset] = { upstreamSuccess: 0, upstreamFail: 0 };
    return stats.hourlyBuckets[offset];
  }

  function ensurePath(p) {
    if (!stats.byPath[p]) stats.byPath[p] = { total: 0, success: 0, failed: 0 };
    return stats.byPath[p];
  }

  function ensureModel(m) {
    const key = m || '(未知)';
    if (!stats.byModel[key]) stats.byModel[key] = { total: 0, success: 0, failed: 0, retries: 0, retried: 0, totalRetries: 0, durations: [] };
    return stats.byModel[key];
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
      const model = e.meta && e.meta.model;
      ensureModel(model).total++;
      continue;
    }

    // 请求成功（流式/非流式）
    const okMatch = e.msg.match(/^(流式|非流式)请求成功\s*\(重试\s+(\d+)\s*次/);
    if (okMatch) {
      stats.success++;
      const hk = hourOffset(e.ts);
      if (hk) ensureHour(hk).upstreamSuccess++;
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
      // 按模型统计
      const okModel = e.meta && e.meta.model;
      const mb = ensureModel(okModel);
      mb.success++;
      if (retries > 0) mb.retried++;
      mb.totalRetries += retries;
      continue;
    }

    // 上游可重试错误（流式/非流式收到可重试状态码、非SSE可重试响应、缓冲阶段错误）
    const retryErrMatch = e.msg.match(/(流式请求收到可重试状态码|非流式请求遇到可重试错误|流式请求收到非 SSE 可重试响应|缓冲阶段检测到可重试错误)/);
    if (retryErrMatch) {
      stats.totalRetries++;
      const hk2 = hourOffset(e.ts);
      if (hk2) ensureHour(hk2).upstreamFail++;
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
      // 按模型统计重试
      const retryModel = e.meta && e.meta.model;
      ensureModel(retryModel).totalRetries++;
      continue;
    }

    // 所有重试失败
    if (/所有重试失败/.test(e.msg)) {
      stats.failed++;
      // 重试耗尽不算上游失败（上游的每次可重试响应已在 upstreamFail 里计过了）
      if (e.meta && e.meta.url) {
        const p = normalizePath(e.meta.url);
        ensurePath(p).failed++;
      }
      // 按模型统计失败
      const failModel = e.meta && e.meta.model;
      ensureModel(failModel).failed++;
      if (stats.errorSamples.length < 30) {
        stats.errorSamples.push({ ts: e.ts, msg: e.msg, meta: e.meta });
      }
      continue;
    }

    // 请求处理完成 → 拿 duration
    if (/请求处理完成/.test(e.msg) && e.meta && e.meta.duration) {
      const d = parseInt(String(e.meta.duration).replace(/[^\d]/g, ''), 10);
      if (!isNaN(d) && d >= 500) {
        stats.durations.push(d);  // 过滤 <500ms 的探测请求
        const doneModel = e.meta && e.meta.model;
        if (doneModel) ensureModel(doneModel).durations.push(d);
      }
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

  // 按模型列表（按请求总数排序），计算衍生指标
  stats.byModelList = Object.entries(stats.byModel).map(([model, d]) => {
    const done = d.success + d.failed;
    const sr = done > 0 ? +(d.success / done * 100).toFixed(1) : 0;
    const avg = d.durations.length > 0
      ? Math.round(d.durations.reduce((a, b) => a + b, 0) / d.durations.length)
      : 0;
    const p50 = d.durations.length > 0
      ? [...d.durations].sort((a, b) => a - b)[Math.floor(d.durations.length * 0.5)]
      : 0;
    const avgRetries = d.success > 0 ? +(d.totalRetries / d.success).toFixed(2) : 0;
    return { model, total: d.total, success: d.success, failed: d.failed,
             retries: d.totalRetries, retried: d.retried,
             successRate: sr, avgDurationMs: avg, p50DurationMs: p50, avgRetries };
  }).sort((a, b) => b.total - a.total);

  // 上游错误列表（按出现次数排序）
  stats.upstreamErrorList = Object.values(stats.upstreamErrors)
    .sort((a, b) => b.count - a.count);

  // 每小时上游成功率列表：按 offset 从小到大（最旧→最新）
  stats.hourlyList = Object.entries(stats.hourlyBuckets)
    .map(([offsetStr, d]) => {
      const offset = parseInt(offsetStr, 10);
      const now = new Date();
      const curHour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
      const t = new Date(curHour.getTime() + offset * 3600 * 1000);
      const bj = new Date(t.getTime() + 8 * 3600 * 1000);
      const label = String(bj.getUTCHours()).padStart(2, '0') + ':00';
      const dateLabel = bj.getUTCMonth() + 1 + '/' + bj.getUTCDate();
      // 上游成功率 = 上游成功 / (上游成功 + 上游失败)
      const upTotal = d.upstreamSuccess + d.upstreamFail;
      return {
        offset,
        label,
        dateLabel,
        success: d.upstreamSuccess,
        fail: d.upstreamFail,
        rate: upTotal > 0 ? +(d.upstreamSuccess / upTotal * 100).toFixed(1) : 100,
      };
    })
    .sort((a, b) => a.offset - b.offset);

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

// ============ HTTP 服务（express） ============

const app = express();

// CORS（方便本地调试）
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// 统计接口
app.get('/api/stats', (req, res) => {
  const minutes = parseInt(req.query.minutes || '0', 10);
  const entries = readRecentLogs(5000);
  const filtered = filterByMinutes(entries, minutes);
  const stats = computeStats(filtered);
  res.set('Cache-Control', 'no-store');
  res.json(stats);
});

// 历史日志接口
app.get('/api/logs', (req, res) => {
  const lines = parseInt(req.query.lines || '300', 10);
  const level = (req.query.level || '').toUpperCase();
  const q = (req.query.q || '').toLowerCase();
  let entries = readRecentLogs(Math.min(lines * 3, 5000));
  if (level) entries = entries.filter(e => e.level === level);
  if (q) entries = entries.filter(e => e.raw.toLowerCase().includes(q));
  entries = entries.slice(-lines);
  res.set('Cache-Control', 'no-store');
  res.json(entries);
});

// 实时日志 SSE
app.get('/api/stream', (req, res) => {
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
});

// 仪表盘页面
app.get(['/', '/index.html'], (req, res) => {
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(DASHBOARD_HTML);
});

// 健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'xunfei-proxy-monitor',
    logFile: CONFIG.logFile,
    logExists: fs.existsSync(CONFIG.logFile),
  });
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

const server = app.listen(CONFIG.port, () => {
  console.log(`监控仪表盘已启动: http://localhost:${CONFIG.port}`);
  console.log(`日志文件: ${CONFIG.logFile}`);
});

// ============ 仪表盘 HTML ============

// ============ 仪表盘 HTML（Vue 3 + Element Plus） ============
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, maximum-scale=5.0">
<meta name="theme-color" content="#f5f5f5">
<title>讯飞代理监控</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/element-plus@2/dist/index.css">
<style>
  :root {
    --ep-color-primary: #1677ff;
  }
  html { -webkit-text-size-adjust: 100%; overflow-x: hidden; }
  body {
    margin: 0; background: #f5f5f5; color: #333;
    font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 14px; line-height: 1.5;
    -webkit-tap-highlight-color: transparent;
  }
  .mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
  .kpi-value { font-size: 20px; font-weight: 600; font-family: ui-monospace, Menlo, Consolas, monospace; line-height: 1.3; }
  .kpi-label { color: #999; font-size: 12px; margin-bottom: 2px; }
  .kpi-sub { color: #999; font-size: 11px; margin-top: 2px; word-break: break-word; }
  .ok-color { color: #52c41a; }
  .err-color { color: #ff4d4f; }
  .warn-color { color: #faad14; }
  .big-rate .kpi-value { font-size: 28px; }
  .log-box {
    background: #fafafa; border: 1px solid #d9d9d9; border-radius: 4px;
    padding: 8px; height: 55vh; max-height: 500px; min-height: 240px;
    overflow-y: auto; -webkit-overflow-scrolling: touch;
    font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    font-size: 12px; line-height: 1.6;
  }
  .log-line { white-space: pre-wrap; word-break: break-all; padding: 1px 0; }
  .log-line .lv { display: inline-block; min-width: 38px; font-weight: 600; }
  .lv-INFO { color: #1677ff; }
  .lv-WARN { color: #faad14; }
  .lv-ERROR { color: #ff4d4f; }
  .lv-DEBUG { color: #999; }
  .log-line .ts { color: #999; margin-right: 4px; font-size: 11px; }
  .log-line .meta-inline { color: #bbb; font-size: 11px; }
  .status-chip { display: inline-flex; flex-direction: column; align-items: center; min-width: 64px; padding: 8px 6px; border-radius: 8px; background: #f5f5f5; border: 1px solid #d9d9d9; }
  .bar { height: 4px; background: #e8e8e8; border-radius: 2px; overflow: hidden; min-width: 40px; }
  .bar > div { height: 100%; background: #1677ff; border-radius: 2px; }
  @media (min-width: 640px) {
    .kpi-value { font-size: 24px; }
    .big-rate .kpi-value { font-size: 32px; }
    .log-box { font-size: 12px; height: 420px; }
  }
  [v-cloak] { display: none; }
</style>
</head>
<body>
<div id="app" v-cloak>
  <el-config-provider>
    <el-header style="position:sticky;top:0;z-index:20;padding:8px 12px;border-bottom:1px solid #d9d9d9;background:#fff;line-height:normal;height:auto">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:8px">
        <div style="min-width:0;flex:1">
          <div style="font-size:15px;font-weight:600;white-space:nowrap">讯飞代理监控</div>
          <div class="mono" style="color:#999;font-size:11px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ winInfo }}</div>
        </div>
        <div style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          <el-select v-model="minutes" size="small" style="width:110px" @change="fetchStats">
            <el-option label="全部" :value="0"></el-option>
            <el-option label="5分钟" :value="5"></el-option>
            <el-option label="15分钟" :value="15"></el-option>
            <el-option label="1小时" :value="60"></el-option>
            <el-option label="6小时" :value="360"></el-option>
            <el-option label="24小时" :value="1440"></el-option>
          </el-select>
          <el-button size="small" circle @click="fetchStats">↻</el-button>
          <span style="width:6px;height:6px;border-radius:50%;background:#52c41a;display:inline-block;flex-shrink:0"></span>
        </div>
      </div>
    </el-header>

    <main style="padding:12px;max-width:1200px;margin:0 auto">
      <!-- KPI -->
      <el-row :gutter="8">
        <el-col :xs="24" :sm="12" :md="8" class="big-rate">
          <el-card shadow="never" style="margin-bottom:8px">
            <div class="kpi-label">成功率</div>
            <div class="kpi-value ok-color">{{ (stats.successRate * 100).toFixed(1) }}%</div>
            <div class="kpi-sub">{{ stats.success }} / {{ stats.success + stats.failed }} 完成</div>
          </el-card>
        </el-col>
        <el-col :xs="12" :sm="6" :md="4">
          <el-card shadow="never" style="margin-bottom:8px">
            <div class="kpi-label">请求总数</div>
            <div class="kpi-value">{{ stats.total }}</div>
            <div class="kpi-sub">{{ unaccounted > 0 ? '收到请求数 · ' + unaccounted + ' 个进行中' : '收到请求数' }}</div>
          </el-card>
        </el-col>
        <el-col :xs="12" :sm="6" :md="4">
          <el-card shadow="never" style="margin-bottom:8px">
            <div class="kpi-label">成功</div>
            <div class="kpi-value ok-color">{{ stats.success }}</div>
            <div class="kpi-sub">含重试后成功</div>
          </el-card>
        </el-col>
        <el-col :xs="12" :sm="6" :md="4">
          <el-card shadow="never" style="margin-bottom:8px">
            <div class="kpi-label">失败</div>
            <div class="kpi-value err-color">{{ stats.failed }}</div>
            <div class="kpi-sub">重试耗尽</div>
          </el-card>
        </el-col>
        <el-col :xs="12" :sm="6" :md="4">
          <el-card shadow="never" style="margin-bottom:8px">
            <div class="kpi-label">重试总次</div>
            <div class="kpi-value warn-color">{{ stats.totalRetries }}</div>
            <div class="kpi-sub">平均 {{ stats.avgRetries }} 次/成功请求</div>
          </el-card>
        </el-col>
        <el-col :xs="24" :sm="12" :md="8">
          <el-card shadow="never" style="margin-bottom:8px">
            <div class="kpi-label">中位数耗时</div>
            <div class="kpi-value">{{ stats.p50DurationMs }}ms</div>
            <div class="kpi-sub">P95 {{ stats.p95DurationMs }}ms · Max {{ stats.maxDurationMs }}ms · n={{ stats.durations ? stats.durations.length : 0 }}</div>
          </el-card>
        </el-col>
      </el-row>

      <!-- 按模型分布 -->
      <section style="margin-top:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px">
          按模型分布 <el-tag size="small" type="info">{{ (stats.byModelList||[]).length }} 种 / {{ modelTotal }} 次</el-tag>
        </div>
        <el-card shadow="never">
          <el-table :data="stats.byModelList || []" size="small" style="width:100%" :scrollable="true">
            <el-table-column prop="model" label="模型" min-width="120" show-overflow-tooltip></el-table-column>
            <el-table-column prop="total" label="总数" width="70" align="right"></el-table-column>
            <el-table-column label="成功" width="60" align="right">
              <template #default="{ row }"><span class="ok-color">{{ row.success }}</span></template>
            </el-table-column>
            <el-table-column label="失败" width="60" align="right">
              <template #default="{ row }"><span class="err-color">{{ row.failed }}</span></template>
            </el-table-column>
            <el-table-column label="重试" width="60" align="right">
              <template #default="{ row }"><span class="warn-color">{{ row.retries }}</span></template>
            </el-table-column>
            <el-table-column label="成功率" width="70" align="right">
              <template #default="{ row }"><span :style="{color: row.successRate >= 95 ? '#52c41a' : (row.successRate >= 80 ? '#faad14' : '#ff4d4f'), fontWeight: 600}">{{ row.successRate }}%</span></template>
            </el-table-column>
            <el-table-column label="P50耗时" width="80" align="right">
              <template #default="{ row }">{{ row.p50DurationMs || '—' }}ms</template>
            </el-table-column>
            <el-table-column prop="avgRetries" label="平均重试" width="70" align="right"></el-table-column>
          </el-table>
        </el-card>
      </section>

      <!-- 按路径分布 -->
      <section style="margin-top:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px">
          按路径分布 <el-tag size="small" type="info">{{ pathList.length }} 条</el-tag>
        </div>
        <el-card shadow="never">
          <el-table :data="pathList" size="small" style="width:100%">
            <el-table-column label="路径" min-width="180" show-overflow-tooltip>
              <template #default="{ row }"><span class="mono" style="font-size:12px">{{ row.path }}</span></template>
            </el-table-column>
            <el-table-column prop="total" label="总数" width="70" align="right"></el-table-column>
            <el-table-column label="成功" width="60" align="right">
              <template #default="{ row }"><span class="ok-color">{{ row.success }}</span></template>
            </el-table-column>
            <el-table-column label="失败" width="60" align="right">
              <template #default="{ row }"><span class="err-color">{{ row.failed }}</span></template>
            </el-table-column>
            <el-table-column label="成功率" width="70" align="right">
              <template #default="{ row }">{{ row.successRate }}</template>
            </el-table-column>
          </el-table>
        </el-card>
      </section>

      <!-- 重试次数分布 -->
      <section style="margin-top:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">重试次数分布</div>
        <el-card shadow="never">
          <el-table :data="retryList" size="small" style="width:100%">
            <el-table-column prop="range" label="重试区间"></el-table-column>
            <el-table-column prop="count" label="请求数" width="80" align="right"></el-table-column>
            <el-table-column label="占比" min-width="120">
              <template #default="{ row }">
                <div style="display:flex;align-items:center;gap:6px">
                  <div class="bar"><div :style="{width: row.pct + '%'}"></div></div>
                  <span style="color:#999;font-size:11px">{{ row.pct }}%</span>
                </div>
              </template>
            </el-table-column>
          </el-table>
        </el-card>
      </section>

      <!-- 每小时上游成功率 -->
      <section style="margin-top:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">每小时上游接口成功率</div>
        <el-card shadow="never" style="padding:12px">
          <div style="position:relative;height:200px">
            <canvas ref="hourlyChartRef"></canvas>
          </div>
        </el-card>
      </section>

      <!-- 上游状态码 -->
      <section style="margin-top:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">上游状态码</div>
        <el-card shadow="never">
          <div v-if="statusList.length" style="display:flex;flex-wrap:wrap;gap:8px">
            <div v-for="item in statusList" :key="item.code" class="status-chip">
              <span :style="{color: item.code == 200 ? '#52c41a' : (item.code >= 500 ? '#ff4d4f' : '#faad14'), fontWeight: 700, fontFamily: 'ui-monospace,monospace', fontSize: '16px'}">{{ item.code }}</span>
              <span class="mono" style="font-size:12px;margin-top:2px">{{ item.count }}</span>
              <span style="font-size:9px;color:#999">{{ item.pct }}%</span>
            </div>
          </div>
          <span v-else style="color:#999">—</span>
        </el-card>
      </section>

      <!-- 原平台报错统计 -->
      <section style="margin-top:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px">
          原平台报错统计 <el-tag size="small" type="info">{{ (stats.upstreamErrorList||[]).length }} 种 / {{ upErrTotal }} 次</el-tag>
        </div>
        <el-card shadow="never" style="padding:0">
          <div v-if="(stats.upstreamErrorList||[]).length">
            <div v-for="(e, i) in (stats.upstreamErrorList||[])" :key="i" style="padding:10px 12px;border-bottom:1px solid #d9d9d9;min-width:0">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">
                <span :style="{color: e.code === '200' ? '#52c41a' : (parseInt(e.code) >= 500 || parseInt(e.code) >= 10000 ? '#ff4d4f' : '#faad14'), fontWeight: 700, fontFamily: 'ui-monospace,monospace', fontSize: '13px'}">{{ e.code }}</span>
                <span style="color:#999;font-size:10px;background:#f0f0f0;padding:1px 6px;border-radius:999px">{{ e.type || '—' }}</span>
                <span style="margin-left:auto;font-family:ui-monospace,monospace;font-size:13px;font-weight:600">{{ e.count }} 次</span>
              </div>
              <div style="font-size:11px;color:#999;word-break:break-all;line-height:1.4">{{ e.message || '—' }}</div>
            </div>
          </div>
          <div v-else style="padding:16px;color:#999;text-align:center">无报错 🎉</div>
        </el-card>
      </section>

      <!-- 失败样本 -->
      <section style="margin-top:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px">失败样本</div>
        <el-card shadow="never" style="max-height:240px;overflow-y:auto">
          <div v-if="(stats.errorSamples||[]).length" class="mono" style="font-size:12px;color:#ff4d4f;line-height:1.5;word-break:break-all">
            <div v-for="(e, i) in stats.errorSamples" :key="i" :style="{marginBottom: '6px', paddingBottom: '6px', borderBottom: i < stats.errorSamples.length-1 ? '1px solid #d9d9d9' : 'none'}">
              [{{ toBJT(e.ts) }}] {{ e.msg }}<br v-if="e.meta && e.meta.url">↳ {{ e.meta && e.meta.url ? e.meta.url : '' }}
            </div>
          </div>
          <span v-else class="ok-color">无失败记录 🎉</span>
        </el-card>
      </section>

      <!-- 实时日志 -->
      <section style="margin-top:16px">
        <div style="font-size:13px;font-weight:600;margin-bottom:8px;display:flex;align-items:center;gap:8px">
          实时日志 <el-tag size="small" :type="liveBadgeType">{{ liveBadgeText }}</el-tag>
        </div>
        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:8px">
          <el-radio-group v-model="curLevel" size="small" @change="renderLogs">
            <el-radio-button label="">全部</el-radio-button>
            <el-radio-button label="INFO">INFO</el-radio-button>
            <el-radio-button label="WARN">WARN</el-radio-button>
            <el-radio-button label="ERROR">ERROR</el-radio-button>
          </el-radio-group>
          <div style="display:flex;gap:8px;align-items:center">
            <el-input v-model="curSearch" placeholder="搜索关键字…" clearable size="small" @input="renderLogs" style="flex:1;min-width:0"></el-input>
            <el-checkbox v-model="autoscroll" size="small">置顶新日志</el-checkbox>
          </div>
        </div>
        <div ref="logBoxRef" class="log-box">
          <div v-for="(e, i) in filteredLogs" :key="e.ts + i" class="log-line">
            <span class="ts">{{ toBJTShort(e.ts) }}</span>
            <span :class="'lv lv-' + e.level">{{ e.level }}</span> {{ e.msg }}<span v-if="e.meta" class="meta-inline"> {{ JSON.stringify(e.meta).slice(0, 300) }}</span>
          </div>
        </div>
      </section>
    </main>
  </el-config-provider>
</div>

<script src="https://cdn.jsdelivr.net/npm/vue@3/dist/vue.global.prod.js"></script>
<script src="https://cdn.jsdelivr.net/npm/element-plus@2"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script>
const { createApp, ref, reactive, computed, onMounted, nextTick, watch } = Vue;

const app = createApp({
  setup() {
    const stats = reactive({
      total: 0, success: 0, failed: 0, retried: 0, totalRetries: 0,
      durations: [], byPath: {}, byHttpStatus: {}, upstreamErrors: {},
      upstreamErrorList: [], errorSamples: [], retryHistogram: {},
      hourlyBuckets: {}, windowStart: null, windowEnd: null,
      successRate: 0, avgDurationMs: 0, p50DurationMs: 0, p95DurationMs: 0, maxDurationMs: 0,
      avgRetries: 0, byModelList: [], hourlyList: [],
    });
    const minutes = ref(1440);
    const winInfo = ref('—');
    const logBuf = ref([]);
    const curLevel = ref('');
    const curSearch = ref('');
    const autoscroll = ref(true);
    const liveBadgeText = ref('LIVE');
    const liveBadgeType = ref('success');
    const hourlyChartRef = ref(null);
    const logBoxRef = ref(null);
    let chartInstance = null;
    let es = null;
    const MAX_LOG_LINES = 400;

    const unaccounted = computed(() => Math.max(0, stats.total - stats.success - stats.failed));
    const modelTotal = computed(() => (stats.byModelList || []).reduce((a, b) => a + b.total, 0));
    const pathList = computed(() => {
      return Object.entries(stats.byPath || {}).map(([path, d]) => {
        const done = d.success + d.failed;
        const rate = done > 0 ? (d.success / done * 100).toFixed(1) + '%' : '—';
        return { path, total: d.total, success: d.success, failed: d.failed, successRate: rate };
      }).sort((a, b) => b.total - a.total);
    });
    const retryList = computed(() => {
      const h = stats.retryHistogram || {};
      const total = Object.values(h).reduce((a, b) => a + b, 0) || 1;
      return Object.entries(h).map(([range, count]) => ({ range: '重试 ' + range + ' 次', count, pct: (count / total * 100).toFixed(1) }));
    });
    const statusList = computed(() => {
      const entries = Object.entries(stats.byHttpStatus || {}).sort((a, b) => b[1] - a[1]);
      const total = entries.reduce((a, [, c]) => a + c, 0) || 1;
      return entries.map(([code, count]) => ({ code, count, pct: (count / total * 100).toFixed(0) }));
    });
    const upErrTotal = computed(() => (stats.upstreamErrorList || []).reduce((a, b) => a + b.count, 0));
    const filteredLogs = computed(() => {
      let items = logBuf.value;
      if (curLevel.value) items = items.filter(e => e.level === curLevel.value);
      if (curSearch.value) items = items.filter(e => e.raw.toLowerCase().includes(curSearch.value.toLowerCase()));
      return items.slice(-MAX_LOG_LINES).reverse();
    });

    function toBJT(iso) {
      if (!iso) return '—';
      const t = new Date(iso);
      if (isNaN(t)) return iso;
      return t.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }
    function toBJTShort(iso) {
      if (!iso) return '—';
      const t = new Date(iso);
      if (isNaN(t)) return iso;
      return t.toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    }

    async function fetchStats() {
      try {
        const r = await fetch('/api/stats?minutes=' + minutes.value);
        const s = await r.json();
        Object.assign(stats, s);
        winInfo.value = toBJT(s.windowStart) + ' → ' + toBJT(s.windowEnd);
        await nextTick();
        renderChart();
      } catch (e) { console.error(e); }
    }

    function renderChart() {
      const hours = stats.hourlyList || [];
      const ctx = hourlyChartRef.value;
      if (!ctx) return;
      if (chartInstance) chartInstance.destroy();
      if (hours.length) {
        chartInstance = new Chart(ctx, {
          type: 'bar',
          data: {
            labels: hours.map(h => h.label),
            datasets: [{ label: '上游成功率%', data: hours.map(h => h.rate), backgroundColor: hours.map(h => h.rate >= 95 ? '#52c41a' : (h.rate >= 80 ? '#faad14' : '#ff4d4f')), borderRadius: 2 }]
          },
          options: {
            responsive: true, maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { title: items => hours[items[0].dataIndex].label, label: item => { const h = hours[item.dataIndex]; return '上游成功率: ' + h.rate + '% | 成功: ' + h.success + ' 失败: ' + h.fail; } } }
            },
            scales: {
              y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%', color: '#999', font: { size: 11 } }, grid: { color: '#eee' } },
              x: { ticks: { color: '#999', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 12 }, grid: { display: false } }
            }
          }
        });
      }
    }

    function renderLogs() { /* computed 自动响应 */ }

    async function loadHistory() {
      try {
        const r = await fetch('/api/logs?lines=200');
        const arr = await r.json();
        logBuf.value = arr;
      } catch (e) { console.error(e); }
    }

    function connectSSE() {
      try {
        es = new EventSource('/api/stream');
        es.onmessage = ev => {
          try {
            const e = JSON.parse(ev.data);
            logBuf.value.push(e);
            if (logBuf.value.length > MAX_LOG_LINES * 2) logBuf.value.splice(0, logBuf.value.length - MAX_LOG_LINES);
          } catch {}
        };
        es.onopen = () => { liveBadgeText.value = 'LIVE'; liveBadgeType.value = 'success'; };
        es.onerror = () => { liveBadgeText.value = '断开'; liveBadgeType.value = 'danger'; };
      } catch (e) { console.error(e); }
    }

    // 下拉刷新(移动端)
    let touchStartY = 0, pullDistance = 0;
    function onTouchStart(e) { touchStartY = e.touches[0].clientY; }
    function onTouchMove(e) { if (window.scrollY === 0 && e.touches[0].clientY > touchStartY) pullDistance = e.touches[0].clientY - touchStartY; }
    function onTouchEnd() { if (pullDistance > 80) { fetchStats(); loadHistory(); } pullDistance = 0; }

    onMounted(() => {
      loadHistory().then(connectSSE);
      fetchStats();
      setInterval(fetchStats, 15000);
      document.addEventListener('touchstart', onTouchStart, { passive: true });
      document.addEventListener('touchmove', onTouchMove, { passive: true });
      document.addEventListener('touchend', onTouchEnd, { passive: true });
    });

    return { stats, minutes, winInfo, logBuf, curLevel, curSearch, autoscroll, liveBadgeText, liveBadgeType,
             hourlyChartRef, logBoxRef, unaccounted, modelTotal, pathList, retryList, statusList, upErrTotal,
             filteredLogs, toBJT, toBJTShort, fetchStats, renderLogs };
  }
});

app.use(ElementPlus);
app.mount('#app');
</script>
</body>
</html>`;
