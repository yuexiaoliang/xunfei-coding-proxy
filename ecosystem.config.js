module.exports = {
  apps: [
    {
      name: 'xunfei-coding-proxy',
      script: 'proxy.js',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      env: {
        NODE_ENV: 'production',
        // 代理监听端口
        PROXY_PORT: 9090,
        // 讯飞 API 基础地址
        UPSTREAM_BASE: 'https://maas-coding-api.cn-huabei-1.xf-yun.com',
        // 最大重试次数
        MAX_RETRIES: 60,
        // 重试间隔（固定，每秒一次）
        RETRY_DELAY_MS: 1000,
        // 请求超时（毫秒，5分钟）
        REQUEST_TIMEOUT_MS: 300000,
        // 日志级别: debug | info | warn | error
        LOG_LEVEL: 'info',
      },
      // PM2 日志配置
      error_file: './logs/error.log',
      out_file: './logs/out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      // 日志轮转：PM2 内置支持
      // 日志文件最大 10MB 后轮转
      max_restarts: 10,
      // 保留最近 7 份轮转日志
      // PM2 0.x~6.x 不原生支持 rotate 份数，
      // 改用 logrotate.d 或在代码中自行处理
      // 优雅关闭
      kill_timeout: 10000,
      listen_timeout: 10000,
    },
  ],
};
