# intelligence service (Python/FastAPI) — build from REPO ROOT context:
#   docker build -f deploy/docker/intelligence.Dockerfile .
# LLM provider is pure env: LLM_BASE_URL / LLM_MODEL / LLM_API_KEY
# (OpenRouter: https://openrouter.ai/api/v1 + exact model slug + key).
FROM python:3.12-slim
WORKDIR /app
COPY services/intelligence/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY services/intelligence/ ./
ENV PYTHONUNBUFFERED=1
EXPOSE 8791
CMD ["sh", "-c", "uvicorn main:app --host :: --port ${PORT:-8791}"]
