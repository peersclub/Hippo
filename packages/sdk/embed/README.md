# Hippo mobile embed shell

`mobile.html` is what native WebViews load — iOS (WKWebView), Android
(WebView), React Native (react-native-webview), Flutter (webview_flutter).
A WebView is just a browser, so the entire thin-client contract holds: same
loader, same panel, same server-driven cards, same posture matrix (the narrow
viewport lands on `sheet` → `full` automatically). The shell only adds what a
native container needs: query-string config, auto-open, safe-area padding, and
a unified JS↔native bridge.

Ships beside the bundles: the SDK build copies `embed/` into `dist/`, so on a
CDN it lives at `…/embed/mobile.html` next to `…/loader.js`.

## URL

```
https://cdn.hippo.app/embed/mobile.html
  ?key=pk_yourvenue            required — partner embed key
  &gateway=https://gw.hippo.app  optional — gateway override
  &theme=light                 optional — light lean (default: dark hero)
  &locale=hi                   optional — en | hi | hi-Latn | ar (RTL)
  &open=pill                   optional — keep the pill instead of auto-open
  &loader=/loader.js           optional — loader path override (dev)
```

## Bridge contract

JS → native (`HippoShell.post`), delivered on whichever channel exists:

| Container | Channel |
|---|---|
| iOS WKWebView | `webkit.messageHandlers.hippo.postMessage(obj)` |
| Android WebView | `HippoAndroid.postMessage(json)` via `@JavascriptInterface` |
| React Native | `window.ReactNativeWebView.postMessage(json)` |
| Flutter | `HippoFlutter.postMessage(json)` JavascriptChannel |

Events: `{type:"ready"}` (pill mounted) · `{type:"open"}` (panel opened) ·
plus a forward-compatible relay of any `hippo:event` CustomEvent from
`<hippo-root>` — the execution seam's confirm-surface events (Open Decision
#6) arrive through this without a shell change.

Native → JS (evaluate JavaScript in the WebView):

```js
HippoShell.setTheme('light')  // live token swap, no reload
HippoShell.open()             // open the panel on demand
```

## SDK hooks the shell relies on (loader.ts)

- `data-hippo-open="auto"` — open the panel as soon as it mounts.
- `hippo:open` event on `<hippo-root>` — open on demand from outside the
  closed shadow root.

Both route through the exact same code path as a user's pill tap.
