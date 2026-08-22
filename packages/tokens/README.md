# @hippo/tokens

The only source of `--hippo-*` values. Zero runtime dependencies.

- `src/tokens.css` — `:root` + `:host` so both document surfaces and the SDK shadow root can adopt it.
- `src/index.ts` — `darkVars` / `lightVars` declaration lists for the SDK's constructable stylesheet (`:host{all:initial;…}` must re-declare tokens AFTER the reset).

The SDK panel may override a handful of values (amber-ink, panel gradient, skeleton). Everything else is this package.
