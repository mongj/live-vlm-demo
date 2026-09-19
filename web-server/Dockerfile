FROM python:3.12-slim-bookworm

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    LIVE_VLM_HOST=0.0.0.0 \
    LIVE_VLM_PORT=8787 \
    LIVE_VLM_CONFIG=/app/config.toml

COPY pyproject.toml README.md ./
COPY src ./src
COPY config.toml ./config.toml

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir . \
    && sed -i 's#http://127.0.0.1:8070/v1#http://host.docker.internal:8070/v1#' /app/config.toml

EXPOSE 8787

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8787/health', timeout=3)"

CMD ["python", "-m", "live_vlm_server"]
