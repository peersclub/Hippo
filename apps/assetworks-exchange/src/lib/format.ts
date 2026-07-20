export const fmt = (n: number, d = 2) =>
  Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
export const fmtPx = (n: number) => (n >= 1000 ? fmt(n, 2) : fmt(n, 4))
export const fmtSigned = (n: number, d = 2) => `${n >= 0 ? "+" : "−"}${fmt(Math.abs(n), d)}`
