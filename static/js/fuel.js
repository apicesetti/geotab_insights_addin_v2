// Costo de ralentí y detección de outliers de consumo de combustible,
// cruzando ExceptionEvent (RuleIdlingId) y FuelUsed por vehículo.
// Port 1:1 de core/fuel.py. Depende de durationToHours (metrics.js) y round (utils.js).

const IDLING_RULE_ID = "RuleIdlingId";

// Diagnóstico de StatusData con el combustible total consumido en ralentí
// desde la instalación del dispositivo (contador acumulado). Alternativa a
// sumar FuelUsed por cada evento de ralentí: 1 llamada por vehículo en vez de
// 1 por evento, mucho más liviano para flotas grandes cerca del límite de requests.
const IDLE_FUEL_STATUS_DIAGNOSTIC_ID = "DiagnosticDeviceTotalIdleFuelId";

// Comparar consumo contra un único promedio de flota penaliza a los vehículos pesados
// solo por serlo. Se buscan grupos de Geotab que el cliente ya usa para clasificar por
// tipo/peso de vehículo (ej. "Pesados" / "Livianos") y se compara cada vehículo contra
// el promedio de su propia clase.
const VEHICLE_CLASS_KEYWORDS = {
  pesados: ["pesad", "heavy", "truck", "camion", "camión"],
  livianos: ["liviano", "light", "utilitario", "van"],
};
const MIN_CLASS_SIZE_FOR_OWN_AVG = 3;
const DEFAULT_IDLE_CONSUMPTION_L_PER_HOUR = 1.5;

// Device.groups + {group_id: nombre} -> 'pesados' | 'livianos' | 'otros'.
function classifyVehicleClass(deviceGroups, groupNamesById) {
  const names = (deviceGroups || [])
    .map(g => groupNamesById[g.id] || "")
    .join(" ")
    .toLowerCase();
  for (const [vehicleClass, keywords] of Object.entries(VEHICLE_CLASS_KEYWORDS)) {
    if (keywords.some(k => names.includes(k))) return vehicleClass;
  }
  return "otros";
}

// Registros FuelUsed -> {device_id: suma del campo indicado en el período}.
function sumFuelUsedByDevice(records, field) {
  field = field || "totalFuelUsed";
  const totals = {};
  for (const r of records) {
    const deviceId = (r.device || {}).id;
    if (!deviceId) continue;
    totals[deviceId] = (totals[deviceId] || 0) + (parseFloat(r[field]) || 0.0);
  }
  return totals;
}

// statusRecordsByDevice: {device_id: [StatusData record, ...]} del diagnóstico
// IDLE_FUEL_STATUS_DIAGNOSTIC_ID en el período. Es un contador acumulado desde
// la instalación del dispositivo, así que los litros reales usados en el
// período son max(data) - min(data) por vehículo. Misma forma de salida que
// sumFuelUsedByDevice: {device_id: litros}.
function computeIdleFuelFromStatusData(statusRecordsByDevice) {
  const deltas = {};
  for (const [deviceId, records] of Object.entries(statusRecordsByDevice)) {
    const values = records.map(r => r.data).filter(v => v != null).map(Number);
    if (values.length >= 2) {
      deltas[deviceId] = Math.max(...values) - Math.min(...values);
    }
  }
  return deltas;
}

// exceptionsAll: lista plana de ExceptionEvent (todas las semanas juntas).
// idleFuelDeltas: {device_id: litros}, de FuelUsed por evento de ralentí.
// devicesWithFuelData: Set de device_id que reportan FuelUsed en el período
//   (si un vehículo no está acá, no tiene telemetría de combustible y su ralentí
//   se estima por horas en vez de medirse).
// vehicleClassByDevice: {device_id: 'pesados'|'livianos'|'otros'}.
// idleConsumptionEstimates: {vehicle_class: litros/hora} para estimar el ralentí de
//   vehículos sin medición de combustible.
// devicesById: {device_id: nombre}.
// pricePerLiter: precio configurado del combustible.
// idleRuleIds: Set de ids de regla que cuentan como ralentí. Además de la regla
//   built-in de Geotab, algunos clientes miden ralentí con una regla 'Custom'
//   propia mapeada a la categoría "ralenti" en su rule_mapping.
function computeIdlingCost(
  exceptionsAll, idleFuelDeltas, devicesWithFuelData, vehicleClassByDevice,
  idleConsumptionEstimates, devicesById, pricePerLiter, idleRuleIds
) {
  idleRuleIds = idleRuleIds || new Set([IDLING_RULE_ID]);
  const eventsByDevice = {};
  for (const ev of exceptionsAll) {
    const ruleId = (ev.rule || {}).id;
    if (!idleRuleIds.has(ruleId)) continue;
    const deviceId = (ev.device || {}).id;
    if (!deviceId) continue;
    if (!eventsByDevice[deviceId]) eventsByDevice[deviceId] = { count: 0, hours: 0.0 };
    eventsByDevice[deviceId].count += 1;
    eventsByDevice[deviceId].hours += durationToHours(ev.duration);
  }

  const deviceIds = new Set([...Object.keys(eventsByDevice), ...Object.keys(idleFuelDeltas)]);
  const byVehicle = [];
  for (const deviceId of deviceIds) {
    const stats = eventsByDevice[deviceId] || { count: 0, hours: 0.0 };
    const isEstimated = !devicesWithFuelData.has(deviceId);
    let liters;
    if (isEstimated) {
      const vehicleClass = vehicleClassByDevice[deviceId] || "otros";
      const rate = idleConsumptionEstimates[vehicleClass] != null
        ? idleConsumptionEstimates[vehicleClass]
        : DEFAULT_IDLE_CONSUMPTION_L_PER_HOUR;
      liters = round(stats.hours * rate, 1);
    } else {
      liters = round(idleFuelDeltas[deviceId] || 0.0, 1);
    }
    const cost = round(liters * pricePerLiter, 0);
    byVehicle.push({
      device_id: deviceId,
      device_name: devicesById[deviceId] || deviceId,
      idle_liters: liters,
      idle_cost: cost,
      idle_event_count: stats.count,
      idle_hours: round(stats.hours, 1),
      is_estimated: isEstimated,
    });
  }

  byVehicle.sort((a, b) => b.idle_cost - a.idle_cost);

  const totalLiters = round(byVehicle.reduce((s, v) => s + v.idle_liters, 0), 1);
  const totalCost = round(totalLiters * pricePerLiter, 0);

  return {
    price_per_liter: pricePerLiter,
    idle_consumption_l_per_hour: idleConsumptionEstimates,
    total_idle_liters: totalLiters,
    total_idle_cost: totalCost,
    by_vehicle: byVehicle,
  };
}

function avgLPer100km(rows) {
  // Vehículos con 0 litros consumidos suelen ser falta de telemetría de combustible,
  // no consumo real: incluirlos arrastra el promedio de la clase hacia abajo sin motivo.
  const rowsWithConsumption = rows.filter(r => r.total_liters > 0);
  const totalL = rowsWithConsumption.reduce((s, r) => s + r.total_liters, 0);
  const totalKm = rowsWithConsumption.reduce((s, r) => s + r.total_distance_km, 0);
  return totalKm > 0 ? (totalL / totalKm) * 100.0 : 0.0;
}

// fuelDeltas: {device_id: litros}, de sumFuelUsedByDevice sobre FuelUsed.
// distanceByDevice: {device_id: km recorridos en el período}.
// vehicleClassByDevice: {device_id: 'pesados'|'livianos'|'otros'}, de classifyVehicleClass.
// El desvío de cada vehículo se calcula contra el promedio de SU clase (no el de toda
// la flota), salvo que la clase tenga muy pocos vehículos para ser un promedio confiable.
function computeFuelOutliers(fuelDeltas, distanceByDevice, devicesById, vehicleClassByDevice, thresholdPct) {
  const rows = [];
  for (const [deviceId, distanceKm] of Object.entries(distanceByDevice)) {
    if (distanceKm <= 0) continue;
    const liters = fuelDeltas[deviceId] || 0.0;
    const lPer100km = (liters / distanceKm) * 100.0;
    rows.push({
      device_id: deviceId,
      device_name: devicesById[deviceId] || deviceId,
      vehicle_class: vehicleClassByDevice[deviceId] || "otros",
      total_liters: round(liters, 1),
      total_distance_km: round(distanceKm, 1),
      l_per_100km: round(lPer100km, 2),
    });
  }

  const fleetAvg = avgLPer100km(rows);

  const rowsByClass = {};
  for (const r of rows) {
    (rowsByClass[r.vehicle_class] = rowsByClass[r.vehicle_class] || []).push(r);
  }

  const classAvgs = {};
  for (const [vehicleClass, classRows] of Object.entries(rowsByClass)) {
    classAvgs[vehicleClass] = classRows.length >= MIN_CLASS_SIZE_FOR_OWN_AVG
      ? avgLPer100km(classRows)
      : fleetAvg;
  }

  for (const r of rows) {
    const referenceAvg = classAvgs[r.vehicle_class];
    const deviationPct = referenceAvg > 0 ? ((r.l_per_100km - referenceAvg) / referenceAvg) * 100.0 : 0.0;
    r.reference_avg_l_per_100km = round(referenceAvg, 2);
    r.deviation_pct = round(deviationPct, 1);
    r.is_outlier = Math.abs(deviationPct) >= thresholdPct;
  }

  rows.sort((a, b) => Math.abs(b.deviation_pct) - Math.abs(a.deviation_pct));

  const classAvgsRounded = {};
  for (const [cls, v] of Object.entries(classAvgs)) classAvgsRounded[cls] = round(v, 2);

  return {
    fleet_avg_l_per_100km: round(fleetAvg, 2),
    class_avgs_l_per_100km: classAvgsRounded,
    outlier_threshold_pct: thresholdPct,
    by_vehicle: rows,
  };
}

// Ahorro potencial estimado: litros que se dejarían de gastar si
// - los vehículos con más ralentí que la mediana de la flota bajaran a esa mediana, y
// - los vehículos outlier de consumo (por encima del promedio) bajaran al promedio de flota.
function computeSavingsOpportunity(idlingCost, fuelConsumption, pricePerLiter) {
  const idleLitersByVehicle = idlingCost.by_vehicle.map(v => v.idle_liters);
  const idleMedian = median(idleLitersByVehicle);
  const idlingExcessLiters = idlingCost.by_vehicle.reduce(
    (sum, v) => sum + Math.max(0.0, v.idle_liters - idleMedian), 0
  );

  const fuelExcessLiters = fuelConsumption.by_vehicle
    .filter(v => v.is_outlier && v.deviation_pct > 0)
    .reduce((sum, v) => sum + ((v.l_per_100km - v.reference_avg_l_per_100km) / 100.0) * v.total_distance_km, 0);

  const idlingExcessLitersR = round(idlingExcessLiters, 1);
  const fuelExcessLitersR = round(fuelExcessLiters, 1);
  const totalExcessLiters = round(idlingExcessLitersR + fuelExcessLitersR, 1);

  return {
    idling_excess_liters: idlingExcessLitersR,
    idling_excess_cost: round(idlingExcessLitersR * pricePerLiter, 0),
    fuel_excess_liters: fuelExcessLitersR,
    fuel_excess_cost: round(fuelExcessLitersR * pricePerLiter, 0),
    total_excess_liters: totalExcessLiters,
    estimated_savings: round(totalExcessLiters * pricePerLiter, 0),
  };
}

function median(values) {
  if (!values.length) return 0.0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
