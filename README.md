# 讯飞 Coding Plan API 代理

自动重试讯飞 Coding Plan API 的代理服务器，解决 503 过载问题。

## 功能

- 透明代理讯飞 Coding Plan API 请求
- 遇到 503/429/500/502/504 等错误时自动重试（指数退避）
- 支持流式响应（SSE）的智能重试
- 支持 OpenAI 协议、Anthropic 协议、Response API 协议
- 健康检查端点 `/health`
- PM2 进程管理

## 快速开始

### 1. 使用 PM2 启动

```bash
npm run pm2:start
```

### 2. 配置你的 AI 工具

将 API Base URL 改为代理地址：

| 协议 | 原始 URL | 代理 URL |
|------|---------|---------|
| OpenAI | `https://maas-coding-api.cn-huabei-1.xf-yun.com/v2` | `http://localhost:9090/v2` |
| Anthropic | `https://maas-coding-api.cn-huabei-1.xf-yun.com/anthropic` | `http://localhost:9090/anthropic` |
| Response | `https://maas-coding-api.cn-huabei-1.xf-yun.com/v1/responses` | `http://localhost:9090/v1/responses` |

API Key 保持不变，代理会原样转发。

### 3. 健康检查

```bash
curl http://localhost:9090/health
```

## 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_PORT` | `9090` | 代理监听端口 |
| `UPSTREAM_BASE` | `https://maas-coding-api.cn-huabei-1.xf-yun.com` | 讯飞 API 基础地址 |
| `MAX_RETRIES` | `10` | 最大重试次数 |
| `RETRY_DELAY_MS` | `1000` | 初始重试延迟（毫秒） |
| `RETRY_DELAY_MAX_MS` | `30000` | 最大重试延迟（毫秒） |
| `BACKOFF_MULTIPLIER` | `2` | 退避倍数 |
| `REQUEST_TIMEOUT_MS` | `300000` | 请求超时（毫秒） |
| `LOG_LEVEL` | `info` | 日志级别 |

## PM2 常用命令

```bash
npm run pm2:start      # 启动
npm run pm2:stop       # 停止
npm run pm2:restart    # 重启
npm run pm2:logs       # 查看日志
npm run pm2:status     # 查看状态
```

## 重试策略

- 采用指数退避算法，初始延迟 1 秒，每次翻倍，最大 30 秒
- 添加 0~20% 随机抖动，避免多个请求同时重试
- 对流式响应，先缓冲前几个 SSE 事件检查错误码，确认无错误后再直通转发
- 可重试的讯飞错误码：10010、10012、10110

## 工作原理

```
AI 工具 → 代理 (localhost:9090) → 讯飞 API
                ↑
          503/429/500 → 自动重试（指数退避）
```
