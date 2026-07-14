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

  const calls = [];
  const callKinds = [];
  weekWindows.forEach(([weekStart, weekEnd], weekIdx) => {
    const searchRange = { fromDate: weekStart.toISOString(), toDate: weekEnd.toISOString() };
    if (scopedGroupIds) searchRange.deviceSearch = { groups: [...scopedGroupIds].map(id => ({ id })) };
    calls.push(["Get", { typeName: "Trip", search: searchRange }]);
    callKinds.push(["trip", weekIdx]);
    calls.push(["Get", { typeName: "ExceptionEvent", search: searchRange }]);
    callKinds.push(["exception", weekIdx]);
  });

  const results = await api.multiCall(calls);

  let tripsByWeek = weekWindows.map(() => []);
  let exceptionsByWeek = weekWindows.map(() => []);
  callKinds.forEach(([kind, weekIdx], i) => {
    if (kind === "trip") tripsByWeek[weekIdx] = results[i] || [];
    else exceptionsByWeek[weekIdx] = exceptionsByWeek[weekIdx].concat(results[i] || []);
  });

  // Filtro de respaldo por dispositivo: cubre la exclusión por número de
  // serie (que el deviceSearch por grupo no puede expresar) y actúa de
  // backstop si el server-side no cascadea grupos como se espera.
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
  try {
    const fuelUsedSearch = { fromDate: periodStart.toISOString(), toDate: periodEnd.toISOString() };
    if (scopedGroupIds) fuelUsedSearch.deviceSearch = { groups: [...scopedGroupIds].map(id => ({ id })) };
    const fuelUsedData = await api.call("Get", { typeName: "FuelUsed", search: fuelUsedSearch });
    const summed = sumFuelUsedByDevice(fuelUsedData, "totalFuelUsed");
    totalFuelByDevice = Object.fromEntries(Object.entries(summed).filter(([d]) => devicesById[d] !== undefined));
  } catch (err) {
    // FuelUsed no disponible en esta base de datos: seguimos sin datos de combustible.
  }

  const idleFuelMethod = fuelCfg.idle_fuel_method || "fuel_used_per_event";
  let idleFuelByDevice = {};

  if (idleFuelMethod === "status_data") {
    // 1 llamada por vehículo (chunked) en vez de 1 por evento de ralentí:
    // mucho más liviano para flotas grandes cerca del límite de requests.
    try {
      const deviceIdsList = Object.keys(devicesById);
      const statusCalls = deviceIdsList.map(deviceId => ["Get", {
        typeName: "StatusData",
        search: {
          fromDate: periodStart.toISOString(), toDate: periodEnd.toISOString(),
          diagnosticSearch: { id: IDLE_FUEL_STATUS_DIAGNOSTIC_ID },
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
      idleFuelByDevice = computeIdleFuelFromStatusData(statusRecordsByDevice);
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
      for (const ev of idlingEvents) {
        const deviceId = (ev.device || {}).id;
        const activeFrom = ev.activeFrom;
        const activeTo = ev.activeTo;
        if (!deviceId || !activeFrom || !activeTo) continue;
        idleCalls.push(["Get", { typeName: "FuelUsed", search: { deviceSearch: { id: deviceId }, fromDate: activeFrom, toDate: activeTo } }]);
        idleCallDevices.push(deviceId);
      }
      const callChunks = chunked(idleCalls, FUEL_MULTICALL_CHUNK_SIZE);
      const deviceChunks = chunked(idleCallDevices, FUEL_MULTICALL_CHUNK_SIZE);
      for (let c = 0; c < callChunks.length; c++) {
        const chunkResults = await api.multiCall(callChunks[c]);
        deviceChunks[c].forEach((deviceId, i) => {
          for (const r of (chunkResults[i] || [])) {
            const liters = r.totalIdlingFuelUsedL != null ? r.totalIdlingFuelUsedL : r.totalFuelUsed;
            idleFuelByDevice[deviceId] = (idleFuelByDevice[deviceId] || 0) + (parseFloat(liters) || 0);
          }
        });
      }
    } catch (err) {
      // No se pudo medir combustible de ralentí por evento en esta base.
    }
  }

  const fuelDataAvailable = Object.keys(totalFuelByDevice).length > 0 || Object.keys(idleFuelByDevice).length > 0;
  const devicesWithFuelData = new Set(Object.entries(totalFuelByDevice).filter(([, l]) => l > 0).map(([d]) => d));
  const idleRatesCfg = fuelCfg.idle_consumption_l_per_hour || {};

  const idlingCost = computeIdlingCost(
    exceptionsAll, idleFuelByDevice, devicesWithFuelData, vehicleClassByDevice,
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
    opportunities,
    fleet_summary: {
      total_devices: totalDeviceCount,
      active_last_week: activeLastWeek,
      total_distance_km_period: totalDistancePeriod,
      total_trips_period: totalTripsPeriod,
    },
  };
}
