// Caché local de datos de MyGeotab en IndexedDB, dos estrategias distintas
// según el tipo:
//
// ExceptionEvent vía GetFeed (fetchFeedRecords/drainFeed): se mantiene un
// feed incremental por (base de datos, regla) -- la primera vez trae el
// histórico desde la fecha pedida paginando con GetFeed; las siguientes solo
// piden lo nuevo/modificado desde la versión (fromVersion) guardada, sin
// importar el rango de fechas. Si después se pide un rango más viejo que el
// ya sembrado, se hace un único Get puntual solo para el hueco faltante (sin
// tocar el cursor del feed). Se pide un feed separado por cada regla mapeada
// (ruleSearch, con su propio cursor): sin esto, cada feed trae TODOS los
// eventos de excepción de la flota (incluidas reglas no mapeadas), que son
// la mayoría del volumen y se descartan igual client-side.
//
// Distancia/horas de manejo/ralentí (fetchDeviceActivitySummary) vía
// GetReportData/DeviceActivitySummary: NO es un método soportado
// oficialmente por Geotab ("GetReportData is not available or supported
// using the API", confirmado en la comunidad de Geotab) -- es lo que usa
// internamente la UI web de reportes. Se usa a propósito, asumiendo que
// Geotab podría cambiarlo o romperlo sin aviso (la alternativa "soportada",
// GetReportJson, es aparentemente asíncrona y no se investigó todavía). A
// cambio, evita traer y sumar cada Trip individual: Geotab ya devuelve la
// distancia/horas agregadas por vehículo por día.
//
// Sin fromVersion no hay forma de pedir "solo lo nuevo", así que cada rango
// de fechas se pide completo -- pero se cachea en range_cache por rango
// exacto (ver RANGE_CACHE_TTL_MS), para no repetir la llamada si se
// re-analiza el mismo rango poco después (ej. "Actualizar" tras guardar un
// ajuste). Un rango de fechas distinto (ej. un día más tarde, con la
// ventana rodante corrida) no pega en el cache y se vuelve a pedir completo.
//
// Ninguno de los dos (ExceptionEvent, DeviceActivitySummary) se scopea por
// grupo: son globales, así el filtro de grupo elegido en la UI no invalida
// nada -- se sigue filtrando client-side en dashboard.js.

const FEED_DB_NAME = "geotab_insights_feed_cache";
const FEED_DB_VERSION = 2;
// Confirmado contra la API real: sin resultsLimit explícito, Geotab devuelve
// páginas chicas por default (12, 4 registros...) en vez de su máximo real --
// omitirlo NO destraba un tope mayor, al revés de lo que asumíamos antes. Se
// pide explícito el máximo real de Get/GetFeed (50000, confirmado para Trip)
// para que, cuando SÍ hay backlog grande, entre en menos llamadas. drainFeed
// igual no depende de este número para saber cuándo cortar (corta por página
// vacía, ver abajo) -- así que si algún tipo tiene un tope real menor a este,
// Geotab lo va a aplicar igual sin que rompa nada acá.
const FEED_RESULTS_LIMIT = 50000;
const FEED_MAX_AGE_DAYS = 400; // poda: no tiene sentido guardar más que el rango más amplio que se pueda pedir desde la UI
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // no podar (scan completo del feed) más de 1 vez por día

// GetFeed tiene su propio límite de tasa en MyGeotab, aparte del resto de la
// API: 60 llamadas por minuto (con overrides según el tipo de entidad). Con
// varias reglas mapeadas, dashboard.js pide un feed de ExceptionEvent por
// regla en paralelo (además del feed de Trip) -- sin control, eso dispara
// más de 60 GetFeed en el primer minuto y Geotab tira OverLimitException.
// Este limitador de ventana deslizante se comparte entre TODAS las llamadas
// a GetFeed de la sesión (sin importar desde qué feed/regla salen) para que
// nunca se superen GETFEED_RATE_LIMIT llamadas en GETFEED_WINDOW_MS, puesto
// bien por debajo del límite real para dejar margen a jitter/reintentos.
const GETFEED_RATE_LIMIT = 50;
const GETFEED_WINDOW_MS = 60000;
let getFeedCallTimestamps = [];

async function reserveGetFeedSlot() {
  while (true) {
    const now = Date.now();
    getFeedCallTimestamps = getFeedCallTimestamps.filter(t => now - t < GETFEED_WINDOW_MS);
    if (getFeedCallTimestamps.length < GETFEED_RATE_LIMIT) {
      getFeedCallTimestamps.push(now);
      return;
    }
    // Esperamos a que salga de la ventana la llamada más vieja de las registradas.
    const waitMs = GETFEED_WINDOW_MS - (now - getFeedCallTimestamps[0]) + 50;
    await sleep(Math.max(waitMs, 50));
  }
}

async function callGetFeed(api, params) {
  await reserveGetFeedSlot();
  return api.call("GetFeed", params);
}

function openFeedDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FEED_DB_NAME, FEED_DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("records")) {
        const store = db.createObjectStore("records", { keyPath: "_key" });
        store.createIndex("by_feed", "_feed", { unique: false });
      }
      if (!db.objectStoreNames.contains("cursors")) {
        db.createObjectStore("cursors", { keyPath: "feedKey" });
      }
      // v2: cache simple por rango exacto de fechas (fetchDeviceActivitySummary),
      // sin cursor incremental -- no hay fromVersion para pedir "solo lo
      // nuevo"; esto evita repetir la llamada completa si se re-analiza el
      // mismo rango (ej. "Actualizar" después de guardar un ajuste).
      if (!db.objectStoreNames.contains("range_cache")) {
        db.createObjectStore("range_cache", { keyPath: "_key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function rangeCacheKey(database, typeName, fromIso, toIso) {
  return database + "|" + typeName + "|" + fromIso + "|" + toIso;
}

function getRangeCache(db, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction("range_cache", "readonly").objectStore("range_cache").get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function putRangeCache(db, key, records) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("range_cache", "readwrite");
    tx.objectStore("range_cache").put({ _key: key, records, fetchedAt: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function getCursor(db, feedKey) {
  return new Promise((resolve, reject) => {
    const req = db.transaction("cursors", "readonly").objectStore("cursors").get(feedKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// lastPrunedAt: cuándo se corrió pruneOldRecords por última vez para este
// feed (null si nunca) -- se guarda acá para no tener que podar (scan
// completo del feed) en cada "Analizar", ver PRUNE_INTERVAL_MS más abajo.
// Los callers que no tocan la poda pasan el valor ya existente (cursor.lastPrunedAt)
// para no perderlo: put() reemplaza el registro entero, no lo mergea.
function putCursor(db, feedKey, toVersion, earliestSeeded, lastPrunedAt) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("cursors", "readwrite");
    tx.objectStore("cursors").put({
      feedKey, toVersion, earliestSeeded,
      lastPrunedAt: lastPrunedAt || null,
      updatedAt: new Date().toISOString(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function deleteCursor(db, feedKey) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("cursors", "readwrite");
    tx.objectStore("cursors").delete(feedKey);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function putRecords(db, feedKey, dateField, records) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("records", "readwrite");
    const store = tx.objectStore("records");
    for (const r of records) {
      if (!r.id) continue;
      // put() pisa el registro anterior con la misma key: así se resuelven
      // las actualizaciones que GetFeed puede devolver para un id ya visto.
      store.put({ _key: feedKey + "|" + r.id, _feed: feedKey, _date: r[dateField] || null, data: r });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// getAll() en vez de cursor manual (openCursor + continue() registro por
// registro): para un feed grande (ej. Trip de una flota de miles de
// vehículos, cientos de miles de registros cacheados) getAll() es una sola
// operación bulk en vez de N round-trips async, uno por registro.
function getAllRecords(db, feedKey) {
  return new Promise((resolve, reject) => {
    const idx = db.transaction("records", "readonly").objectStore("records").index("by_feed");
    const req = idx.getAll(IDBKeyRange.only(feedKey));
    req.onsuccess = () => resolve(req.result.map(r => r.data));
    req.onerror = () => reject(req.error);
  });
}

function pruneOldRecords(db, feedKey, cutoffIso) {
  return new Promise((resolve, reject) => {
    const idx = db.transaction("records", "readwrite").objectStore("records").index("by_feed");
    const req = idx.openCursor(IDBKeyRange.only(feedKey));
    req.onsuccess = ev => {
      const cur = ev.target.result;
      if (!cur) { resolve(); return; }
      if (cur.value._date && cur.value._date < cutoffIso) cur.delete();
      cur.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

// Pagina GetFeed hasta agotar el backlog. scopeSearch (ej. {ruleSearch:{id}})
// se manda en TODAS las páginas, seed y catch-up, para que el alcance del
// feed no cambie a mitad de camino -- solo fromDate va nada más que en la
// primera (define desde cuándo arranca el historial, no el alcance).
async function drainFeed(api, db, feedKey, dateField, typeName, scopeSearch, seedFromDate, fromVersion) {
  let version = fromVersion;
  let first = true;
  while (true) {
    const params = { typeName };
    if (FEED_RESULTS_LIMIT != null) params.resultsLimit = FEED_RESULTS_LIMIT;
    const search = { ...(scopeSearch || {}) };
    if (first && seedFromDate) search.fromDate = seedFromDate;
    if (Object.keys(search).length) params.search = search;
    if (version) params.fromVersion = version;
    const page = await callGetFeed(api, params);
    const data = (page && page.data) || [];
    if (data.length) await putRecords(db, feedKey, dateField, data);
    version = page && page.toVersion;
    first = false;
    // Página vacía = no hay más backlog. No comparamos contra el resultsLimit
    // pedido: si Geotab aplica un tope propio menor (overrides por tipo de
    // entidad), una página completa podría volver con menos de lo pedido y
    // esa comparación cortaría el drenado antes de tiempo, truncando en
    // silencio -- el mismo bug que ya se corrigió una vez para FuelUsed.
    if (!data.length) break;
  }
  return version;
}

// typeName: "ExceptionEvent" en la práctica (la distancia/horas de manejo
// usa fetchDeviceActivitySummary, más abajo, no esto). dateField: campo de
// fecha de ese tipo, usado para
// bucketear por semana en dashboard.js ("activeFrom"). scope: opcional,
// { key, search } -- ej. { key: ruleId, search: { ruleSearch: { id: ruleId } } }
// para pedir el feed de una sola regla en vez del feed global del tipo.
async function fetchFeedRecords(api, database, typeName, dateField, requestedFromDate, scope) {
  const db = await openFeedDb();
  const feedKey = database + "|" + typeName + (scope ? "|" + scope.key : "");
  const scopeSearch = scope ? scope.search : null;
  const requestedFromIso = requestedFromDate.toISOString();
  let cursor = await getCursor(db, feedKey);

  try {
    if (!cursor) {
      const toVersion = await drainFeed(api, db, feedKey, dateField, typeName, scopeSearch, requestedFromIso, null);
      await putCursor(db, feedKey, toVersion, requestedFromIso, null);
    } else {
      let earliestSeeded = cursor.earliestSeeded;
      if (requestedFromIso < earliestSeeded) {
        // Se pidió un rango más viejo que lo ya sembrado: GetFeed no puede
        // "retroceder" con fromVersion, así que este hueco se llena con un
        // Get puntual (no toca el cursor del feed).
        const gapSearch = { ...(scopeSearch || {}), fromDate: requestedFromIso, toDate: earliestSeeded };
        const gap = await api.call("Get", { typeName, search: gapSearch });
        if (gap && gap.length) await putRecords(db, feedKey, dateField, gap);
        earliestSeeded = requestedFromIso;
      }
      const toVersion = await drainFeed(api, db, feedKey, dateField, typeName, scopeSearch, null, cursor.toVersion);
      // lastPrunedAt no se toca acá: se preserva el que ya tenía el cursor.
      await putCursor(db, feedKey, toVersion, earliestSeeded, cursor.lastPrunedAt);
    }
  } catch (err) {
    // fromVersion vencido/inválido u otro error de feed: se descarta el
    // cursor y se reintenta una sola vez sembrando de cero.
    await deleteCursor(db, feedKey);
    if (cursor) return fetchFeedRecords(api, database, typeName, dateField, requestedFromDate, scope);
    throw err;
  }

  // Podar es un recorrido completo del feed (pruneOldRecords cursorea TODOS
  // sus registros para chequear la fecha de cada uno): no tiene sentido
  // pagarlo en cada "Analizar" si ya se podó hace poco. Antes se corría
  // siempre, sumando un scan completo de IndexedDB en cada click aunque no
  // hubiera nada para borrar -- con un feed grande (ej. Trip de una flota
  // grande) esto era buena parte de la demora.
  const cursorNow = await getCursor(db, feedKey);
  const shouldPrune = cursorNow && (!cursorNow.lastPrunedAt
    || Date.now() - new Date(cursorNow.lastPrunedAt).getTime() >= PRUNE_INTERVAL_MS);
  if (shouldPrune) {
    // Poda todo lo más viejo que FEED_MAX_AGE_DAYS, pero nunca por debajo de
    // lo recién pedido (evitaría borrar datos que el propio caller sigue necesitando).
    const maxAgeCutoff = new Date(Date.now() - FEED_MAX_AGE_DAYS * 86400000).toISOString();
    const pruneCutoff = maxAgeCutoff < requestedFromIso ? maxAgeCutoff : requestedFromIso;
    await pruneOldRecords(db, feedKey, pruneCutoff);
    // Si se podó más allá de lo que earliestSeeded promete, hay que correr esa
    // marca para adelante: si no, un pedido futuro por ese rango creería que ya
    // está cacheado cuando en realidad se acaba de borrar.
    const earliestSeeded = pruneCutoff > cursorNow.earliestSeeded ? pruneCutoff : cursorNow.earliestSeeded;
    await putCursor(db, feedKey, cursorNow.toVersion, earliestSeeded, new Date().toISOString());
  }

  return getAllRecords(db, feedKey);
}

// GetFeed no aplica acá a propósito: se usa Get con fetchGetPaginated
// (utils.js), sin deviceSearch -- nunca 1 llamada por vehículo. TTL corto en
// vez de cache indefinido: el rango pedido normalmente incluye "hoy", cuyos
// trips todavía pueden estar llegando durante el día, así que no conviene
// confiar en una respuesta vieja por mucho tiempo -- pero sí evita repetir
// la llamada completa si se re-analiza el mismo rango exacto en los minutos
// siguientes (ej. tras guardar un ajuste, que dispara runAnalysis de nuevo).
const RANGE_CACHE_TTL_MS = 20 * 60 * 1000;

// reportSubGroup "Daily" (no "Weekly") a propósito: así el bucketeo por
// semana lo controla dashboard.js (aggregateActivityByWeek) contra sus
// propios weekWindows, sin depender de que el agrupamiento semanal interno
// de Geotab esté alineado a esos mismos límites (lunes UTC).
//
// groups: [{id: "GroupCompanyId"}] -- toda la flota, sin scope de grupo (el
// filtro de grupo elegido en la UI se aplica client-side en dashboard.js,
// igual que con ExceptionEvent/Trip antes).
async function fetchDeviceActivitySummary(api, database, fromDate, toDate) {
  const db = await openFeedDb();
  const key = rangeCacheKey(database, "DeviceActivitySummary", fromDate.toISOString(), toDate.toISOString());

  const cached = await getRangeCache(db, key);
  if (cached && Date.now() - cached.fetchedAt < RANGE_CACHE_TTL_MS) return cached.records;

  const rows = await api.call("GetReportData", {
    argument: {
      fromUtc: fromDate.toISOString(),
      toUtc: toDate.toISOString(),
      devices: [],
      groupLevel: -1,
      groups: [{ id: "GroupCompanyId" }],
      includeHistoricData: false,
      includeZeroDistanceTrips: false,
      minCustomerStopDuration: "00:00:00.000",
      reportArgumentType: "DeviceActivitySummary",
      reportSubGroup: "Daily",
    },
  });
  const records = rows || [];
  await putRangeCache(db, key, records);
  return records;
}
