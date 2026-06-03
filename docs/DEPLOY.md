# 部署指南

> v1.12

## 1. Docker 部署 (推荐)

```bash
# 构建镜像
docker build -t wison-rbi .

# 运行 (默认端口 8080)
docker run -d --name wison-rbi \
  --cap-add=SYS_ADMIN \           # Chromium 需要
  -p 8080:8080 \
  -e WISON_AUTH_TOKEN=your-secret \
  wison-rbi

# 查看日志
docker logs -f wison-rbi
```

### Docker 资源建议

| 资源 | 最小值 | 推荐值 | 说明 |
|------|--------|--------|------|
| CPU | 1 核 | 2 核+ | 每 session 约 0.2 核 |
| 内存 | 512MB | 1GB+ | 每 session 约 100MB Chromium |
| 磁盘 | 200MB | 500MB | Chromium + npm 包 |

## 2. 裸机部署

```bash
# 1. 安装 Node.js 20+
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 2. 克隆 + 安装
git clone https://github.com/laolv2023/wison-rbi.git /opt/wison-rbi
cd /opt/wison-rbi && npm install --production

# 3. 安装 Chromium
npx playwright install chromium --with-deps

# 4. 配置环境变量
cat > /etc/wison-rbi.env << EOF
WISON_PORT=8080
WISON_HOST=127.0.0.1
WISON_AUTH_TOKEN=$(openssl rand -hex 32)
WISON_MAX_SESSIONS=5
WISON_LOG_LEVEL=info
EOF

# 5. systemd 服务
cat > /etc/systemd/system/wison-rbi.service << EOF
[Unit]
Description=Wison-RBI Remote Browser Isolation
After=network.target

[Service]
Type=simple
User=wison
WorkingDirectory=/opt/wison-rbi
EnvironmentFile=/etc/wison-rbi.env
ExecStart=/usr/bin/node packages/server/src/index.js
Restart=on-failure
RestartSec=5
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now wison-rbi
```

## 3. 反向代理 (Nginx)

```nginx
server {
    listen 443 ssl http2;
    server_name rbi.example.com;

    ssl_certificate     /etc/ssl/rbi.example.com.crt;
    ssl_certificate_key /etc/ssl/rbi.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;

        # WebSocket 长连接超时
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

## 4. 安全加固

### 4.1 生产环境必需

```bash
# 强制认证
WISON_AUTH_TOKEN=<random-64-char-hex>

# 绑定内网接口
WISON_HOST=127.0.0.1     # 仅本地 (配合 Nginx)

# 限制会话数
WISON_MAX_SESSIONS=5

# Production 日志
WISON_LOG_LEVEL=warn
```

### 4.2 推荐

- **HTTPS**: 通过 Nginx/Caddy 反向代理启用 TLS
- **防火墙**: 仅开放 443 端口，8080 仅对 localhost
- **容器沙箱**: 使用 Docker `--security-opt seccomp=chrome.json`
- **/dev/shm**: 确保 `--disable-dev-shm-usage` 或映射 `/dev/shm`

## 5. 监控

### 5.1 健康检查

```bash
curl http://localhost:8080/health
# {"status":"ok","uptime":3600,"sessions":2}
```

### 5.2 Prometheus 指标

```bash
curl http://localhost:8080/metrics
# wison_sessions_active 2
# wison_frames_sent 12345
# wison_bytes_sent 987654321
# wison_errors_total 3
```

### 5.3 日志

```bash
# Docker
docker logs -f wison-rbi | pino-pretty

# systemd
journalctl -u wison-rbi -f

# 直接输出
node index.js 2>&1 | tee /var/log/wison-rbi.log
```

## 6. 扩容

| 策略 | 说明 |
|------|------|
| **垂直扩容** | 增加 WISON_MAX_SESSIONS，配合更多 CPU/内存 |
| **水平扩容** | 多实例 + Nginx upstream (需要 sticky session) |
| **Sticky Session** | 同一客户端必须始终路由到同一实例 (Session 在内存中) |

## 7. 运维 Checklist

- [ ] 设置 WISON_AUTH_TOKEN (随机生成)
- [ ] 配置 Nginx HTTPS 反向代理
- [ ] 限制 WISON_MAX_SESSIONS
- [ ] 监控 /health 端点
- [ ] 配置日志轮转 (Docker: `max-size=10m,max-file=3`)
- [ ] 设置进程监控 (systemd Restart=on-failure)
- [ ] 定期清理 Chromium 缓存 (重启容器)
