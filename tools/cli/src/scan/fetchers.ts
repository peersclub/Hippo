/**
 * The ONLY module that touches the network. Global fetch, GET only,
 * 5s abort per request, honest User-Agent, redirects followed.
 * Never sends auth, never POSTs — scan is read-only by construction.
 */

export const USER_AGENT = 'hippo-scan/0.1 (+https://hippo.app)'
const TIMEOUT_MS = 5_000

export interface HttpSuccess {
  ok: true
  url: string
  finalUrl: string
  status: number
  contentType: string | null
  headers: Headers
  body: string
}

export interface HttpFailure {
  ok: false
  url: string
  error: string
}

export type FetchResult = HttpSuccess | HttpFailure

export async function fetchUrl(url: string, accept = '*/*'): Promise<FetchResult> {
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'user-agent': USER_AGENT, accept },
    })
    const body = await res.text()
    return {
      ok: true,
      url,
      finalUrl: res.url || url,
      status: res.status,
      contentType: res.headers.get('content-type'),
      headers: res.headers,
      body,
    }
  } catch (err) {
    const error =
      err instanceof Error
        ? err.name === 'TimeoutError'
          ? `timeout after ${TIMEOUT_MS / 1000}s`
          : ((err.cause as Error | undefined)?.message ?? err.message)
        : String(err)
    return { ok: false, url, error }
  }
}

export function fetchHtml(url: string): Promise<FetchResult> {
  return fetchUrl(url, 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5')
}

export function fetchJson(url: string): Promise<FetchResult> {
  return fetchUrl(url, 'application/json')
}
