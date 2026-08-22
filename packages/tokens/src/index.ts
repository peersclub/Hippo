/**
 * Dark Glass Instrument — JS mirror of tokens.css.
 *
 * `darkVars` / `lightVars` are declaration lists (no selector) so the SDK can
 * splice them into `:host{all:initial;…}` AFTER the reset, which is the only
 * constructable-stylesheet shape that survives `all: initial`.
 */

export const dark = {
  bg: '#0E1014',
  panel: '#14161C',
  card: '#232733',
  card2: '#262B36',
  amber: '#F0B94A',
  amberInk: '#1A1405',
  amberRgb: '240,185,74',
  up: '#2EC48D',
  down: '#FF8585',
  upRgb: '46,196,141',
  downRgb: '255,133,133',
  textHi: '#E9EBF0',
  textMid: '#B8BDC9',
  textDim: '#8A8F9C',
  textFaint: '#6A7080',
  hairline: 'rgba(255,255,255,.07)',
  bgRgb: '14,16,20',
} as const

export const light = {
  bg: '#E9ECF1',
  panel: '#F7F8FA',
  card: '#FFFFFF',
  card2: '#F0F2F6',
  amber: '#B98A1E',
  amberInk: '#FFFFFF',
  amberRgb: '185,138,30',
  up: '#149469',
  down: '#D94F4F',
  upRgb: '20,148,105',
  downRgb: '217,79,79',
  textHi: 'rgba(14,18,26,.92)',
  textMid: 'rgba(14,18,26,.62)',
  textDim: 'rgba(14,18,26,.46)',
  textFaint: 'rgba(14,18,26,.42)',
  hairline: 'rgba(12,16,24,.09)',
  bgRgb: '233,236,241',
} as const

export const fonts = {
  display: "'Outfit', system-ui, sans-serif",
  body: "'Inter', system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, monospace",
} as const

export const radius = {
  card: '16px',
  cell: '10px',
  button: '12px',
  pill: '999px',
} as const

type Palette = { [K in keyof typeof dark]: string }

function colorVars(t: Palette): string {
  return [
    `--hippo-bg:${t.bg}`,
    `--hippo-panel:${t.panel}`,
    `--hippo-card:${t.card}`,
    `--hippo-card-2:${t.card2}`,
    `--hippo-amber:${t.amber}`,
    `--hippo-amber-ink:${t.amberInk}`,
    `--hippo-amber-rgb:${t.amberRgb}`,
    `--hippo-up:${t.up}`,
    `--hippo-down:${t.down}`,
    `--hippo-up-rgb:${t.upRgb}`,
    `--hippo-down-rgb:${t.downRgb}`,
    `--hippo-text-hi:${t.textHi}`,
    `--hippo-text-mid:${t.textMid}`,
    `--hippo-text-dim:${t.textDim}`,
    `--hippo-text-faint:${t.textFaint}`,
    `--hippo-hairline:${t.hairline}`,
    `--hippo-bg-rgb:${t.bgRgb}`,
  ].join(';')
}

const typeVars = [
  `--hippo-font-display:${fonts.display}`,
  `--hippo-font-body:${fonts.body}`,
  `--hippo-font-mono:${fonts.mono}`,
  `--hippo-radius-card:${radius.card}`,
  `--hippo-radius-cell:${radius.cell}`,
  `--hippo-radius-button:${radius.button}`,
  `--hippo-radius-pill:${radius.pill}`,
  `--hippo-eyebrow-size:10px`,
  `--hippo-eyebrow-track:0.12em`,
  `--hippo-motion-card-in:0.32s ease`,
  `--hippo-motion-pulse:1.6s infinite`,
].join(';')

/** Dark-core custom properties, no selector — splice into `:host{…}`. */
export const darkVars = `${colorVars(dark)};${typeVars}`

/** Light-core custom properties, no selector — splice into the theme swap. */
export const lightVars = colorVars(light)
