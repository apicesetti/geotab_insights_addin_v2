// Proyección a futuro de flota: promedio móvil de las últimas semanas,
// ajustado por la tendencia entre esas semanas y la ventana inmediatamente
// anterior, y extendido semana a semana en forma compuesta. Deliberadamente
// simple (no regresión): con 12 semanas de datos típicas, un modelo más
// sofisticado da una falsa sensación de precisión sin aportar mejor señal.
// Depende de round (utils.js).

// Cuántas semanas recientes se promedian para el nivel "actual" del que
// arranca la proyección.
const PROJECTION_BASE_WEEKS = 4;

// weeklyValues: serie semanal (más vieja -> más nueva), un valor por semana
// del período analizado (litros, eventos, etc. -- cualquier métrica de flota).
// horizonWeeks: cuántas semanas hacia adelante proyectar.
//
// Método:
// 1. base_weekly_avg = promedio de las últimas PROJECTION_BASE_WEEKS semanas
//    (el nivel "actual" de la métrica).
// 2. weekly_growth_pct = % de cambio entre esas últimas PROJECTION_BASE_WEEKS
//    semanas (recentWeeks) y las PROJECTION_BASE_WEEKS semanas inmediatamente
//    anteriores (priorWeeks), repartido entre el largo de esa ventana (una
//    tasa de crecimiento semanal implícita). Se compara contra la ventana
//    previa, no contra el arranque de todo el período analizado: una regla o
//    alerta activada a mitad de período (o cualquier métrica que arranca en
//    0) no debe "esconder" un cambio de tendencia reciente detrás del
//    promedio de meses donde la métrica todavía no existía.
// 3. Cada semana futura = base_weekly_avg * (1 + weekly_growth_pct)^semana,
//    o sea la tendencia observada se aplica de forma compuesta hacia adelante.
function computeTrendProjection(weeklyValues, horizonWeeks) {
  const n = (weeklyValues || []).length;
  if (n === 0 || !horizonWeeks || horizonWeeks <= 0) {
    return { base_weekly_avg: 0, weekly_growth_pct: 0, projected_weekly: [], projected_total: 0 };
  }

  const avg = arr => arr.reduce((s, v) => s + v, 0) / arr.length;

  const baseWeeks = weeklyValues.slice(-PROJECTION_BASE_WEEKS);
  const baseWeeklyAvg = avg(baseWeeks);

  const windowLen = Math.min(PROJECTION_BASE_WEEKS, Math.floor(n / 2));
  let weeklyGrowthRate = 0;
  if (windowLen >= 1) {
    const recentAvg = avg(weeklyValues.slice(-windowLen));
    const priorAvg = avg(weeklyValues.slice(-windowLen * 2, -windowLen));
    if (priorAvg > 0) {
      weeklyGrowthRate = ((recentAvg - priorAvg) / priorAvg) / windowLen;
    }
  }

  const projectedWeekly = [];
  for (let week = 1; week <= horizonWeeks; week++) {
    projectedWeekly.push(round(Math.max(0, baseWeeklyAvg * Math.pow(1 + weeklyGrowthRate, week)), 2));
  }
  const projectedTotal = round(projectedWeekly.reduce((s, v) => s + v, 0), 1);

  return {
    base_weekly_avg: round(baseWeeklyAvg, 2),
    weekly_growth_pct: round(weeklyGrowthRate * 100, 2),
    projected_weekly: projectedWeekly,
    projected_total: projectedTotal,
  };
}

// weeklySeries: { fuel_liters: [...], idle_liters: [...], events_by_category: {cat: [...]} },
// todas alineadas semana a semana con evolution/weekWindows del período analizado.
// pricePerLiter: para convertir litros proyectados a costo proyectado.
// horizonWeeks: horizonte elegido por el usuario en la UI (selector).
function buildProjections(weeklySeries, pricePerLiter, horizonWeeks) {
  const fuel = computeTrendProjection(weeklySeries.fuel_liters, horizonWeeks);
  const idle = computeTrendProjection(weeklySeries.idle_liters, horizonWeeks);

  const eventsByCategory = {};
  const categories = Object.keys(weeklySeries.events_by_category || {});
  for (const cat of categories) {
    eventsByCategory[cat] = computeTrendProjection(weeklySeries.events_by_category[cat], horizonWeeks);
  }

  const numWeeks = (weeklySeries.fuel_liters || weeklySeries.idle_liters || []).length;
  const totalEventsWeekly = new Array(numWeeks).fill(0);
  for (const cat of categories) {
    (weeklySeries.events_by_category[cat] || []).forEach((v, i) => { totalEventsWeekly[i] += v; });
  }
  const eventsTotal = computeTrendProjection(totalEventsWeekly, horizonWeeks);

  return {
    horizon_weeks: horizonWeeks,
    fuel: { ...fuel, projected_cost: round(fuel.projected_total * pricePerLiter, 0) },
    idle: { ...idle, projected_cost: round(idle.projected_total * pricePerLiter, 0) },
    events_total: eventsTotal,
    events_by_category: eventsByCategory,
  };
}
