# @hippo/ui — SPA kernel

Shared chrome for `apps/admin` and `apps/portal`. **The SDK does not import this package** — thin-client stop-line, Shadow DOM, and the loader size gate.

```
tokens  (@hippo/tokens)     zero-dep --hippo-* values
   │
   ├── sdk/styles.ts        splices darkVars/lightVars into :host{all:initial}
   ├── apps/site            @import tokens.css
   └── @hippo/ui            spa.css + primitives + shell + router + api
          ├── apps/admin
          └── apps/portal
```

## Layout of this package

```
src/
  css/spa.css          console chrome (class-stable: .btn .badge .stat …)
  primitives/          Button Badge Stat — wrap the classes
  feedback/            toast, confirm, Busy, Empty, ErrorBanner, useLoad
  layout/              AppShell, PageHead
  router/hash.ts       createHashRouter(defaultPage)
  api/client.ts        createApi({ identity })
  index.ts
```

Pages may keep `class="btn ghost sm"`; migrate to `<Button variant="ghost" size="sm">` per-file when touching them.

## Why two packages, not one

`@hippo/tokens` has no Preact. The SDK panel is a size-gated ESM chunk injected into a closed shadow root; pulling the SPA kernel in would both bloat the embed and mix trust domains (operator console vs trader surface).
