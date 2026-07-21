// Caché local de Trip / ExceptionEvent vía GetFeed, en vez de re-pedir el
// rango de fechas completo con Get() semana a semana en cada "Analizar"
// (dashboard.js hacía eso: N llamadas por consulta, siempre desde cero).
//
// Se mantiene un feed incremental por (base de datos, typeName) en
// IndexedDB: la primera vez trae el histórico desde la fecha pedida
// paginando con GetFeed; las siguientes solo piden lo nuevo/modificado
// desde la versión (fromVersion) guardada, sin importar el rango de fechas.
// Si después se pide un rango más viejo que el ya sembrado, se hace un único
// Get puntual solo para el hueco faltante (sin tocar el cursor del feed).
//
// No se scopea por grupo: es un feed global por tipo, así el filtro de
// grupo elegido en la UI no invalida nada -- se sigue filtrando client-side
// en dashboard.js, igual que ya hacía de backstop antes de este cambio.

const FEED_DB_NAME = "geotab_insights_feed_cache";
const FEED_DB_VERSION = 1;
const FEED_RESULTS_LIMIT = 10000;
const FEED_MAX_AGE_DAYS = 400; // poda: no tiene sentido guardar más que el rango más amplio que se pueda pedir desde la UI

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function getCursor(db, feedKey) {
  return new Promise((resolve, reject) => {
    const req = db.transaction("cursors", "readonly").objectStore("cursors").get(feedKey);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

function putCursor(db, feedKey, toVersion, earliestSeeded) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction("cursors", "readwrite");
    tx.objectStore("cursors").put({ feedKey, toVersion, earliestSeeded, updatedAt: new Date().toISOString() });
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

function getAllRecords(db, feedKey) {
  return new Promise((resolve, reject) => {
    const idx = db.transaction("records", "readonly").objectStore("records").index("by_feed");
    const out = [];
    const req = idx.openCursor(IDBKeyRange.only(feedKey));
    req.onsuccess = ev => {
      const cur = ev.target.result;
      if (cur) { out.push(cur.value.data); cur.continue(); }
      else resolve(out);
    };
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

// Pagina GetFeed hasta agotar el backlog: la 1ra llamada usa `search` (seed)
// o `fromVersion` (catch-up); las siguientes siempre con el fromVersion que
// va devolviendo, hasta que una página venga con menos de resultsLimit.
async function drainFeed(api, db, feedKey, dateField, typeName, search, fromVersion) {
  let version = fromVersion;
  let useSearch = !!search;
  while (true) {
    const params = { typeName, resultsLimit: FEED_RESULTS_LIMIT };
    if (useSearch) params.search = search; else params.fromVersion = version;
    const page = await api.call("GetFeed", params);
    const data = (page && page.data) || [];
    if (data.length) await putRecords(db, feedKey, dateField, data);
    version = page && page.toVersion;
    useSearch = false;
    if (data.length < FEED_RESULTS_LIMIT) break;
  }
  return version;
}

// typeName: "Trip" | "ExceptionEvent". dateField: campo de fecha de ese tipo
// usado para bucketear por semana en dashboard.js ("start" / "activeFrom").
async function fetchFeedRecords(api, database, typeName, dateField, requestedFromDate) {
  const db = await openFeedDb();
  const feedKey = database + "|" + typeName;
  const requestedFromIso = requestedFromDate.toISOString();
  let cursor = await getCursor(db, feedKey);

  try {
    if (!cursor) {
      const toVersion = await drainFeed(api, db, feedKey, dateField, typeName, { fromDate: requestedFromIso });
      await putCursor(db, feedKey, toVersion, requestedFromIso);
    } else {
      let earliestSeeded = cursor.earliestSeeded;
      if (requestedFromIso < earliestSeeded) {
        // Se pidió un rango más viejo que lo ya sembrado: GetFeed no puede
        // "retroceder" con fromVersion, así que este hueco se llena con un
        // Get puntual (no toca el cursor del feed).
        const gap = await api.call("Get", { typeName, search: { fromDate: requestedFromIso, toDate: earliestSeeded } });
        if (gap && gap.length) await putRecords(db, feedKey, dateField, gap);
        earliestSeeded = requestedFromIso;
      }
      const toVersion = await drainFeed(api, db, feedKey, dateField, typeName, null, cursor.toVersion);
      await putCursor(db, feedKey, toVersion, earliestSeeded);
    }
  } catch (err) {
    // fromVersion vencido/inválido u otro error de feed: se descarta el
    // cursor y se reintenta una sola vez sembrando de cero.
    await deleteCursor(db, feedKey);
    if (cursor) return fetchFeedRecords(api, database, typeName, dateField, requestedFromDate);
    throw err;
  }

  // Poda todo lo más viejo que FEED_MAX_AGE_DAYS, pero nunca por debajo de lo
  // recién pedido (evitaría borrar datos que el propio caller sigue necesitando).
  const maxAgeCutoff = new Date(Date.now() - FEED_MAX_AGE_DAYS * 86400000).toISOString();
  const pruneCutoff = maxAgeCutoff < requestedFromIso ? maxAgeCutoff : requestedFromIso;
  await pruneOldRecords(db, feedKey, pruneCutoff);
  // Si se podó más allá de lo que earliestSeeded promete, hay que correr esa
  // marca para adelante: si no, un pedido futuro por ese rango creería que ya
  // está cacheado cuando en realidad se acaba de borrar.
  const cursorAfterPrune = await getCursor(db, feedKey);
  if (cursorAfterPrune && pruneCutoff > cursorAfterPrune.earliestSeeded) {
    await putCursor(db, feedKey, cursorAfterPrune.toVersion, pruneCutoff);
  }

  return getAllRecords(db, feedKey);
}
