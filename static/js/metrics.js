// Transforma resultados crudos de Trip / ExceptionEvent en métricas semanales
// y en un score 0-100 por categoría (seguridad, eficiencia, utilización) más
// un score general ponderado.
// Port 1:1 de core/metrics.py.

const ISO8601_DURATION_RE = /P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/;

// Convierte distintos formatos de duración devueltos por la API (ISO8601
// "PT1H2M3S", "HH:MM:SS", o segundos numéricos) a horas (float).
function durationToHours(value) {
  if (value == null) return 0.0;
  if (typeof value === "number") return value / 3600.0; // asumimos segundos
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("P")) {
      const m = ISO8601_DURATION_RE.exec(s);
      if (!m) return 0.0;
      const days = parseFloat(m[1] || 0);
      const hours = parseFloat(m[2] || 0);
      const minutes = parseFloat(m[3] || 0);
      const seconds = parseFloat(m[4] || 0);
      const totalSeconds = days * 86400 + hours * 3600 + minutes * 60 + seconds;
      return totalSeconds / 3600.0;
    }
    // formato "HH:MM:SS" o "HH:MM:SS.ffffff"
    const parts = s.split(":");
    if (parts.length === 3) {
      const h = parseInt(parts[0], 10);
      const m_ = parseInt(parts[1], 10);
      const sec = parseFloat(parts[2]);
      if (!Number.isNaN(h) && !Number.isNaN(m_) && !Number.isNaN(sec)) {
        return h + m_ / 60.0 + sec / 3600.0;
      }
    }
    return 0.0;
  }
  return 0.0;
}

// Categorías "reales" para el mapeo manual regla-de-Geotab -> categoría por
// cliente. Cada base de datos nombra sus reglas distinto, así que este mapeo
// se configura a mano desde el panel de "Configuración del análisis".
const EXCEPTION_CATEGORIES = [
  "velocidad", "frenado_brusco", "aceleracion_brusca", "giro_brusco",
  "cinturon", "distraccion", "telefono", "ralenti", "reversa", "otro",
  "colision_frontal", "frotado_ojos", "fatiga", "bostezo", "salida_carril",
];

// Categorías que cuentan para el puntaje general de seguridad (eventos/100km).
// "ralenti" es operativo (impacta el score de eficiencia, no el de seguridad) y
// "otro" es residual/no clasificado, así que ambas quedan afuera del promedio.
const SAFETY_EVENT_CATEGORIES = [
  "aceleracion_brusca", "frenado_brusco", "giro_brusco", "velocidad",
  "cinturon", "distraccion", "telefono", "reversa",
  "colision_frontal", "frotado_ojos", "fatiga", "bostezo", "salida_carril",
];

// eventos/100km a partir del cual el puntaje de esa categoría llega a 0.
const SAFETY_EVENTS_PER_100KM_FOR_ZERO_SCORE = 5.0;

// week_windows: lista de [week_start, week_end] (Date), ordenada cronológicamente.
// trips_by_week / exceptions_by_week: listas paralelas de arrays crudos de Trip / ExceptionEvent.
// rule_mapping: {rule_id: categoria}. Que una regla esté presente ES la señal de que está
//   incluida en el análisis; eventos de reglas no mapeadas se excluyen (no caen en "otro").
// category_weights: {categoria: peso}.
function buildWeeklyMetrics(weekWindows, tripsByWeek, exceptionsByWeek, ruleMapping, categoryWeights) {
  const weekly = [];

  for (let i = 0; i < weekWindows.length; i++) {
    const [weekStart, weekEnd] = weekWindows[i];
    const trips = tripsByWeek[i] || [];
    const exceptions = exceptionsByWeek[i] || [];

    let totalDistanceKm = 0.0;
    let drivingHours = 0.0;
    let idlingHours = 0.0;
    const activeDevices = new Set();

    for (const trip of trips) {
      const deviceId = (trip.device || {}).id;
      if (deviceId) activeDevices.add(deviceId);
      totalDistanceKm += parseFloat(trip.distance) || 0.0;
      drivingHours += durationToHours(trip.drivingDuration);
      idlingHours += durationToHours(trip.idlingDuration);
    }

    let weightedExceptions = 0.0;
    const exceptionsByCategory = {};
    const exceptionsByRule = {};
    let exceptionCountRaw = 0;

    for (const ev of exceptions) {
      const ruleId = (ev.rule || {}).id;
      const category = ruleMapping[ruleId];
      if (category == null) continue;
      exceptionCountRaw += 1;
      exceptionsByCategory[category] = (exceptionsByCategory[category] || 0) + 1;
      exceptionsByRule[ruleId] = (exceptionsByRule[ruleId] || 0) + 1;
      weightedExceptions += categoryWeights[category] != null ? categoryWeights[category] : 0.8;
    }

    weekly.push({
      week_start: weekStart.toISOString(),
      week_end: weekEnd.toISOString(),
      total_distance_km: round(totalDistanceKm, 1),
      driving_hours: round(drivingHours, 1),
      idling_hours: round(idlingHours, 1),
      active_devices: activeDevices,
      active_device_count: activeDevices.size,
      exception_count_raw: exceptionCountRaw,
      weighted_exceptions: round(weightedExceptions, 2),
      exceptions_by_category: exceptionsByCategory,
      exceptions_by_rule: exceptionsByRule,
    });
  }

  return weekly;
}

// trips_by_week (lista de arrays de Trip crudo) -> {device_id: horas de manejo
// totales en el período}, para cruzar con las horas de ralentí por vehículo
// (fuel.js computeIdlingCost) y armar la eficiencia de ralentí.
function computeDrivingHoursByDevice(tripsByWeek) {
  const drivingHours = {};
  for (const trips of tripsByWeek) {
    for (const trip of trips) {
      const deviceId = (trip.device || {}).id;
      if (deviceId) {
        drivingHours[deviceId] = (drivingHours[deviceId] || 0) + durationToHours(trip.drivingDuration);
      }
    }
  }
  return drivingHours;
}

// Calcula safety / efficiency / utilization / overall (0-100) para una semana.
function computeWeekScore(weekMetrics, totalDeviceCount, weights, efficiencyIdlePenaltyFactor) {
  const distanceKm = weekMetrics.total_distance_km;
  const exceptionsByCategory = weekMetrics.exceptions_by_category;

  const categoryScores = SAFETY_EVENT_CATEGORIES.map(category => {
    const count = exceptionsByCategory[category] || 0;
    let eventsPer100km;
    if (distanceKm > 0) {
      eventsPer100km = (count / distanceKm) * 100.0;
    } else {
      // Sin distancia recorrida no hay tasa que calcular; cualquier evento
      // registrado igual se penaliza al máximo en vez de darlo por "perfecto".
      eventsPer100km = count > 0 ? SAFETY_EVENTS_PER_100KM_FOR_ZERO_SCORE : 0.0;
    }
    return Math.max(0.0, 100.0 - (eventsPer100km / SAFETY_EVENTS_PER_100KM_FOR_ZERO_SCORE) * 100.0);
  });

  const safetyScore = categoryScores.length
    ? categoryScores.reduce((a, b) => a + b, 0) / categoryScores.length
    : 100.0;

  const totalSafetyEvents = SAFETY_EVENT_CATEGORIES.reduce((sum, cat) => sum + (exceptionsByCategory[cat] || 0), 0);
  const safetyEventsPer100km = distanceKm > 0 ? (totalSafetyEvents / distanceKm) * 100.0 : 0.0;

  const totalHours = weekMetrics.driving_hours + weekMetrics.idling_hours;
  const idlingPct = totalHours > 0 ? (weekMetrics.idling_hours / totalHours) * 100.0 : 0.0;
  const efficiencyScore = Math.max(0.0, 100.0 - idlingPct * efficiencyIdlePenaltyFactor);

  let utilizationScore = totalDeviceCount > 0
    ? (weekMetrics.active_device_count / totalDeviceCount) * 100.0
    : 0.0;
  utilizationScore = Math.min(100.0, utilizationScore);

  const overall = (
    safetyScore * (weights.safety != null ? weights.safety : 0.4)
    + efficiencyScore * (weights.efficiency != null ? weights.efficiency : 0.3)
    + utilizationScore * (weights.utilization != null ? weights.utilization : 0.3)
  );

  return {
    safety: round(safetyScore, 1),
    efficiency: round(efficiencyScore, 1),
    utilization: round(utilizationScore, 1),
    overall: round(overall, 1),
    idling_pct: round(idlingPct, 1),
    safety_events_per_100km: round(safetyEventsPer100km, 2),
  };
}
