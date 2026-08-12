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

// Ejecuta fn sobre items con a lo sumo `limit` llamadas en simultáneo (en vez
// de todas a la vez con Promise.all, o una por una en serie). Devuelve los
// resultados en el mismo orden que items. Usado para mandar los chunks de
// ExecuteMultiCall en paralelo pero acotado -- la propia guía de Geotab
// ("Designing Reliable Integrations") pide "a modest number of independent,
// short reads" en vez de sin límite, para no gatillar rate limiting.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// Variante de mapWithConcurrency para llamadas independientes entre sí donde
// interesa quedarse con lo que sí se llegó a traer si alguna falla a mitad de
// camino (ej. se corta la conexión después de N de M chunks de multiCall):
// onResult(item, index, result) se llama por cada chunk que termina bien, en
// el momento en que termina (no espera a los demás), así el caller puede
// mergear ahí mismo aunque después otro chunk falle. Al final relanza el
// primer error visto (si hubo alguno), para que el caller sepa que el
// resultado es parcial -- pero ya con todo lo que sí se pudo mergear.
async function mapWithConcurrencySettled(items, limit, fn, onResult) {
  let next = 0;
  let firstError = null;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try {
        onResult(items[i], i, await fn(items[i], i));
      } catch (err) {
        if (!firstError) firstError = err;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  if (firstError) throw firstError;
}

// Reintentos con backoff exponencial + jitter, como recomienda la guía de
// integraciones de Geotab ante rate limiting/errores transitorios ("Retry a
// bounded number of times with exponential backoff and jitter"). No hay forma
// de distinguir un HTTP 429 real desde el SDK de Add-Ins (no expone status
// code ni headers, solo el error ya parseado), así que se reintenta cualquier
// error salvo los que matchean RETRY_SKIP_PATTERN -- esos son señales de que
// el problema es la request en sí (mal formada, sin permisos, versión de feed
// vencida), no algo que un reintento vaya a arreglar.
const RETRY_SKIP_PATTERN = /invalid|missing|unauthorized|forbidden|permission|not found|does not exist|malformed|unsupported/i;
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function callWithRetry(fn) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const text = ((err && err.name) || "") + " " + ((err && err.message) || "");
      attempt++;
      if (attempt >= RETRY_MAX_ATTEMPTS || RETRY_SKIP_PATTERN.test(text)) throw err;
      const backoff = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1));
      const jitter = backoff * (0.5 + Math.random() * 0.5); // 50%-100% del backoff, evita reintentos sincronizados
      await sleep(jitter);
    }
  }
}

// Envuelve el `api` que entrega el SDK de Add-Ins para que call()/multiCall()
// reintenten solos ante errores transitorios (rate limiting, timeouts de red,
// picos de carga en flotas grandes) sin que cada caller tenga que saber de
// esto. Se envuelve una sola vez en el entry point del Add-In (ver app.js) y
// se pasa para abajo como si fuera el api original -- misma interfaz.
function withApiRetry(api) {
  return {
    call: (...args) => callWithRetry(() => api.call(...args)),
    multiCall: (...args) => callWithRetry(() => api.multiCall(...args)),
  };
}

// Cache en localStorage para catálogos casi-estáticos (Device, Group, Rule):
// según la guía de Geotab, "cache static entities (Diagnostic, Device, User)
// and refresh every 12-24h" -- evita re-pedir la flota completa en cada click
// de "Analizar"/"Actualizar" cuando ya se pidió hace instantes. Separado por
// base de datos y por los parámetros de búsqueda exactos usados (groupSearch
// scopeado no pisa la cache del listado completo, por ejemplo).
const STATIC_ENTITY_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function staticEntityCacheKey(database, typeName, search) {
  return "geotab_insights_static_" + database + "|" + typeName + "|" + JSON.stringify(search || {});
}

async function cachedGet(api, database, typeName, search, ttlMs) {
  const key = staticEntityCacheKey(database, typeName, search);
  try {
    const raw = JSON.parse(localStorage.getItem(key) || "null");
    if (raw && Date.now() - raw.fetchedAt < (ttlMs || STATIC_ENTITY_CACHE_TTL_MS)) return raw.data;
  } catch (err) {
    // localStorage corrupto/inaccesible: seguimos directo al fetch.
  }
  const data = await api.call("Get", search ? { typeName, search } : { typeName });
  try {
    localStorage.setItem(key, JSON.stringify({ data, fetchedAt: Date.now() }));
  } catch (err) {
    // Cuota de localStorage llena (catálogos muy grandes): no es crítico, seguimos sin cachear.
  }
  return data;
}
