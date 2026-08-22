import { useCallback, useEffect, useState } from 'preact/hooks'

/** Page-load lifecycle in one hook: loading skeleton → data or ErrorBanner. */
export function useLoad(
  fn: () => Promise<void>,
  deps: unknown[] = [],
): { loading: boolean; error: string; retry: () => void } {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const retry = useCallback(() => {
    setLoading(true)
    setError('')
    fn()
      .catch((e) => setError(e instanceof Error ? e.message : 'request failed'))
      .finally(() => setLoading(false))
  }, deps)
  useEffect(() => {
    retry()
  }, [retry])
  return { loading, error, retry }
}
