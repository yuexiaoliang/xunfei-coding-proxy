# AGENTS.md

## 项目概述

讯飞 Coding Plan API 代理 + 监控仪表盘。纯 Node.js 内置模块实现，零第三方依赖。

- `proxy.js` — 代理服务器（端口 9090），透明转发讯飞 API 请求，遇 503/429/500/502/504 自动重试，支持流式 SSE 智能重试
- `monitor.js` — 监控仪表盘（端口 9091），解析 proxy 日志，展示成功率/耗时/重试/原平台报错，含实时日志流（SSE）
- `ecosystem.config.js` — PM2 进程配置，两个服务均通过 PM2 管理，已 `pm2 save` + `systemctl --user` 开机自启

## 架构

```
客户端 → proxy.js (9090) → 讯飞 API (maas-coding-api.cn-huabei-1.xf-yun.com)
                ↓ 写日志
          logs/out.log
                ↓ 读尾部 2MB
         monitor.js (9091) → 浏览器
```

proxy 和 monitor 是两个独立进程，仅通过日志文件耦合。proxy 用 `console.log`（经 PM2 格式化）写日志，monitor 读日志文件尾部解析统计。

## 关键设计决策

### proxy.js
- **零依赖**：只用 `http`/`https`/`url` 内置模块，HTTPS 连接池复用 TLS
- **流式重试**：SSE 响应先缓冲前 5 个事件，检测到可重试错误码（10310/10010）则中断重试，无错后直通转发
- **日志级别**：`LOG_LEVEL=info`。成功日志统一用 INFO 级别（首次成功也记录），否则 monitor 会漏统计
- **重试策略**：固定间隔 3s + 随机抖动，最多 60 次

### monitor.js
- **日志解析**：PM2 日志格式 `YYYY-MM-DD HH:mm:ss Z: [ISO] [LEVEL] 消息 {JSON}`，`parseLine` 先去 PM2 前缀再匹配
- **统计口径**：
  - `total` = 收到请求数（`收到请求:` 日志）
  - `success` = 请求成功数（`流式/非流式请求成功` 日志）
  - `failed` = 重试耗尽数（`所有重试失败` 日志）
  - `totalRetries` = 收到可重试错误的次数（4 种可重试日志类型）
  - `total - success - failed` = 进行中/窗口边界未归类的请求
- **时间窗口**：`readRecentLogs` 读日志文件尾部 2MB（`CONFIG.tailBytes`），`filterByMinutes` 按时间过滤
- **前端**：HTML/CSS/JS 全部内联在 `DASHBOARD_HTML` 模板字符串中，无外部资源

## ⚠️ 重要注意事项

### 模板字符串转义陷阱
`monitor.js` 的 `DASHBOARD_HTML` 是反引号模板字符串。里面的 JS 代码中：
- `\` 是转义符，会被吃掉。正则 `/\//g` 运行时变成 `///g`（语法错误）
- **解决**：模板字符串内的字符串处理用 `split/join` 替代正则，或用 `\\/` 双转义

### PM2 缓存陷阱
`pm2 restart` 有时不加载最新代码。彻底重启用：
```bash
pm2 delete xunfei-monitor && pm2 start ecosystem.config.js --only xunfei-monitor
# 或
pm2 kill && pm2 start ecosystem.config.js
```
验证生效：`curl -s http://localhost:9091/ | grep "关键代码"`

### 日志格式（proxy.js 的 4 种可重试错误日志）
1. `流式请求收到可重试状态码: 503` — meta.body 含完整错误 JSON
2. `非流式请求遇到可重试错误 (状态码: 503)` — meta.bodyPreview
3. `流式请求收到非 SSE 可重试响应` — meta.body
4. `流式模式: 缓冲阶段检测到可重试错误` — meta.eventData

### extractUpstreamError
上游错误 body 格式：`{"error":{"code":10310,"message":"...","type":"server_error"}}`
- 无 `code` 字段时用 `type` 作分组 key（如 `one_api_error`）
- body 可能被截断或含转义引号，正则提取需兼容

## 常用命令

```bash
# 启动/重启
npm run pm2:start                          # 启动 proxy + monitor
pm2 restart xunfei-coding-proxy xunfei-monitor --update-env

# 彻底重启（解决缓存问题）
pm2 delete xunfei-monitor && pm2 start ecosystem.config.js --only xunfei-monitor

# 验证
node -c proxy.js && node -c monitor.js     # 语法检查
curl -s http://localhost:9091/api/stats?minutes=15 | node -e "process.stdin.resume()"  # API 健康
curl -s http://localhost:9090/health        # proxy 健康

# 日志
pm2 logs xunfei-coding-proxy --lines 50
tail -f logs/out.log

# PM2 自启状态
systemctl --user is-enabled pm2-yuexiaoliang
```

## 用户偏好

- 中文沟通
- 零依赖，纯 Node.js 内置模块
- 重视移动端体验（390px 无横向溢出）
- 关注数据准确性（会质疑指标合理性）
- UI 风格偏好朴素浅色，不喜欢"AI 味"深色荧光风格
- 日志最新在上（倒序），无需手动滚动
- 时间显示北京时间
