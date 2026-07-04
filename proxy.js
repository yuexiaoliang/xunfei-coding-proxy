/**
 * 讯飞 Coding Plan API 代理服务器
 *
 * 功能：
 * - 透明转发请求到讯飞 API
 * - 遇到 503/429/500 等错误时自动重试
 * - 支持流式响应（SSE）的重试
 * - 支持 OpenAI 协议、Anthropic 协议、Response API 协议
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ============ 配置 ============
const CONFIG = {
  // 代理监听端口
  port: parseInt(process.env.PROXY_PORT || '9090', 10),

  // 讯飞 API 基础地址
  upstreamBase: process.env.UPSTREAM_BASE || 'https://maas-coding-api.cn-huabei-1.xf-yun.com',

  // 重试配置
  maxRetries: parseInt(process.env.MAX_RETRIES || '60', 10),
  // 重试间隔（固定，每秒一次）
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '1000', 10),

  // 需要重试的 HTTP 状态码
  retryStatusCodes: new Set([
    429, // 请求速率超限
    500, // 服务器内部错误
    502, // 网关错误
    503, // 服务过载
    504, // 网关超时
  ]),

  // 需要重试的 SSE 错误码（讯飞自定义）
  retrySseErrorCodes: new Set([
    10010, // 接收引擎数据的错误，或引擎处于排队状态
    10012, // 引擎内部错误或排队状态
    10110, // 服务忙，请稍后再试
  ]),

  // 请求超时（毫秒）
  requestTimeoutMs: parseInt(process.env.REQUEST_TIMEOUT_MS || '300000', 10),

  // 日志级别: 'debug' | 'info' | 'warn' | 'error'
  logLevel: process.env.LOG_LEVEL || 'info',
};

// ============ 日志 ============
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

function log(level, msg, meta = {}) {
  if (LOG_LEVELS[level] < LOG_LEVELS[CONFIG.logLevel]) return;
  const ts = new Date().toISOString();
  const metaStr = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  console.log(`[${ts}] [${level.toUpperCase()}] ${msg}${metaStr}`);
}

// ============ 工具函数 ============

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function calculateDelay() {
  // 固定间隔，每秒一次（加少量抖动避免惊群）
  return CONFIG.retryDelayMs + Math.floor(Math.random() * 200);
}

/**
 * 收集请求体
 */
function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 发送 HTTP 请求到上游服务器，返回响应
 */
function forwardRequest(targetUrl, method, headers, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(targetUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: method,
      headers: headers,
      timeout: timeoutMs,
    };

    const req = lib.request(options, (res) => {
      resolve(res);
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });

    if (body && body.length > 0) {
      req.write(body);
    }
    req.end();
  });
}

/**
 * 收集完整的响应体
 */
function collectResponse(res) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    res.on('error', reject);
  });
}

/**
 * 检查响应是否为 SSE 流式响应
 */
function isSSEResponse(res) {
  const contentType = (res.headers['content-type'] || '').toLowerCase();
  return contentType.includes('text/event-stream');
}

/**
 * 检查非流式响应是否需要重试
 */
function shouldRetryNonStreamResponse(res, body) {
  // HTTP 状态码判断
  if (CONFIG.retryStatusCodes.has(res.statusCode)) {
    return true;
  }

  // 检查响应体中的错误码
  try {
    const json = JSON.parse(body.toString());
    if (json.error && json.error.code !== undefined) {
      const code = parseInt(json.error.code, 10);
      if (CONFIG.retrySseErrorCodes.has(code)) {
        return true;
      }
      // HTTP 状态码数字也在 error.code 里
      if (CONFIG.retryStatusCodes.has(code)) {
        return true;
      }
    }
    if (json.code !== undefined && (CONFIG.retrySseErrorCodes.has(json.code) || CONFIG.retryStatusCodes.has(json.code))) {
      return true;
    }
  } catch {
    // 非 JSON 响应，只靠 HTTP 状态码判断
  }

  return false;
}

// ============ 请求处理 ============

/**
 * 处理非流式请求（带重试）
 */
async function handleNonStreamRequest(clientReq, clientRes, targetUrl, headers, body) {
  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = calculateDelay();
      log('info', `非流式请求第 ${attempt} 次重试，等待 ${delay}ms...`, { url: targetUrl });
      await sleep(delay);
    }

    try {
      const upstreamRes = await forwardRequest(
        targetUrl, clientReq.method, headers, body, CONFIG.requestTimeoutMs
      );

      const responseBody = await collectResponse(upstreamRes);

      if (shouldRetryNonStreamResponse(upstreamRes, responseBody)) {
        const bodyPreview = responseBody.toString().substring(0, 200);
        log('warn', `非流式请求遇到可重试错误 (状态码: ${upstreamRes.statusCode})`, {
          attempt, bodyPreview
        });
        lastError = new Error(`Retryable status: ${upstreamRes.statusCode}`);
        continue;
      }

      // 成功，转发响应
      clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
      clientRes.end(responseBody);
      log('info', `非流式请求成功 (状态码: ${upstreamRes.statusCode})`, {
        attempt, url: targetUrl, contentLength: responseBody.length
      });
      return;

    } catch (err) {
      log('warn', `非流式请求失败: ${err.message}`, { attempt });
      lastError = err;
    }
  }

  // 所有重试都失败了
  log('error', `非流式请求所有重试失败`, { url: targetUrl, maxRetries: CONFIG.maxRetries });
  clientRes.writeHead(502, { 'Content-Type': 'application/json' });
  clientRes.end(JSON.stringify({
    error: {
      type: 'proxy_error',
      message: `Upstream request failed after ${CONFIG.maxRetries} retries: ${lastError?.message || 'unknown error'}`,
    }
  }));
}

/**
 * 检查 SSE 事件数据是否包含可重试错误
 */
function checkSSEEventForRetryableError(data) {
  if (data === '[DONE]') return false;

  try {
    const json = JSON.parse(data);

    // OpenAI 格式错误: { error: { code, type, message } }
    if (json.error) {
      if (json.error.code !== undefined) {
        const code = parseInt(json.error.code, 10);
        if (CONFIG.retrySseErrorCodes.has(code) || CONFIG.retryStatusCodes.has(code)) {
          return true;
        }
      }
      if (json.error.type === 'server_error') {
        return true;
      }
    }

    // 讯飞格式错误: { code, message, ... }
    if (json.code !== undefined) {
      const code = parseInt(json.code, 10);
      if (CONFIG.retrySseErrorCodes.has(code) || CONFIG.retryStatusCodes.has(code)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * 处理流式请求（带重试）- 直通模式
 *
 * 策略：先缓冲前 N 个 SSE 事件检查错误码，确认无错后直通转发。
 * 如果前 N 个事件包含可重试错误，则中断并重试。
 */
async function handleStreamRequest(clientReq, clientRes, targetUrl, headers, body) {
  let lastError = null;

  for (let attempt = 0; attempt <= CONFIG.maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = calculateDelay();
      log('info', `流式请求第 ${attempt} 次重试，等待 ${delay}ms...`, { url: targetUrl });
      await sleep(delay);
    }

    try {
      const upstreamRes = await forwardRequest(
        targetUrl, clientReq.method, headers, body, CONFIG.requestTimeoutMs
      );

      // 先检查 HTTP 状态码
      if (CONFIG.retryStatusCodes.has(upstreamRes.statusCode)) {
        const errBody = await collectResponse(upstreamRes);
        log('warn', `流式请求收到可重试状态码: ${upstreamRes.statusCode}`, {
          attempt, body: errBody.toString().substring(0, 300)
        });
        lastError = new Error(`Retryable status: ${upstreamRes.statusCode}`);
        continue;
      }

      // 非 SSE 响应（讯飞有时返回 200 + JSON 错误，而非 SSE）
      if (!isSSEResponse(upstreamRes)) {
        const responseBody = await collectResponse(upstreamRes);
        if (shouldRetryNonStreamResponse(upstreamRes, responseBody)) {
          log('warn', `流式请求收到非 SSE 可重试响应 (状态码: ${upstreamRes.statusCode})`, {
            attempt, body: responseBody.toString().substring(0, 300)
          });
          lastError = new Error(`Retryable non-SSE response: ${upstreamRes.statusCode}`);
          continue;
        }
        // 非重试类错误或正常非流式响应，直接转发
        clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers);
        clientRes.end(responseBody);
        return;
      }

      // SSE 响应：直通模式，前 N 个事件缓冲检查
      const INITIAL_BUFFER_EVENTS = 5;
      let eventCount = 0;
      let bufferChunks = [];
      let errorDetected = false;
      let passthroughStarted = false;
      let bufferStr = '';

      await new Promise((resolve) => {
        // data 事件处理器引用，用于在错误时移除
        const onData = (chunk) => {
          // 错误已检测到，忽略后续数据
          if (errorDetected) return;

          if (!passthroughStarted) {
            // === 缓冲阶段 ===
            bufferChunks.push(chunk);
            bufferStr += chunk.toString();

            // 解析完整的 SSE 行
            const lines = bufferStr.split('\n');
            // 保留最后一个可能不完整的行
            bufferStr = lines.pop() || '';

            for (const line of lines) {
              if (line.startsWith('data:')) {
                eventCount++;
                const data = line.slice(5).trim();

                if (checkSSEEventForRetryableError(data)) {
                  log('warn', `流式模式: 缓冲阶段检测到可重试错误`, {
                    attempt, eventData: data.substring(0, 200)
                  });
                  errorDetected = true;
                  lastError = new Error(`Retryable SSE error`);
                  upstreamRes.destroy();
                  return;
                }

                // 缓冲事件数达到阈值，开始直通
                if (eventCount >= INITIAL_BUFFER_EVENTS) {
                  passthroughStarted = true;
                  // 写响应头给客户端
                  const respHeaders = { ...upstreamRes.headers };
                  // 直通模式下不要 content-length
                  delete respHeaders['content-length'];
                  clientRes.writeHead(upstreamRes.statusCode, respHeaders);
                  // 写缓冲数据
                  for (const bc of bufferChunks) {
                    clientRes.write(bc);
                  }
                  bufferChunks = [];
                  return; // 跳出 for，后续数据走直通分支
                }
              }
            }
          } else {
            // === 直通阶段：直接转发 ===
            clientRes.write(chunk);
          }
        };

        const onEnd = () => {
          if (errorDetected) {
            resolve();
            return;
          }

          if (!passthroughStarted) {
            // 流结束了但还没达到直通阈值
            if (eventCount === 0 && bufferChunks.length === 0) {
              // 空响应，可能需要重试
              log('warn', '流式模式: 收到空 SSE 响应', { attempt });
              errorDetected = true;
              lastError = new Error('Empty SSE response');
              resolve();
              return;
            }
            // 流正常结束，转发缓冲数据
            const respHeaders = { ...upstreamRes.headers };
            delete respHeaders['transfer-encoding'];
            // 计算实际内容长度
            const totalLength = bufferChunks.reduce((sum, c) => sum + c.length, 0);
            respHeaders['content-length'] = totalLength;
            delete respHeaders['transfer-encoding'];
            clientRes.writeHead(upstreamRes.statusCode, respHeaders);
            for (const bc of bufferChunks) {
              clientRes.write(bc);
            }
          }
          clientRes.end();
          log('info', `流式请求成功`, {
            attempt, url: targetUrl, statusCode: upstreamRes.statusCode
          });
          resolve();
        };

        const onError = (err) => {
          log('warn', `上游 SSE 流错误: ${err.message}`, { attempt });
          if (!passthroughStarted) {
            errorDetected = true;
            lastError = err;
          }
          resolve();
        };

        upstreamRes.on('data', onData);
        upstreamRes.on('end', onEnd);
        upstreamRes.on('error', onError);
      });

      if (errorDetected) {
        continue; // 重试
      }

      return; // 成功

    } catch (err) {
      log('warn', `流式请求失败: ${err.message}`, { attempt });
      lastError = err;
    }
  }

  // 所有重试都失败了
  log('error', `流式请求所有重试失败`, { url: targetUrl, maxRetries: CONFIG.maxRetries });

  if (!clientRes.headersSent) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({
      error: {
        type: 'proxy_error',
        message: `Upstream stream request failed after ${CONFIG.maxRetries} retries: ${lastError?.message || 'unknown error'}`,
      }
    }));
  } else {
    // 已经开始写给客户端了，发送 SSE 错误事件然后关闭
    clientRes.write(`data: ${JSON.stringify({
      error: {
        type: 'proxy_error',
        message: `Upstream failed after ${CONFIG.maxRetries} retries: ${lastError?.message}`,
      }
    })}\n\n`);
    clientRes.end();
  }
}

// ============ 主请求处理器 ============

async function handleRequest(clientReq, clientRes) {
  const startTime = Date.now();

  // 构建上游 URL
  const targetUrl = CONFIG.upstreamBase + clientReq.url;

  // 复制请求头
  const headers = { ...clientReq.headers };
  headers['host'] = new URL(CONFIG.upstreamBase).host;
  delete headers['connection'];

  log('info', `收到请求: ${clientReq.method} ${clientReq.url}`, {
    targetUrl,
    contentType: clientReq.headers['content-type'] || '',
  });

  try {
    // 收集请求体
    const body = await collectBody(clientReq);

    // 判断是否为流式请求
    const isStream = isStreamRequest(clientReq, body);

    if (isStream) {
      await handleStreamRequest(clientReq, clientRes, targetUrl, headers, body);
    } else {
      await handleNonStreamRequest(clientReq, clientRes, targetUrl, headers, body);
    }

    const duration = Date.now() - startTime;
    log('info', `请求处理完成`, {
      method: clientReq.method,
      url: clientReq.url,
      duration: `${duration}ms`,
    });

  } catch (err) {
    log('error', `请求处理异常: ${err.message}`, { url: clientReq.url });
    if (!clientRes.headersSent) {
      clientRes.writeHead(500, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({
        error: {
          type: 'proxy_error',
          message: `Internal proxy error: ${err.message}`,
        }
      }));
    }
  }
}

/**
 * 判断请求是否为流式请求
 */
function isStreamRequest(req, body) {
  // 检查 URL 参数
  if (req.url.includes('stream=true') || req.url.includes('stream=1')) {
    return true;
  }

  // 检查 Accept header
  const accept = (req.headers['accept'] || '').toLowerCase();
  if (accept.includes('text/event-stream')) {
    return true;
  }

  // 检查请求体中的 stream 字段
  if (body && body.length > 0) {
    try {
      const json = JSON.parse(body.toString());
      if (json.stream === true) {
        return true;
      }
    } catch {
      // 非 JSON 请求体
    }
  }

  return false;
}

// ============ 健康检查 ============

function handleHealthCheck(clientRes) {
  clientRes.writeHead(200, { 'Content-Type': 'application/json' });
  clientRes.end(JSON.stringify({
    status: 'ok',
    service: 'xunfei-coding-proxy',
    upstream: CONFIG.upstreamBase,
    maxRetries: CONFIG.maxRetries,
    retryStatusCodes: [...CONFIG.retryStatusCodes],
  }));
}

// ============ 启动服务器 ============

const server = http.createServer((clientReq, clientRes) => {
  // 健康检查端点
  if (clientReq.url === '/health' && clientReq.method === 'GET') {
    handleHealthCheck(clientRes);
    return;
  }

  // 代理请求
  handleRequest(clientReq, clientRes);
});

server.listen(CONFIG.port, () => {
  log('info', `讯飞 Coding Plan 代理服务器已启动`, {
    port: CONFIG.port,
    upstream: CONFIG.upstreamBase,
    maxRetries: CONFIG.maxRetries,
    retryStatusCodes: [...CONFIG.retryStatusCodes],
  });
});

server.on('error', (err) => {
  log('error', `服务器错误: ${err.message}`);
  process.exit(1);
});

// 优雅关闭
process.on('SIGTERM', () => {
  log('info', '收到 SIGTERM，正在关闭服务器...');
  server.close(() => {
    log('info', '服务器已关闭');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  log('info', '收到 SIGINT，正在关闭服务器...');
  server.close(() => {
    log('info', '服务器已关闭');
    process.exit(0);
  });
});
