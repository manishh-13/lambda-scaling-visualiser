export function formatNumber(value: number, maximumFractionDigits = 0): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits }).format(value)
}

export function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${formatNumber(milliseconds, milliseconds < 10 ? 1 : 0)} ms`
  return `${formatNumber(milliseconds / 1_000, milliseconds < 10_000 ? 2 : 1)} s`
}

export function formatRate(value: number): string {
  return `${formatNumber(value, value < 100 ? 1 : 0)} RPS`
}

export function formatElapsed(milliseconds: number): string {
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} ms`
  return `${(milliseconds / 1_000).toFixed(1)} s`
}
