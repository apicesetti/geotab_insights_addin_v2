// Orquesta las llamadas a la API de MyGeotab (vía el objeto `api` que el SDK
// de Add-Ins ya deja autenticado contra la base de datos actual) y arma el
// mismo objeto que consume la UI. Port 1:1 de app.py (fetch_dashboard_data +
// helpers de fechas), pero corriendo en el browser: sin backend, sin
// credenciales, sin CORS.

const EXCLUDED_SERIAL_NUMBERS = new Set(["", "000-000-0000"]);
const WEEKS_DEFAULT = 12;

// StatusData con fromDate == toDate solo resuelve al "último valor conocido a
// esa fecha" (snapshot) cuando el search incluye deviceSearch -- confirmado
// contra la API real: sin device explícito el array vuelve vacío, así que a
// diferencia de ExceptionEvent/Trip no hay forma de pedir el snapshot de toda
// la flota en 1 sola llamada. Se arma 1 Get por vehículo, agrupadas en
// multiCall (chunked).
const FUEL_MULTICALL_CHUNK_SIZE = 200;

// ExecuteMultiCall tiene su propia cuota, aparte de la del resto de la API:
// 1500 sub-calls por minuto (no importa cuántas llamadas HTTP a multiCall se
// hagan -- lo que cuenta es la cantidad total de sub-calls empaquetadas
// adentro). fetchFuelDiagnosticSnapshot puede necesitar miles de sub-calls en
// una sola pasada (1 por vehículo, por cada borde de semana), así que se
// comparte este limitador de ventana deslizante entre TODAS las llamadas a
// multiCall de la sesión -- mismo patrón que GETFEED_RATE_LIMIT en feed.js.
const MULTICALL_SUBCALL_RATE_LIMIT = 1400;
const MULTICALL_WINDOW_MS = 60000;
let multiCallSubcallLog = []; // [{t, n}]

async function reserveMultiCallSubcalls(n) {
  while (true) {
    const now = Date.now();
    multiCallSubcallLog = multiCallSubcallLog.filter(entry => now - entry.t < MULTICALL_WINDOW_MS);
    const used = multiCallSubcallLog.reduce((sum, entry) => sum + entry.n, 0);
    if (used + n <= MULTICALL_SUBCALL_RATE_LIMIT) {
      multiCallSubcallLog.push({ t: now, n });
      return;
    }
    const oldestT = multiCallSubcallLog.length ? multiCallSubcallLog[0].t : now;
    const waitMs = MULTICALL_WINDOW_MS - (now - oldestT) + 50;
    await sleep(Math.max(waitMs, 50));
  }
}

async function callMultiCall(api, calls) {
  await reserveMultiCallSubcalls(calls.length);
  return api.multiCall(calls);
}

// Antes vivían en config.json > scoring, compartidas por todas las bases de
// datos (no hay UI para editarlas, son constantes de tuning del modelo).
const SCORING_WEIGHTS = { safety: 0.4, efficiency: 0.3, utilization: 0.3 };
const RULE_CATEGORY_WEIGHTS = {
  velocidad: 1.5, frenado_brusco: 1.3, aceleracion_brusca: 1.2,
  cinturon: 1.0, distraccion: 1.4, ralenti: 0.8, otro: 0.8,
  colision_frontal: 1.6, frotado_ojos: 1.3, fatiga: 1.5,
  bostezo: 1.3, salida_carril: 1.4,
};
const EFFICIENCY_IDLE_PENALTY_FACTOR = 1;
const TREND_CHANGE_THRESHOLD_PCT = 10;

function startOfUtcDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 86400000);
}

// Últimas WEEKS_DEFAULT semanas terminando hoy, alineadas a inicio de semana
// (lunes UTC) igual que el default anterior en Python.
function defaultDateRangeUtc(weeks) {
  const today = startOfUtcDay(new Date());
  const toDate = addDays(today, 1);
  const weekday = (today.getUTCDay() + 6) % 7; // getUTCDay(): Dom=0..Sáb=6 -> Lun=0..Dom=6
  const currentWeekStart = addDays(today, -weekday);
  const fromDate = addDays(currentWeekStart, -7 * (weeks - 1));
  return { fromDate, toDate };
}

// fromDateStr/toDateStr: "YYYY-MM-DD" o null (usa defaultDateRangeUtc).
function resolveDateRange(fromDateStr, toDateStr) {
  if (fromDateStr && toDateStr) {
    const fromDate = new Date(fromDateStr + "T00:00:00Z");
    const toDate = addDays(new Date(toDateStr + "T00:00:00Z"), 1);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime()) || fromDate >= toDate) {
      throw new Error("El rango de fechas no es válido.");
    }
    return { fromDate, toDate };
  }
  return defaultDateRangeUtc(WEEKS_DEFAULT);
}

function buildWeekWindowsForRange(fromDate, toDate) {
  const windows = [];
  let weekStart = fromDate;
  while (weekStart < toDate) {
    const weekEnd = new Date(Math.min(weekStart.getTime() + 7 * 86400000, toDate.getTime()));
    windows.push([weekStart, weekEnd]);
    weekStart = weekEnd;
  }
  return windows;
}

// Índice de weekWindows al que pertenece una fecha ISO, o -1 si cae fuera de
// rango. Usado por computeWeeklyEstimatedIdleLiters (fuel.js) para acumular
// por semana la parte de ralentí estimada por horas (vehículos sin medición
// real vía diagnóstico), a partir de ExceptionEvent individuales.
function weekIndexForIso(weekWindows, iso) {
  if (!iso) return -1;
  for (let i = 0; i < weekWindows.length; i++) {
    const [weekStart, weekEnd] = weekWindows[i];
    if (iso >= weekStart.toISOString() && iso < weekEnd.toISOString()) return i;
  }
  return -1;
}

// Reglas disponibles para el panel de mapeo (excluye ZoneStop, que no aporta
// nada como categoría de infracción).
async function fetchRules(api, database) {
  const rules = await cachedGet(api, database, "Rule");
  return rules
    .filter(r => r.id && r.baseType !== "ZoneStop")
    .map(r => ({ id: r.id, name: r.name || r.id }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "es"));
}

async function fetchGroupTree(api, database) {
  const groups = await cachedGet(api, database, "Group");
  return buildGroupTree(groups);
}

// {device_id: valor} de un diagnóstico contador acumulado (StatusData) "a la
// fecha" (snapshot), para toda la flota en 1 ronda de multiCall (chunked).
// Geotab resuelve fromDate == toDate como el último valor conocido a esa
// fecha en vez de un rango, pero solo cuando el search incluye deviceSearch
// -- sin device explícito el array vuelve vacío, así que a diferencia de
// ExceptionEvent/Trip no hay forma de scopear ancho en 1 sola llamada acá.
async function fetchFuelDiagnosticSnapshot(api, deviceIdsList, diagnosticId, atDate) {
  const atIso = atDate.toISOString();
  const calls = deviceIdsList.map(deviceId => ["Get", {
    typeName: "StatusData",
    search: {
      fromDate: atIso, toDate: atIso,
      diagnosticSearch: { id: diagnosticId },
      deviceSearch: { id: deviceId },
    },
  }]);
  const values = {};
  const callChunks = chunked(calls, FUEL_MULTICALL_CHUNK_SIZE);
  const deviceChunks = chunked(deviceIdsList, FUEL_MULTICALL_CHUNK_SIZE);
  // Secuencial a propósito: el límite real acá es la cuota compartida de
  // sub-calls de multiCall (reserveMultiCallSubcalls), no la latencia de red
  // de cada chunk -- despachar en paralelo no acelera nada una vez que se
  // llena la ventana, solo suma complejidad.
  for (let c = 0; c < callChunks.length; c++) {
    const chunkResults = await callMultiCall(api, callChunks[c]);
    deviceChunks[c].forEach((deviceId, i) => {
      const rec = (chunkResults[i] || [])[0];
      if (rec && rec.data != null) values[deviceId] = Number(rec.data);
    });
  }
  return values;
}

// {device_id: [{dateTime, data}, ...]} de un diagnóstico para toda la flota
// en el período. fetchGetRangeRecursive (utils.js) hace 1 sola llamada Get
// sin deviceSearch para todo el rango -- devuelve los registros de todos los
// vehículos juntos, sin multiCall ni 1 llamada por vehículo -- partiendo el
// rango de fechas al medio solo si hace falta (respuesta al tope de
// resultsLimit, posible truncamiento).
async function fetchFuelDiagnosticRange(api, diagnosticId, periodStart, periodEnd) {
  const records = await fetchGetRangeRecursive(api, "StatusData", { diagnosticSearch: { id: diagnosticId } }, periodStart, periodEnd, 0);
  const seriesByDevice = {};
  for (const r of records) {
    const deviceId = (r.device || {}).id;
    if (!deviceId || r.data == null || !r.dateTime) continue;
    (seriesByDevice[deviceId] = seriesByDevice[deviceId] || []).push(r);
  }
  for (const list of Object.values(seriesByDevice)) list.sort((a, b) => (a.dateTime < b.dateTime ? -1 : 1));
  return seriesByDevice;
}

// Último valor conocido a atIso ("snapshot"), buscado en memoria sobre una
// serie ya ordenada por dateTime -- mismo significado que
// fetchFuelDiagnosticSnapshot, pero sin pedirle nada nuevo a la API.
function snapshotFromSeriesAt(seriesByDevice, atIso) {
  const values = {};
  for (const [deviceId, records] of Object.entries(seriesByDevice)) {
    let last = null;
    for (const r of records) {
      if (r.dateTime > atIso) break;
      last = r;
    }
    if (last) values[deviceId] = Number(last.data);
  }
  return values;
}

// {device_id: litros} a partir de un diagnóstico contador acumulado (StatusData),
// comparando su valor "a la fecha" al inicio y al fin del período en vez de traer
// y acumular todo el historial de registros del período -- mucho más liviano, y
// sin el riesgo de truncamiento silencioso de Geotab en diagnósticos de
// muestreo muy frecuente (fuel total, idle fuel). Usado tanto para ralentí
// (IDLE_FUEL_STATUS_DIAGNOSTIC_ID) como para combustible total
// (TOTAL_FUEL_STATUS_DIAGNOSTIC_ID) -- única fuente de combustible, no se usa FuelUsed.
// weekWindows: si se pasa, además arma la serie semanal de flota (litros por
// semana) para las proyecciones -- devuelve { byDevice, weekly }.
async function fetchFuelDiagnosticDelta(api, devicesById, diagnosticId, periodStart, periodEnd, weekWindows) {
  const deviceIdsList = Object.keys(devicesById);
  const boundaries = weekWindows
    ? [weekWindows[0][0], ...weekWindows.map(([, weekEnd]) => weekEnd)]
    : [periodStart, periodEnd];

  // El primer borde (arranque del período) necesita el snapshot puntual real
  // (fromDate == toDate solo resuelve "último valor conocido" con
  // deviceSearch -- sigue siendo 1 Get por vehículo vía multiCall). El resto
  // del rango (fin de cada semana, incluido el fin del período) se trae en 1
  // sola tanda SIN deviceSearch -- a diferencia del snapshot puntual, un
  // rango real sí devuelve todos los vehículos juntos, así que no hace falta
  // multiCall para esto.
  const [firstSnapshot, seriesByDeviceRaw] = await Promise.all([
    fetchFuelDiagnosticSnapshot(api, deviceIdsList, diagnosticId, boundaries[0]),
    fetchFuelDiagnosticRange(api, diagnosticId, periodStart, periodEnd),
  ]);

  // fetchFuelDiagnosticRange no está scopeada por device (no tiene forma de
  // estarlo sin multiCall): puede traer vehículos fuera del filtro de grupo
  // elegido en la UI, así que se filtra acá contra devicesById.
  const seriesByDevice = {};
  for (const [deviceId, records] of Object.entries(seriesByDeviceRaw)) {
    if (devicesById[deviceId] !== undefined) seriesByDevice[deviceId] = records;
  }

  // Si el snapshot puntual de periodStart vino vacío para algún vehículo (su
  // historial de este diagnóstico no llega tan atrás, o Geotab no resuelve
  // "último valor conocido" más allá de cierta ventana), NO lo descartamos:
  // computeFuelDeltaFromSnapshots exige un valor de arranque para cada
  // vehículo, así que un solo vehículo sin snapshot en periodStart no debería
  // tirar abajo el cálculo -- pero tampoco queremos perder al vehículo. Se usa
  // el primer registro que sí tenemos dentro del rango ya traído como
  // arranque: subestima apenas ese vehículo puntual (no ve consumo anterior a
  // ese primer registro), pero es mejor que perder el vehículo entero -- y
  // mucho mejor que perder LA FLOTA ENTERA si esto le pasa a todos.
  for (const [deviceId, records] of Object.entries(seriesByDevice)) {
    if (firstSnapshot[deviceId] == null && records.length) {
      firstSnapshot[deviceId] = Number(records[0].data);
    }
  }

  const restBoundaries = boundaries.slice(1);
  const restSnapshots = restBoundaries.map(atDate => snapshotFromSeriesAt(seriesByDevice, atDate.toISOString()));

  const snapshots = [firstSnapshot, ...restSnapshots];
  const byDevice = computeFuelDeltaFromSnapshots(snapshots[0], snapshots[snapshots.length - 1]);
  const weekly = weekWindows ? computeWeeklyFuelDeltaFromSnapshots(snapshots) : null;
  return { byDevice, weekly };
}

// params: { database, fromDate, toDate, ruleMapping, groupFilterId, dbSettings }
async function buildDashboardData(api, params) {
  const { database, fromDate, toDate, ruleMapping, groupFilterId, dbSettings } = params;

  // Group/Device/Rule cambian poco entre un "Analizar" y el siguiente: se
  // cachean 12h en localStorage (ver cachedGet en utils.js), como recomienda
  // la guía de Geotab para catálogos casi-estáticos.
  const groups = await cachedGet(api, database, "Group");
  const groupsById = {};
  const groupNamesById = {};
  for (const g of groups) {
    groupsById[g.id] = g;
    groupNamesById[g.id] = g.name || "";
  }

  const scopedGroupIds = groupFilterId ? resolveGroupAndDescendants(groupFilterId, groupsById) : null;
  const groupSearch = scopedGroupIds ? { groups: [...scopedGroupIds].map(id => ({ id })) } : undefined;

  let devices = await cachedGet(api, database, "Device", groupSearch);
  devices = devices.filter(d => !EXCLUDED_SERIAL_NUMBERS.has((d.serialNumber || "").trim()));
  if (scopedGroupIds) {
    devices = devices.filter(d => (d.groups || []).some(g => scopedGroupIds.has(typeof g === "object" ? g.id : g)));
  }
  const devicesById = {};
  for (const d of devices) devicesById[d.id] = d.name || d.id;
  const totalDeviceCount = devices.length;

  const rules = await cachedGet(api, database, "Rule");
  const rulesById = {};
  for (const r of rules) rulesById[r.id] = r.name || "";

  const vehicleClassByDevice = {};
  for (const d of devices) vehicleClassByDevice[d.id] = classifyVehicleClass(d.groups, groupNamesById);

  const weekWindows = buildWeekWindowsForRange(fromDate, toDate);

  // Trip: Get por rango de fechas (fetchTripRecords en feed.js), sin
  // deviceSearch -- nunca 1 llamada por vehículo, Geotab devuelve los
  // registros de toda la flota juntos. Cacheado por rango exacto con TTL
  // corto (evita repetir la llamada si se re-analiza el mismo rango poco
  // después), pero sin cursor incremental: un rango de fechas distinto
  // siempre se vuelve a pedir completo. Es global, sin scope de grupo -- por
  // eso el filtro por dispositivo de abajo no es solo backstop, es el único
  // lugar donde se aplica el filtro de grupo.
  //
  // ExceptionEvent sigue en GetFeed (sí tiene sentido el cursor incremental
  // acá: no cambia de rango de fechas entre corridas, solo de reglas
  // mapeadas). Se pide un feed por cada regla mapeada (ruleSearch), no uno
  // global: sin esto se trae cada evento de excepción de la flota entera
  // (incluidas reglas no mapeadas), que son la mayoría del volumen y se
  // descartan igual más abajo por ruleMapping. Se agrega también la regla
  // built-in de ralentí de Geotab (IDLING_RULE_ID) aunque no esté tildada en
  // "Configurar": el costo de ralentí la usa siempre (ver más abajo).
  const exceptionRuleIds = new Set([...Object.keys(ruleMapping), IDLING_RULE_ID]);
  const [allTrips, exceptionsByRuleFeed] = await Promise.all([
    fetchTripRecords(api, database, fromDate, toDate),
    Promise.all([...exceptionRuleIds].map(ruleId => fetchFeedRecords(
      api, database, "ExceptionEvent", "activeFrom", fromDate,
      { key: ruleId, search: { ruleSearch: { id: ruleId } } }
    ))),
  ]);
  const allExceptions = [].concat(...exceptionsByRuleFeed);

  let tripsByWeek = weekWindows.map(([weekStart, weekEnd]) => {
    const from = weekStart.toISOString(), to = weekEnd.toISOString();
    return allTrips.filter(t => t.start >= from && t.start < to);
  });
  let exceptionsByWeek = weekWindows.map(([weekStart, weekEnd]) => {
    const from = weekStart.toISOString(), to = weekEnd.toISOString();
    return allExceptions.filter(ev => ev.activeFrom >= from && ev.activeFrom < to);
  });

  // Filtro por dispositivo: cubre la exclusión por número de serie y el
  // filtro de grupo elegido (scopedGroupIds), ninguno de los cuales se
  // aplica server-side sobre el feed global.
  tripsByWeek = tripsByWeek.map(trips => trips.filter(t => devicesById[(t.device || {}).id] !== undefined));
  exceptionsByWeek = exceptionsByWeek.map(evs => evs.filter(ev => devicesById[(ev.device || {}).id] !== undefined));

  const distanceByDevice = {};
  for (const trips of tripsByWeek) {
    for (const trip of trips) {
      const deviceId = (trip.device || {}).id;
      if (deviceId) distanceByDevice[deviceId] = (distanceByDevice[deviceId] || 0) + (parseFloat(trip.distance) || 0);
    }
  }
  const exceptionsAll = [].concat(...exceptionsByWeek);

  const fuelCfg = dbSettings.fuel || {};
  const pricePerLiter = fuelCfg.price_per_liter || 0;
  // Además de la regla built-in de Geotab, algunos clientes miden ralentí con
  // una regla 'Custom' propia mapeada a la categoría "ralenti" en su rule_mapping.
  const idleRuleIds = new Set([
    IDLING_RULE_ID,
    ...Object.entries(ruleMapping).filter(([, cat]) => cat === "ralenti").map(([rid]) => rid),
  ]);
  const idlingEvents = exceptionsAll.filter(ev => idleRuleIds.has((ev.rule || {}).id));

  const periodStart = weekWindows[0][0];
  const periodEnd = weekWindows[weekWindows.length - 1][1];

  // Ya no se usa la entidad FuelUsed (dato calculado por Geotab a partir de
  // telemetría de motor, poco confiable entre vehículos/bases distintas):
  // combustible total y ralentí salen siempre de los diagnósticos contador
  // acumulado (StatusData), vía fetchFuelDiagnosticDelta.
  let totalFuelByDevice = {};
  let weeklyFuelLiters = new Array(weekWindows.length).fill(0);
  try {
    const result = await fetchFuelDiagnosticDelta(
      api, devicesById, TOTAL_FUEL_STATUS_DIAGNOSTIC_ID, periodStart, periodEnd, weekWindows
    );
    totalFuelByDevice = result.byDevice;
    weeklyFuelLiters = result.weekly;
  } catch (err) {
    // Diagnóstico no disponible en esta base de datos: seguimos sin datos de combustible.
  }

  let idleFuelByDevice = {};
  let weeklyIdleLiters = new Array(weekWindows.length).fill(0);
  try {
    const result = await fetchFuelDiagnosticDelta(
      api, devicesById, IDLE_FUEL_STATUS_DIAGNOSTIC_ID, periodStart, periodEnd, weekWindows
    );
    idleFuelByDevice = result.byDevice;
    weeklyIdleLiters = result.weekly;
  } catch (err) {
    // Diagnóstico no disponible en esta base de datos.
  }

  const fuelDataAvailable = Object.keys(totalFuelByDevice).length > 0 || Object.keys(idleFuelByDevice).length > 0;
  const idleRatesCfg = fuelCfg.idle_consumption_l_per_hour || {};

  const idlingCost = computeIdlingCost(
    exceptionsAll, idleFuelByDevice, vehicleClassByDevice,
    idleRatesCfg, devicesById, pricePerLiter, idleRuleIds
  );

  const drivingHoursByDevice = computeDrivingHoursByDevice(tripsByWeek);
  for (const v of idlingCost.by_vehicle) {
    const drivingHours = round(drivingHoursByDevice[v.device_id] || 0, 1);
    v.driving_hours = drivingHours;
    // Eficiencia = cuánto de las horas de manejo NO se "pierden" en ralentí:
    // ralentí == manejo (o más) es 0% eficiente; ralentí == 0 es 100% eficiente.
    // Se acota a [0, 1] para que nunca sea negativa ni supere el 100%.
    v.idle_efficiency_ratio = drivingHours > 0
      ? round(Math.max(0.0, Math.min(1.0, 1.0 - v.idle_hours / drivingHours)), 3)
      : null;
  }

  // weeklyIdleLiters hasta acá solo tiene litros medidos vía diagnóstico;
  // le suma la parte estimada por horas de los vehículos sin medición real, para
  // que la serie semanal (y su proyección) coincida con el total que ya muestra
  // el panel de "Costo de ralentí" (computeIdlingCost).
  const estimatedIdleDeviceIds = new Set(
    idlingCost.by_vehicle.filter(v => v.is_estimated).map(v => v.device_id)
  );
  const weeklyEstimatedIdleLiters = computeWeeklyEstimatedIdleLiters(
    idlingEvents, weekWindows, estimatedIdleDeviceIds, vehicleClassByDevice, idleRatesCfg
  );
  weeklyIdleLiters = weeklyIdleLiters.map((v, i) => v + weeklyEstimatedIdleLiters[i]);

  const fuelConsumption = computeFuelOutliers(
    totalFuelByDevice, distanceByDevice, devicesById, vehicleClassByDevice,
    fuelCfg.consumption_outlier_threshold_pct != null ? fuelCfg.consumption_outlier_threshold_pct : 20
  );
  const savingsOpportunity = computeSavingsOpportunity(idlingCost, fuelConsumption, pricePerLiter);

  const weeklyMetrics = buildWeeklyMetrics(weekWindows, tripsByWeek, exceptionsByWeek, ruleMapping, RULE_CATEGORY_WEIGHTS);
  const weeklyScores = weeklyMetrics.map(wm => computeWeekScore(wm, totalDeviceCount, SCORING_WEIGHTS, EFFICIENCY_IDLE_PENALTY_FACTOR));

  const opportunities = detectOpportunities(weeklyMetrics, weeklyScores, devicesById, TREND_CHANGE_THRESHOLD_PCT);

  const currentScore = weeklyScores.length
    ? weeklyScores[weeklyScores.length - 1]
    : { safety: 0, efficiency: 0, utilization: 0, overall: 0 };

  const totalDistancePeriod = round(weeklyMetrics.reduce((s, wm) => s + wm.total_distance_km, 0), 1);
  const totalTripsPeriod = tripsByWeek.reduce((s, t) => s + t.length, 0);
  const activeLastWeek = weeklyMetrics.length ? weeklyMetrics[weeklyMetrics.length - 1].active_device_count : 0;

  const evolution = weeklyMetrics.map((wm, i) => {
    const sc = weeklyScores[i];
    const exceptionsByCategory = {};
    for (const cat of EXCEPTION_CATEGORIES) exceptionsByCategory[cat] = wm.exceptions_by_category[cat] || 0;
    return {
      week_start: wm.week_start.slice(0, 10),
      overall: sc.overall,
      safety: sc.safety,
      efficiency: sc.efficiency,
      utilization: sc.utilization,
      exception_count_raw: wm.exception_count_raw,
      weighted_exceptions: wm.weighted_exceptions,
      total_distance_km: wm.total_distance_km,
      exceptions_by_category: exceptionsByCategory,
      exceptions_by_rule: wm.exceptions_by_rule,
    };
  });

  const ruleLabels = {};
  for (const rid of Object.keys(ruleMapping)) ruleLabels[rid] = rulesById[rid] || rid;

  // Series semanales de flota para la pestaña de Proyecciones (projections.js):
  // solo categorías de riesgo con al menos un evento en el período, para no
  // llenar la UI de proyecciones en 0 de infracciones que este cliente no usa.
  const riskCategoriesWithData = SAFETY_EVENT_CATEGORIES.filter(cat =>
    weeklyMetrics.some(wm => (wm.exceptions_by_category[cat] || 0) > 0)
  );
  const weeklyEventsByCategory = {};
  for (const cat of riskCategoriesWithData) {
    weeklyEventsByCategory[cat] = weeklyMetrics.map(wm => wm.exceptions_by_category[cat] || 0);
  }

  return {
    client: { database },
    generated_at: new Date().toISOString(),
    weeks_analyzed: weekWindows.length,
    score: currentScore,
    evolution,
    exception_categories: EXCEPTION_CATEGORIES,
    rule_labels: ruleLabels,
    idling_cost: idlingCost,
    fuel_consumption: fuelConsumption,
    savings_opportunity: savingsOpportunity,
    fuel_data_available: fuelDataAvailable,
    weekly_series: {
      fuel_liters: weeklyFuelLiters.map(v => round(v, 1)),
      idle_liters: weeklyIdleLiters.map(v => round(v, 1)),
      events_by_category: weeklyEventsByCategory,
    },
    opportunities,
    fleet_summary: {
      total_devices: totalDeviceCount,
      active_last_week: activeLastWeek,
      total_distance_km_period: totalDistancePeriod,
      total_trips_period: totalTripsPeriod,
    },
  };
}
