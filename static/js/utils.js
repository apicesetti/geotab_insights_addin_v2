// Helpers chicos compartidos por metrics.js / fuel.js / analyzer.js / dashboard.js.

// Redondeo estilo Python round(value, decimals): evita los errores de
// binario flotante de toFixed en casos como round(1.005, 2).
function round(value, decimals) {
  const factor = Math.pow(10, decimals || 0);
  return Math.round((value + Number.EPSILON) * factor) / factor;
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
// OverLimitException (cuota de llamadas por minuto excedida, ej. GetFeed:
// "60 per 1m"): un backoff exponencial normal (tope 8s) no sirve porque el
// límite es por ventana de 1 minuto -- para cuando termina de reintentar
// sigue adentro de la misma ventana. Estos matchean tanto err.name ("Over
// LimitException") como el texto del mensaje que devuelve Geotab.
const RETRY_RATE_LIMIT_PATTERN = /overlimit|quota exceeded|maximum admitted|too many requests/i;
const RETRY_MAX_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 8000;
const RETRY_RATE_LIMIT_MAX_ATTEMPTS = 2;
const RETRY_RATE_LIMIT_DELAY_MS = 65000; // > 1 minuto: asegura que la ventana del límite ya rotó

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errorText(err) {
  const dataType = err && err.data && err.data.type;
  return [err && err.name, err && err.message, dataType].filter(Boolean).join(" ");
}

async function callWithRetry(fn) {
  let attempt = 0;
  let rateLimitAttempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      const text = errorText(err);
      if (RETRY_RATE_LIMIT_PATTERN.test(text)) {
        rateLimitAttempt++;
        if (rateLimitAttempt > RETRY_RATE_LIMIT_MAX_ATTEMPTS) throw err;
        await sleep(RETRY_RATE_LIMIT_DELAY_MS + Math.random() * 5000);
        continue;
      }
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
