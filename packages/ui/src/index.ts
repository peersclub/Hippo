/**
 * @hippo/ui — SPA kernel for admin + portal.
 *
 * Import `./spa.css` once at boot. Pages may keep using the existing class
 * names (`.btn`, `.badge`, `.page-head`); primitives wrap those classes so
 * migrations are incremental. The SDK must not import this package.
 */

export { type ApiClient, ApiError, createApi } from './api/client.js'
export { Busy } from './feedback/busy.js'
export { ConfirmHost, confirmAction } from './feedback/confirm.js'
export { Empty } from './feedback/empty.js'
export { ErrorBanner } from './feedback/error-banner.js'
export { Toasts, toast } from './feedback/toast.js'
export { useLoad } from './feedback/use-load.js'
export { AppShell, type NavItem } from './layout/AppShell.js'
export { PageHead } from './layout/PageHead.js'
export { Badge, type BadgeTone } from './primitives/Badge.js'
export { Button, type ButtonSize, type ButtonVariant } from './primitives/Button.js'
export { Stat } from './primitives/Stat.js'
export { createHashRouter, type HashRouter, type Route } from './router/hash.js'
