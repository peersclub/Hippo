/**
 * Minimal OpenAI-compatible completion client for the CLI's model-driven
 * stages (stage-4 mapping synthesis). Mirrors the blessed env contract of
 * services/intelligence/providers.py:
 *
 *   LLM_BASE_URL  e.g. http://localhost:11434/v1 (Ollama), a vLLM /v1, or
 *                 https://openrouter.ai/api/v1
 *   LLM_MODEL     model id on that server
 *   LLM_API_KEY   optional; sent as a Bearer token
 *   LLM_TIMEOUT   seconds, default 30
 *
 * Availability rule (same as the intelligence service): the CLI NEVER fails
 * because the model is unconfigured or down. `llmFromEnv` returns null when
 * LLM_BASE_URL/LLM_MODEL are absent — unlike the service there is no
 * localhost default, so a bare `hippo scan` stays fully deterministic and
 * offline. `complete()` returns null on ANY failure (network, HTTP status,
 * unparseable body, timeout) and never throws; callers fall back to their
 * deterministic output.
 */

export interface LlmClient {
  /** Human-readable target for CLI output, e.g. "qwen3:4b @ http://…/v1". */
  describe(): string
  /** One prompt in, the completion text out; null on any failure. */
  complete(prompt: string): Promise<string | null>
}

export interface LlmClientOptions {
  baseUrl: string
  model: string
  apiKey?: string
  /** Request timeout in milliseconds (default 30s). */
  timeoutMs?: number
  /** Injectable for hermetic tests; defaults to global fetch. */
  fetchFn?: typeof fetch
}

const DEFAULT_TIMEOUT_MS = 30_000

/** Build a client from explicit options (the testable constructor). */
export function createLlmClient(options: LlmClientOptions): LlmClient {
  const baseUrl = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchFn = options.fetchFn ?? fetch

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`
  // OpenRouter attribution (recommended by OpenRouter; harmless elsewhere so
  // we gate on the host — same policy as services/intelligence/providers.py).
  if (baseUrl.includes('openrouter.ai')) {
    headers['X-Title'] = process.env.OPENROUTER_APP_TITLE ?? 'Hippo'
    const referer = process.env.OPENROUTER_APP_URL
    if (referer) headers['HTTP-Referer'] = referer
  }

  return {
    describe: () => `${options.model} @ ${baseUrl}`,
    async complete(prompt: string): Promise<string | null> {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        const res = await fetchFn(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: options.model,
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.2,
            max_tokens: 2000,
          }),
        })
        if (!res.ok) return null
        const data: unknown = await res.json()
        const content = (data as { choices?: Array<{ message?: { content?: unknown } }> })
          ?.choices?.[0]?.message?.content
        if (typeof content !== 'string') return null
        const trimmed = content.trim()
        return trimmed.length > 0 ? trimmed : null
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/**
 * Client from the environment, or null when the model is not configured
 * (missing LLM_BASE_URL or LLM_MODEL) — the deterministic-fallback signal.
 */
export function llmFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  fetchFn: typeof fetch = fetch,
): LlmClient | null {
  const baseUrl = env.LLM_BASE_URL
  const model = env.LLM_MODEL
  if (!baseUrl || !model) return null
  const timeoutSeconds = Number(env.LLM_TIMEOUT ?? '')
  return createLlmClient({
    baseUrl,
    model,
    apiKey: env.LLM_API_KEY,
    timeoutMs:
      Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
        ? timeoutSeconds * 1000
        : DEFAULT_TIMEOUT_MS,
    fetchFn,
  })
}
