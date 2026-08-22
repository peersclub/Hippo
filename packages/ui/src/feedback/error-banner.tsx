export function ErrorBanner({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <div class="error-banner" role="alert">
      <span>{message}</span>
      {retry && (
        <button type="button" class="btn ghost sm" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  )
}
