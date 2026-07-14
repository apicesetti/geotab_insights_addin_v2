// A partir de la serie semanal de métricas + scores, genera una lista de
// "oportunidades" (cosas para mejorar) y "logros" (mejoras ya conseguidas)
// en lenguaje simple para mostrar en el dashboard.
// Port 1:1 de core/analyzer.py.

const ANALYZER_CATEGORY_LABELS = {
  velocidad: "exceso de velocidad",
  frenado_brusco: "frenadas bruscas",
  aceleracion_brusca: "aceleraciones bruscas",
  giro_brusco: "giros bruscos",
  cinturon: "uso de cinturón de seguridad",
  distraccion: "conducción distraída",
  telefono: "uso de teléfono celular",
  ralenti: "tiempo de ralentí",
  reversa: "marcha atrás",
  otro: "otras infracciones",
  colision_frontal: "advertencias de colisión frontal",
  frotado_ojos: "conductor frotándose los ojos",
  fatiga: "fatiga del conductor",
  bostezo: "conductor bostezando",
  salida_carril: "advertencias de salida de carril",
};

function avgOf(values) {
  values = Array.from(values);
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0.0;
}

function pctChange(oldVal, newVal) {
  if (oldVal === 0) return newVal === 0 ? 0.0 : 100.0;
  return ((newVal - oldVal) / oldVal) * 100.0;
}

// weeklyMetrics / weeklyScores: arrays paralelos, ordenados de más vieja a más nueva.
// devicesById: {device_id: device_name}.
// Devuelve una lista de {tipo, severidad, titulo, descripcion}
//   tipo: "oportunidad" | "logro"
//   severidad: "alta" | "media" | "baja" (solo aplica a oportunidad)
function detectOpportunities(weeklyMetrics, weeklyScores, devicesById, trendThresholdPct) {
  trendThresholdPct = trendThresholdPct == null ? 10 : trendThresholdPct;
  const findings = [];
  const n = weeklyScores.length;
  if (n === 0) return findings;

  const half = Math.max(1, Math.floor(n / 2));
  const firstHalfScores = weeklyScores.slice(0, half);
  const secondHalfScores = weeklyScores.slice(half).length ? weeklyScores.slice(half) : weeklyScores.slice(-1);

  // --- Tendencia por categoría de score ---
  const scoreKeys = [
    ["safety", "seguridad"],
    ["efficiency", "eficiencia"],
    ["utilization", "utilización"],
    ["overall", "score general"],
  ];
  for (const [key, label] of scoreKeys) {
    const oldAvg = avgOf(firstHalfScores.map(s => s[key]));
    const newAvg = avgOf(secondHalfScores.map(s => s[key]));
    const change = pctChange(oldAvg, newAvg);

    if (change <= -trendThresholdPct) {
      findings.push({
        tipo: "oportunidad",
        severidad: change <= -2 * trendThresholdPct ? "alta" : "media",
        titulo: `Caída en ${label}`,
        descripcion: (
          `El score de ${label} bajó ${Math.abs(change).toFixed(0)}% comparando la primera mitad `
          + `del período (${oldAvg.toFixed(0)}) contra la más reciente (${newAvg.toFixed(0)}).`
        ),
      });
    } else if (change >= trendThresholdPct) {
      findings.push({
        tipo: "logro",
        severidad: null,
        titulo: `Mejora en ${label}`,
        descripcion: (
          `El score de ${label} subió ${change.toFixed(0)}% comparando la primera mitad `
          + `del período (${oldAvg.toFixed(0)}) contra la más reciente (${newAvg.toFixed(0)}).`
        ),
      });
    }
  }

  // --- Categoría de infracción dominante (última mitad del período) ---
  const categoryTotals = {};
  const recentMetrics = weeklyMetrics.slice(half).length ? weeklyMetrics.slice(half) : weeklyMetrics.slice(-1);
  for (const wm of recentMetrics) {
    for (const [cat, count] of Object.entries(wm.exceptions_by_category)) {
      categoryTotals[cat] = (categoryTotals[cat] || 0) + count;
    }
  }

  const categoryEntries = Object.entries(categoryTotals);
  if (categoryEntries.length) {
    const [topCategory, topCount] = categoryEntries.reduce((a, b) => (b[1] > a[1] ? b : a));
    if (topCount > 0) {
      const label = ANALYZER_CATEGORY_LABELS[topCategory] || topCategory;
      findings.push({
        tipo: "oportunidad",
        severidad: "media",
        titulo: `Foco principal de riesgo: ${label}`,
        descripcion: (
          `${topCount} eventos de ${label} registrados en el período reciente analizado. `
          + `Es la categoría con más incidencia y un buen candidato para una campaña de `
          + `capacitación puntual.`
        ),
      });
    }
  }

  // --- Ralentí alto sostenido ---
  const recentIdling = avgOf(secondHalfScores.map(s => s.idling_pct));
  if (recentIdling >= 25) {
    findings.push({
      tipo: "oportunidad",
      severidad: recentIdling >= 35 ? "alta" : "media",
      titulo: "Ralentí elevado",
      descripcion: (
        `El tiempo de ralentí representa en promedio ${recentIdling.toFixed(0)}% de las horas `
        + `de motor encendido en el período reciente. Reducirlo impacta directo en consumo de `
        + `combustible y desgaste de motor.`
      ),
    });
  }

  // --- Vehículos inactivos en todo el período ---
  const activeAllPeriod = new Set();
  for (const wm of weeklyMetrics) {
    for (const id of wm.active_devices) activeAllPeriod.add(id);
  }

  const inactiveDevices = Object.entries(devicesById)
    .filter(([devId]) => !activeAllPeriod.has(devId))
    .map(([, name]) => name);

  if (inactiveDevices.length) {
    const preview = inactiveDevices.slice(0, 5).join(", ");
    const extra = inactiveDevices.length > 5 ? ` y ${inactiveDevices.length - 5} más` : "";
    findings.push({
      tipo: "oportunidad",
      severidad: "media",
      titulo: `${inactiveDevices.length} vehículo(s) sin actividad en el período`,
      descripcion: (
        `No registraron ningún viaje en todo el período analizado: ${preview}${extra}. `
        + `Vale la pena confirmar si están operativos, dados de baja o con falla de comunicación.`
      ),
    });
  }

  // Ordenar: oportunidades de alta severidad primero, luego media, luego logros
  const severityRank = { alta: 0, media: 1, baja: 2, null: 3 };
  findings.sort((a, b) => {
    const aIsOpportunity = a.tipo !== "oportunidad" ? 1 : 0;
    const bIsOpportunity = b.tipo !== "oportunidad" ? 1 : 0;
    if (aIsOpportunity !== bIsOpportunity) return aIsOpportunity - bIsOpportunity;
    const aRank = severityRank[a.severidad] != null ? severityRank[a.severidad] : 3;
    const bRank = severityRank[b.severidad] != null ? severityRank[b.severidad] : 3;
    return aRank - bRank;
  });

  return findings;
}
