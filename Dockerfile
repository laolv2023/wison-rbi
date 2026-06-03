FROM python:3.12-slim

LABEL org.opencontainers.image.title="PaintOp Remote Browser"
LABEL org.opencontainers.image.description="Prototype: cc-layer intercept remote browser with WebSocket transport"

# Chromium 依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libdbus-1-3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    fonts-noto-cjk \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Python 依赖
COPY server/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Playwright: 安装 Chromium (仅浏览器，不含系统依赖)
RUN python -m playwright install --with-deps chromium

# 应用代码
COPY server/ ./server/
COPY client/ ./client/
COPY docs/   ./docs/

# 以非 root 运行
RUN useradd -m -s /bin/bash paintop && chown -R paintop:paintop /app
USER paintop

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

CMD ["python", "server/server.py", "--port", "8080", "--host", "0.0.0.0"]
