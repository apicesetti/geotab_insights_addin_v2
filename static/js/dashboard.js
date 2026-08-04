// Orquesta las llamadas a la API de MyGeotab (vía el objeto `api` que el SDK
// de Add-Ins ya deja autenticado contra la base de datos actual) y arma el
// mismo objeto que consume la UI. Port 1:1 de app.py (fetch_dashboard_data +
// helpers de fechas), pero corriendo en el browser: sin backend, sin
// credenciales, sin CORS.

const EXCLUDED_SERIAL_NUMBERS = new Set(["", "000-000-0000"]);
const FUEL_MULTICALL_CHUNK_SIZE = 200;
const WEEKS_DEFAULT = 12;

// Antes vivían en config.json > scoring, compartidas por todas las bases de
// datos (no hay UI para editarlas, son constantes de tuning del modelo).
const SCORING_WEIGHTS = { safety: 0.4, efficiency: 0.3, utilization: 0.3 };
const RULE_CATEGORY_WEIGHTS = {
  velocidad: 1.5, frenado_brusco: 1.3, aceleracion_brusca: 1.2,
  cinturon: 1.0, distraccion: 1.4, ralenti: 0.8, otro: 0.8,
  colision_frontal: 1.6, frotado_ojos: 1.3, fatiga: 1.5,
  bostezo: 1.3, salida_carril: 1.4,
};
const EFFICIENCY_IDLE_PENALTY_FACTOR = 2;
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
// rango. Usado para acumular series semanales (combustible/ralentí) a partir
// de registros individuales (FuelUsed por evento) en vez de un feed que ya
// venga separado por semana.
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
async function fetchRules(api) {
  const rules = await api.call("Get", { typeName: "Rule" });
  return rules
    .filter(r => r.id && r.baseType !== "ZoneStop")
    .map(r => ({ id: r.id, name: r.name || r.id }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase(), "es"));
}

async function fetchGroupTree(api) {
  const groups = await api.call("Get", { typeName: "Group" });
  return buildGroupTree(groups);
}

// {device_id: litros} a partir de un diagnóstico contador acumulado (StatusData),
// 1 llamada por vehículo (chunked) en vez de por evento/registro: mucho más
// liviano para flotas grandes cerca del límite de requests. Usado tanto para
// ralentí (IDLE_FUEL_STATUS_DIAGNOSTIC_ID) como para combustible total
// (TOTAL_FUEL_STATUS_DIAGNOSTIC_ID) cuando FuelUsed no está disponible.
// weekWindows: si se pasa, además arma la serie semanal de flota (litros por
// semana, sumando el delta de cada vehículo dentro de esa semana) para las
// proyecciones -- devuelve { byDevice, weekly }.
async function fetchFuelDiagnosticDelta(api, devicesById, diagnosticId, periodStart, periodEnd, weekWindows) {
  const deviceIdsList = Object.keys(devicesById);
  const statusCalls = deviceIdsList.map(deviceId => ["Get", {
    typeName: "StatusData",
    search: {
      fromDate: periodStart.toISOString(), toDate: periodEnd.toISOString(),
      diagnosticSearch: { id: diagnosticId },
      deviceSearch: { id: deviceId },
    },
  }]);
  const statusRecordsByDevice = {};
  const callChunks = chunked(statusCalls, FUEL_MULTICALL_CHUNK_SIZE);
  const deviceChunks = chunked(deviceIdsList, FUEL_MULTICALL_CHUNK_SIZE);
  for (let c = 0; c < callChunks.length; c++) {
    const chunkResults = await api.multiCall(callChunks[c]);
    deviceChunks[c].forEach((deviceId, i) => { statusRecordsByDevice[deviceId] = chunkResults[i] || []; });
  }
  const byDevice = computeFuelDeltaFromStatusData(statusRecordsByDevice);
  const weekly = weekWindows ? computeWeeklyFuelDeltaFromStatusData(statusRecordsByDevice, weekWindows) : null;
  return { byDevice, weekly };
}

// params: { database, fromDate, toDate, ruleMapping, groupFilterId, dbSettings }
async function buildDashboardData(api, params) {
  const { database, fromDate, toDate, ruleMapping, groupFilterId, dbSettings } = params;

  const groups = await api.call("Get", { typeName: "Group" });
  const groupsById = {};
  const groupNamesById = {};
  for (const g of groups) {
    groupsById[g.id] = g;
    groupNamesById[g.id] = g.name || "";
  }

  const scopedGroupIds = groupFilterId ? resolveGroupAndDescendants(groupFilterId, groupsById) : null;
  const groupSearch = scopedGroupIds ? { groups: [...scopedGroupIds].map(id => ({ id })) } : undefined;

  let devices = await api.call("Get", groupSearch ? { typeName: "Device", search: groupSearch } : { typeName: "Device" });
  devices = devices.filter(d => !EXCLUDED_SERIAL_NUMBERS.has((d.serialNumber || "").trim()));
  if (scopedGroupIds) {
    devices = devices.filter(d => (d.groups || []).some(g => scopedGroupIds.has(typeof g === "object" ? g.id : g)));
  }
  const devicesById = {};
  for (const d of devices) devicesById[d.id] = d.name || d.id;
  const totalDeviceCount = devices.length;

  const rules = await api.call("Get", { typeName: "Rule" });
  const rulesById = {};
  for (const r of rules) rulesById[r.id] = r.name || "";

  const vehicleClassByDevice = {};
  for (const d of devices) vehicleClassByDevice[d.id] = classifyVehicleClass(d.groups, groupNamesById);

  const weekWindows = buildWeekWindowsForRange(fromDate, toDate);

  // Trip y ExceptionEvent ya no se piden por semana con Get() (repetía todo
  // el rango de nuevo en cada "Analizar"/"Actualizar"): se mantienen en un
  // feed incremental por base de datos vía GetFeed, cacheado en IndexedDB
  // (ver feed.js). Trip es un feed global, sin scope de grupo -- por eso el
  // filtro por dispositivo de abajo ya no es solo backstop, es el único
  // lugar donde se aplica el filtro de grupo.
  //
  // ExceptionEvent se pide un feed por cada regla mapeada (ruleSearch),
  // no uno global: sin esto se trae cada evento de excepción de la flota
  // entera (incluidas reglas no mapeadas), que son la mayoría del volumen y
  // se descartan igual más abajo por ruleMapping. Se agrega también la regla
  // built-in de ralentí de Geotab (IDLING_RULE_ID) aunque no esté tildada en
  // "Configurar": el costo de ralentí la usa siempre (ver más abajo).
  const exceptionRuleIds = new Set([...Object.keys(ruleMapping), IDLING_RULE_ID]);
  const [allTrips, exceptionsByRuleFeed] = await Promise.all([
    fetchFeedRecords(api, database, "Trip", "start", fromDate),
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

  let totalFuelByDevice = {};
  let weeklyFuelLiters = new Array(weekWindows.length).fill(0);
  try {
    // OJO: antes esto era un Get() sin resultsLimit por TODO el período y
    // TODA la flota de una sola vez -- Geotab trunca en silencio si hay más
    // registros de los que entran en la respuesta default (no tira error),
    // así que en flotas/rangos grandes esto subestimaba el combustible real
    // sin que se note. fetchFeedRecords pagina con GetFeed hasta agotar el
    // backlog, igual que Trip/ExceptionEvent, así que no trunca. Es un feed
    // global (no scopeado por grupo) -- el filtro de grupo se aplica igual
    // que en Trip, con el devicesById de más abajo.
    const allFuelUsed = await fetchFeedRecords(api, database, "FuelUsed", "fromDate", periodStart);
    const fuelUsedData = allFuelUsed.filter(r => r.fromDate && r.fromDate < periodEnd.toISOString());
    const summed = sumFuelUsedByDevice(fuelUsedData, "totalFuelUsed");
    totalFuelByDevice = Object.fromEntries(Object.entries(summed).filter(([d]) => devicesById[d] !== undefined));
    weeklyFuelLiters = sumByWeek(fuelUsedData, weekWindows, "fromDate", "totalFuelUsed");
  } catch (err) {
    // FuelUsed no disponible en esta base de datos: seguimos sin datos de combustible.
  }

  // FuelUsed es un valor que Geotab calcula a partir de telemetría de motor
  // (RPM, carga, etc.). En bases donde el vehículo no reporta esa telemetría,
  // el feed viene vacío o en 0 para toda la flota aunque el consumo real sí
  // se mida vía el diagnóstico contador TOTAL_FUEL_STATUS_DIAGNOSTIC_ID (mismo
  // caso que ya existía para el ralentí). Se usa como fallback automático,
  // no como método por defecto, para no sumarle una llamada por vehículo a
  // las bases donde FuelUsed ya funciona.
  const noFuelUsedData = Object.keys(totalFuelByDevice).length === 0
    || Object.values(totalFuelByDevice).every(l => l <= 0);
  if (noFuelUsedData) {
    try {
      const result = await fetchFuelDiagnosticDelta(
        api, devicesById, TOTAL_FUEL_STATUS_DIAGNOSTIC_ID, periodStart, periodEnd, weekWindows
      );
      totalFuelByDevice = result.byDevice;
      weeklyFuelLiters = result.weekly;
    } catch (err) {
      // Diagnóstico tampoco disponible en esta base: seguimos sin datos de combustible.
    }
  }

  const idleFuelMethod = fuelCfg.idle_fuel_method || "fuel_used_per_event";
  let idleFuelByDevice = {};
  let weeklyIdleLiters = new Array(weekWindows.length).fill(0);

  if (idleFuelMethod === "status_data") {
    try {
      const result = await fetchFuelDiagnosticDelta(
        api, devicesById, IDLE_FUEL_STATUS_DIAGNOSTIC_ID, periodStart, periodEnd, weekWindows
      );
      idleFuelByDevice = result.byDevice;
      weeklyIdleLiters = result.weekly;
    } catch (err) {
      // Diagnóstico no disponible en esta base de datos.
    }
  } else {
    // Por evento de ralentí en vez de agregado: cada llamada a FuelUsed cuenta contra el
    // límite de la API, así que con muchos eventos esto puede agotarse a mitad de camino.
    // Se procesa chunk a chunk para quedarnos con lo que se llegó a traer.
    try {
      const idleCalls = [];
      const idleCallDevices = [];
      const idleCallWeekIdx = [];
      for (const ev of idlingEvents) {
        const deviceId = (ev.device || {}).id;
        const activeFrom = ev.activeFrom;
        const activeTo = ev.activeTo;
        if (!deviceId || !activeFrom || !activeTo) continue;
        idleCalls.push(["Get", { typeName: "FuelUsed", search: { deviceSearch: { id: deviceId }, fromDate: activeFrom, toDate: activeTo } }]);
        idleCallDevices.push(deviceId);
        idleCallWeekIdx.push(weekIndexForIso(weekWindows, activeFrom));
      }
      const callChunks = chunked(idleCalls, FUEL_MULTICALL_CHUNK_SIZE);
      const deviceChunks = chunked(idleCallDevices, FUEL_MULTICALL_CHUNK_SIZE);
      const weekIdxChunks = chunked(idleCallWeekIdx, FUEL_MULTICALL_CHUNK_SIZE);
      for (let c = 0; c < callChunks.length; c++) {
        const chunkResults = await api.multiCall(callChunks[c]);
        deviceChunks[c].forEach((deviceId, i) => {
          const weekIdx = weekIdxChunks[c][i];
          for (const r of (chunkResults[i] || [])) {
            const liters = parseFloat(r.totalIdlingFuelUsedL != null ? r.totalIdlingFuelUsedL : r.totalFuelUsed) || 0;
            idleFuelByDevice[deviceId] = (idleFuelByDevice[deviceId] || 0) + liters;
            if (weekIdx >= 0) weeklyIdleLiters[weekIdx] += liters;
          }
        });
      }
    } catch (err) {
      // No se pudo medir combustible de ralentí por evento en esta base.
    }

    // Igual que con el combustible total: si hubo eventos de ralentí pero
    // FuelUsed no devolvió nada para ninguno (base sin telemetría de motor),
    // se cae automáticamente al diagnóstico contador acumulado.
    if (idlingEvents.length > 0 && Object.keys(idleFuelByDevice).length === 0) {
      try {
        const result = await fetchFuelDiagnosticDelta(
          api, devicesById, IDLE_FUEL_STATUS_DIAGNOSTIC_ID, periodStart, periodEnd, weekWindows
        );
        idleFuelByDevice = result.byDevice;
        weeklyIdleLiters = result.weekly;
      } catch (err) {
        // Diagnóstico tampoco disponible en esta base.
      }
    }
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

  // weeklyIdleLiters hasta acá solo tiene litros medidos (FuelUsed/diagnosticId);
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
