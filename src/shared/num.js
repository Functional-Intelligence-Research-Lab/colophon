// Counts read from a .twff file go into the page as HTML, and a file can be
// crafted by anyone. Only real, finite numbers are let through.
export function finiteNumber(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
