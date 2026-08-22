# 001 — Central UI kernel

**Date:** 2026-08-22
**Status:** accepted
**Branch:** `feat/central-ui-kernel`

See also: [[09 FE Architecture]] · [[Brand Guidelines]] · [[Thin Client Frontend Baseline]]

## Context

Four frontend surfaces (SDK, admin, portal, site) each inlined Dark Glass Instrument tokens. Admin and portal also copy-pasted `ui.tsx`, `styles.css`, `router.ts`, and the fetch client. The copies had already drifted (portal lost `Empty`, defaulted the hash router to `dashboard`, missed several badge/stat rules). Brand guidelines already listed "wire hippo-tokens.css into the SDK" as an open item.

## Decision

Two packages, not one:

1. **`@hippo/tokens`** — zero-dep CSS + JS token values. Consumed by the SDK, the marketing site, and `@hippo/ui`.
2. **`@hippo/ui`** — SPA kernel (chrome CSS, primitives, feedback, `AppShell`, hash router, cookie API client) for admin + portal only.

The SDK must not import `@hippo/ui`. The thin-client stop-line, closed Shadow DOM, and loader size gate make a shared component kit the wrong seam. Shared *values* are the right seam.

Admin/portal pages keep the existing class names (`.btn`, `.badge`) so this is a structural move, not a visual rewrite. Primitives wrap those classes for incremental adoption. Portal's empty-hash route is `overview` (it was silently `dashboard` from the copy).

## Alternatives rejected

- One `@hippo/ui` that the SDK also uses — would bloat the embed and mix operator/trader trust domains.
- Rewriting every page to `<Button>` in the same change — high churn, low leverage; class-stable CSS lets pages migrate when touched.
- Moving types out of `@hippo/stores` (admin pages import `PartnerRecord` from stores, which pulls `pg`) — a real layering bug, separate from the UI kernel.
