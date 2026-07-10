// Helpers chicos compartidos por metrics.js / fuel.js / analyzer.js / dashboard.js.

// Redondeo estilo Python round(value, decimals): evita los errores de
// binario flotante de toFixed en casos como round(1.005, 2).
function round(value, decimals) {
  const factor = Math.pow(10, decimals || 0);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function chunked(items, size) {
  const out = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
