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


## 监控仪表盘

项目自带一个 Web 监控界面，可实时查看日志、成功率、重试统计、响应时长等。

### 启动

```bash
# 方式一：直接运行
npm run monitor

# 方式二：随 PM2 一起启动（推荐）
npm run pm2:start   # ecosystem.config.js 已包含 monitor
```

启动后访问：http://localhost:9091

### 功能

- **KPI 卡片**：成功率、请求总数、成功/失败数、重试次数、平均/P50/P95/Max 耗时
- **按路径分布**：每个 API 路径的请求数、成功数、失败数、成功率
- **重试次数直方图**：0 次 / 1-3 / 4-10 / 11-30 / 31+ 区间分布
- **上游状态码统计**：按 HTTP 状态码汇总
- **失败样本**：最近 20 条失败请求
- **实时日志流**：SSE 推送，支持按级别（INFO/WARN/ERROR）过滤和关键字搜索
- **时间窗口**：全部 / 5 分钟 / 15 分钟 / 1 小时 / 6 小时 / 24 小时

### API 端点

| 端点 | 说明 |
|------|------|
| `GET /` | 仪表盘 HTML 页面 |
| `GET /api/stats?minutes=15` | 统计指标 JSON（minutes=0 表示全部） |
| `GET /api/logs?lines=300&level=WARN&q=503` | 历史日志 JSON |
| `GET /api/stream` | 实时日志 SSE 流 |
| `GET /health` | 健康检查 |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `MONITOR_PORT` | `9091` | 监控服务端口 |
| `MONITOR_LOG` | `./logs/out.log` | 代理日志文件路径 |
| `MONITOR_TAIL_BYTES` | `2097152` | 解析日志的尾部最大字节数 |
| `MONITOR_POLL_MS` | `1500` | SSE 轮询间隔（毫秒） |

## 环境变量配置

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `PROXY_PORT` | `9090` | 代理监听端口 |
| `UPSTREAM_BASE` | `https://maas-coding-api.cn-huabei-1.xf-yun.com` | 讯飞 API 基础地址 |
| `MAX_RETRIES` | `1800` | 最大重试次数 |
| `RETRY_DELAY_MS` | `200` | 重试间隔（固定，毫秒） |
| `REQUEST_TIMEOUT_MS` | `360000` | 请求超时（毫秒） |
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

- 固定每 200ms 重试一次，最多重试 1800 次（约 6 分钟）
- 添加少量随机抖动（0~50ms），避免多个请求同时重试
- 对流式响应，先缓冲前几个 SSE 事件检查错误码，确认无错误后再直通转发
- 可重试的讯飞错误码：10010、10012、10110

## 工作原理

```
AI 工具 → 代理 (localhost:9090) → 讯飞 API
                ↑
          503/429/500 → 自动重试（指数退避）
```
