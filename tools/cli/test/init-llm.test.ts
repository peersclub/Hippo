/**
 * The completion client — hermetic tests with an injected fake fetch. No
 * request ever leaves the process; the availability rule (unconfigured or
 * failing model → null, never a throw) is the contract under test.
 */
import { describe, expect, it } from 'vitest'
import { createLlmClient, llmFromEnv } from '../src/init/llm.js'

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: unknown
}

function fakeFetch(respond: () => Promise<Response>): {
  fetchFn: typeof fetch
  requests: CapturedRequest[]
} {
  const requests: CapturedRequest[] = []
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    requests.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    })
    return respond()
  }) as typeof fetch
  return { fetchFn, requests }
}

const okResponse = (content: unknown): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

describe('llmFromEnv — the availability rule', () => {
  it('returns null when LLM_BASE_URL / LLM_MODEL are not both set', () => {
    expect(llmFromEnv({})).toBeNull()
    expect(llmFromEnv({ LLM_BASE_URL: 'http://localhost:11434/v1' })).toBeNull()
    expect(llmFromEnv({ LLM_MODEL: 'qwen3:4b' })).toBeNull()
  })

  it('builds a client from a complete env', () => {
    const client = llmFromEnv({
      LLM_BASE_URL: 'http://localhost:11434/v1',
      LLM_MODEL: 'qwen3:4b',
    })
    expect(client?.describe()).toBe('qwen3:4b @ http://localhost:11434/v1')
  })
})

describe('createLlmClient.complete', () => {
  it('POSTs an OpenAI-compatible chat completion and returns the content', async () => {
    const { fetchFn, requests } = fakeFetch(async () => okResponse('  the body  '))
    const client = createLlmClient({
      baseUrl: 'http://localhost:11434/v1/',
      model: 'qwen3:4b',
      fetchFn,
    })
    await expect(client.complete('a prompt')).resolves.toBe('the body')
    expect(requests[0]?.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(requests[0]?.body).toMatchObject({
      model: 'qwen3:4b',
      messages: [{ role: 'user', content: 'a prompt' }],
    })
    expect(requests[0]?.headers.Authorization).toBeUndefined()
  })

  it('sends a Bearer token when an API key is configured', async () => {
    const { fetchFn, requests } = fakeFetch(async () => okResponse('x'))
    const client = createLlmClient({
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'deepseek/deepseek-chat',
      apiKey: 'sk-test',
      fetchFn,
    })
    await client.complete('p')
    expect(requests[0]?.headers.Authorization).toBe('Bearer sk-test')
    // OpenRouter attribution header, gated on the host.
    expect(requests[0]?.headers['X-Title']).toBe('Hippo')
  })

  it('returns null on a non-2xx response', async () => {
    const { fetchFn } = fakeFetch(async () => new Response('nope', { status: 503 }))
    const client = createLlmClient({ baseUrl: 'http://x/v1', model: 'm', fetchFn })
    await expect(client.complete('p')).resolves.toBeNull()
  })

  it('returns null when fetch itself throws (network down)', async () => {
    const { fetchFn } = fakeFetch(async () => {
      throw new Error('ECONNREFUSED')
    })
    const client = createLlmClient({ baseUrl: 'http://x/v1', model: 'm', fetchFn })
    await expect(client.complete('p')).resolves.toBeNull()
  })

  it('returns null on an unusable payload (no string content, empty content)', async () => {
    for (const payload of [
      new Response('{}', { status: 200 }),
      new Response('not json', { status: 200 }),
      okResponse(null),
      okResponse('   '),
    ]) {
      const { fetchFn } = fakeFetch(async () => payload)
      const client = createLlmClient({ baseUrl: 'http://x/v1', model: 'm', fetchFn })
      await expect(client.complete('p')).resolves.toBeNull()
    }
  })
})
