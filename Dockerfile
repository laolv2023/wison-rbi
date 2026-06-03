FROM node:20-slim

LABEL org.opencontainers.image.title="Wison-RBI Server"
LABEL org.opencontainers.image.description="Compositor-layer browser isolation"

# Chromium 运行时依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 libnspr4 libdbus-1-3 libatk1.0-0 libatk-bridge2.0-0 \
    libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
    libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 \
    libasound2 libatspi2.0-0 fonts-noto-cjk curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 安装依赖 (利用 Docker 缓存层)
COPY package.json package-lock.json* ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/server/package.json packages/server/
RUN npm install --omit=dev

# Playwright: 安装 Chromium
RUN npx playwright install --with-deps chromium

# 复制应用代码
COPY . .

# 以非 root 运行
RUN useradd -m -s /bin/bash wison && chown -R wison:wison /app
USER wison

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["node", "packages/server/src/index.js"]
