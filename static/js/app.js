// UI en React sin build step (React.createElement a mano, sin JSX/babel).
// Corre como Add-In de MyGeotab: el entry point geotab.addin.cesettiInsightsV2
// (al final de este archivo) recibe el "api" ya autenticado por el SDK y
// renderiza App directo, sin selector de cliente ni login (eso solo hace
// falta en la versión standalone). El mapeo de reglas/grupo/combustible que
// se edita desde "Configurar" se guarda en localStorage (settings.js), por
// base de datos. dashboard.js/metrics.js/fuel.js/analyzer.js/groups.js son
// los mismos módulos de cálculo, sin cambios.

const { useState, useEffect, useRef } = React;
const e = React.createElement;

function scoreColor(v) {
  if (v >= 75) return "var(--good)";
  if (v >= 50) return "var(--warning)";
  return "var(--critical)";
}

function ScoreCard({ label, value, isOverall }) {
  return e("div", { className: "card" + (isOverall ? " overall" : "") },
    e("div", { className: "label" }, label),
    e("div", { className: "value", style: !isOverall ? { color: scoreColor(value) } : {} }, value != null ? value.toFixed(0) : "-"),
    e("div", { className: "bar-track" },
      e("div", { className: "bar-fill", style: { width: (value || 0) + "%", background: isOverall ? "var(--accent)" : scoreColor(value) } })
    )
  );
}

function EvolutionChart({ evolution }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !evolution || evolution.length === 0) return;
    if (chartRef.current) chartRef.current.destroy();

    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels: evolution.map(w => w.week_start),
        datasets: [
          { label: "General", data: evolution.map(w => w.overall), borderColor: "#ffcc33", backgroundColor: "transparent", tension: 0.3, borderWidth: 2.5 },
          { label: "Seguridad", data: evolution.map(w => w.safety), borderColor: "#e66767", backgroundColor: "transparent", tension: 0.3, borderWidth: 1.5 },
          { label: "Eficiencia", data: evolution.map(w => w.efficiency), borderColor: "#3987e5", backgroundColor: "transparent", tension: 0.3, borderWidth: 1.5 },
          { label: "Utilización", data: evolution.map(w => w.utilization), borderColor: "#199e70", backgroundColor: "transparent", tension: 0.3, borderWidth: 1.5 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { min: 0, max: 100, grid: { color: "#2a3655" }, ticks: { color: "#93a1c4" } },
          x: { grid: { color: "#1e2a4a" }, ticks: { color: "#93a1c4" } },
        },
        plugins: { legend: { labels: { color: "#e6ebf5", boxWidth: 12, font: { size: 11.5 } } } },
      },
    });
  }, [evolution]);

  return e("div", { style: { height: "300px" } }, e("canvas", { ref: canvasRef }));
}

function formatNumber(v, decimals) {
  if (v == null) return "-";
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function formatMoney(v) {
  if (v == null) return "-";
  return "$" + Math.round(v).toLocaleString();
}

// Hook + helpers genéricos para hacer clickeables los headers de las tablas
// (data-table) y ordenar sus filas por esa columna, sin tocar cómo cada panel
// arma sus datos.
function useSortableTable() {
  const [sort, setSort] = useState({ key: null, dir: "desc" });
  function onSort(key, type) {
    setSort(prev => prev.key === key
      ? { key, dir: prev.dir === "asc" ? "desc" : "asc" }
      : { key, dir: type === "string" ? "asc" : "desc" }
    );
  }
  return [sort, onSort];
}

function sortRows(rows, sort, accessors) {
  if (!sort.key) return rows;
  const accessor = (accessors && accessors[sort.key]) || (r => r[sort.key]);
  const sorted = rows.slice().sort((a, b) => {
    const av = accessor(a);
    const bv = accessor(b);
    if (typeof av === "string" || typeof bv === "string") {
      return String(av ?? "").localeCompare(String(bv ?? ""), "es", { sensitivity: "base" });
    }
    const an = av == null ? -Infinity : av;
    const bn = bv == null ? -Infinity : bv;
    return an - bn;
  });
  return sort.dir === "asc" ? sorted : sorted.reverse();
}

function SortableTh({ label, sortKey, type, sort, onSort }) {
  const active = sort.key === sortKey;
  return e("th", {
    className: "sortable-th" + (active ? " active" : ""),
    onClick: () => onSort(sortKey, type),
  }, label, e("span", { className: "sort-arrow" }, active ? (sort.dir === "asc" ? "▲" : "▼") : ""));
}

function FuelPriceForm({ pricePerLiter, onSaved, patchSettings }) {
  const [value, setValue] = useState(pricePerLiter || 0);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => { setValue(pricePerLiter || 0); }, [pricePerLiter]);

  function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    patchSettings({ fuel: { price_per_liter: parseFloat(value) || 0 } })
      .then(newSettings => { setSaved(true); onSaved && onSaved(newSettings); })
      .catch(err => setError(err.message || "Error guardando"))
      .finally(() => setSaving(false));
  }

  return e("div", { className: "fuel-price-form" },
    e("span", null, "Precio del litro de combustible:"),
    e("input", {
      type: "number", min: 0, step: "0.01", value: value,
      onChange: ev => setValue(ev.target.value),
    }),
    e("button", { onClick: save, disabled: saving }, saving ? "Guardando..." : "Guardar"),
    saved && e("span", { className: "saved-msg" }, "Guardado"),
    error && e("span", { className: "saved-msg", style: { color: "var(--critical)" } }, error)
  );
}

function SavingsOpportunityPanel({ savings }) {
  return e("div", { className: "panel savings-panel" },
    e("h2", null, "Ahorro potencial estimado"),
    e("div", { className: "savings-headline" }, formatMoney(savings.estimated_savings)),
    e("div", { className: "savings-breakdown" },
      e("div", { className: "savings-item" },
        e("div", { className: "label" }, "Por ralentí (vehículos por encima de la mediana de flota)"),
        e("div", { className: "value" }, formatMoney(savings.idling_excess_cost) + " · " + formatNumber(savings.idling_excess_liters, 1) + " L")
      ),
      e("div", { className: "savings-item" },
        e("div", { className: "label" }, "Por consumo excedente (outliers vs. promedio de su clase)"),
        e("div", { className: "value" }, formatMoney(savings.fuel_excess_cost) + " · " + formatNumber(savings.fuel_excess_liters, 1) + " L")
      )
    )
  );
}

function IdleEstimateForm({ rates, onSaved, patchSettings }) {
  const [form, setForm] = useState({ pesados: 0, livianos: 0, otros: 0 });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setForm({
      pesados: (rates && rates.pesados) || 0,
      livianos: (rates && rates.livianos) || 0,
      otros: (rates && rates.otros) || 0,
    });
  }, [rates]);

  function update(field) {
    return ev => setForm(f => ({ ...f, [field]: ev.target.value }));
  }

  function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    patchSettings({ fuel: {
      idle_consumption_l_per_hour: {
        pesados: parseFloat(form.pesados) || 0,
        livianos: parseFloat(form.livianos) || 0,
        otros: parseFloat(form.otros) || 0,
      },
    } })
      .then(newSettings => { setSaved(true); onSaved && onSaved(newSettings); })
      .catch(err => setError(err.message || "Error guardando"))
      .finally(() => setSaving(false));
  }

  return e("div", { className: "fuel-price-form", style: { flexWrap: "wrap" } },
    e("span", null, "Estimado de consumo en ralentí (L/hora) para vehículos sin medición:"),
    e("span", { style: { color: "var(--text-dim)", fontSize: 12.5 } }, "Pesados"),
    e("input", { type: "number", min: 0, step: "0.1", style: { width: 70 }, value: form.pesados, onChange: update("pesados") }),
    e("span", { style: { color: "var(--text-dim)", fontSize: 12.5 } }, "Livianos"),
    e("input", { type: "number", min: 0, step: "0.1", style: { width: 70 }, value: form.livianos, onChange: update("livianos") }),
    e("span", { style: { color: "var(--text-dim)", fontSize: 12.5 } }, "Otros"),
    e("input", { type: "number", min: 0, step: "0.1", style: { width: 70 }, value: form.otros, onChange: update("otros") }),
    e("button", { onClick: save, disabled: saving }, saving ? "Guardando..." : "Guardar"),
    saved && e("span", { className: "saved-msg" }, "Guardado"),
    error && e("span", { className: "saved-msg", style: { color: "var(--critical)" } }, error)
  );
}

function IdlingCostPanel({ idlingCost, onPriceSaved, patchSettings }) {
  const [sort, onSort] = useSortableTable();
  const rows = sortRows(idlingCost.by_vehicle, sort, { device_name: v => v.device_name });

  return e("div", { className: "panel", style: { marginTop: 18 } },
    e("h2", null, "Costo de ralentí"),
    e(FuelPriceForm, { pricePerLiter: idlingCost.price_per_liter, onSaved: onPriceSaved, patchSettings }),
    e(IdleEstimateForm, { rates: idlingCost.idle_consumption_l_per_hour, onSaved: onPriceSaved, patchSettings }),
    e("div", { className: "totals-row" },
      e("div", { className: "stat" },
        e("div", { className: "label" }, "Litros consumidos en ralentí (flota)"),
        e("div", { className: "value" }, formatNumber(idlingCost.total_idle_liters, 1) + " L")
      ),
      e("div", { className: "stat" },
        e("div", { className: "label" }, "Costo total estimado"),
        e("div", { className: "value" }, formatMoney(idlingCost.total_idle_cost))
      )
    ),
    idlingCost.by_vehicle.length === 0
      ? e("div", { className: "finding-desc" }, "Sin eventos de ralentí en el período.")
      : e("table", { className: "data-table" },
          e("thead", null, e("tr", null,
            e(SortableTh, { label: "Vehículo", sortKey: "device_name", type: "string", sort, onSort }),
            e(SortableTh, { label: "Horas ralentí", sortKey: "idle_hours", sort, onSort }),
            e(SortableTh, { label: "Horas manejo", sortKey: "driving_hours", sort, onSort }),
            e(SortableTh, { label: "Ralentí/manejo", sortKey: "idle_efficiency_ratio", sort, onSort }),
            e(SortableTh, { label: "Eventos", sortKey: "idle_event_count", sort, onSort }),
            e(SortableTh, { label: "Litros", sortKey: "idle_liters", sort, onSort }),
            e(SortableTh, { label: "Costo", sortKey: "idle_cost", sort, onSort })
          )),
          e("tbody", null, rows.map(v => e("tr", { key: v.device_id },
            e("td", null, v.device_name), e("td", { className: "num" }, formatNumber(v.idle_hours, 1)),
            e("td", { className: "num" }, formatNumber(v.driving_hours, 1)),
            e("td", { className: "num" }, v.idle_efficiency_ratio != null ? formatNumber(v.idle_efficiency_ratio * 100, 1) + "%" : "-"),
            e("td", { className: "num" }, v.idle_event_count),
            e("td", { className: "num" }, formatNumber(v.idle_liters, 1) + (v.is_estimated ? " (estimado)" : "")),
            e("td", { className: "num" }, formatMoney(v.idle_cost))
          )))
        )
  );
}

function IdleEfficiencyPanel({ idlingCost }) {
  const [sort, onSort] = useSortableTable();
  const filtered = idlingCost.by_vehicle.filter(v => v.driving_hours > 0 && v.idle_efficiency_ratio != null);
  const ranked = sort.key
    ? sortRows(filtered, sort, { device_name: v => v.device_name })
    : filtered.slice().sort((a, b) => a.idle_efficiency_ratio - b.idle_efficiency_ratio);

  return e("div", { className: "panel", style: { marginTop: 18 } },
    e("h2", null, "Ranking de eficiencia de ralentí"),
    e("div", { className: "info-box", style: { marginBottom: 14 } },
      "Ordenado de menos a más eficiente. Eficiencia = 100% cuando el vehículo no tiene ralentí, y baja " +
      "hasta 0% a medida que las horas de ralentí se acercan o superan a las horas de manejo (nunca es negativa ni supera el 100%)."
    ),
    ranked.length === 0
      ? e("div", { className: "finding-desc" }, "Sin vehículos con horas de manejo registradas en el período.")
      : e("table", { className: "data-table" },
          e("thead", null, e("tr", null,
            e(SortableTh, { label: "Vehículo", sortKey: "device_name", type: "string", sort, onSort }),
            e(SortableTh, { label: "Horas manejo", sortKey: "driving_hours", sort, onSort }),
            e(SortableTh, { label: "Horas ralentí", sortKey: "idle_hours", sort, onSort }),
            e(SortableTh, { label: "Eficiencia", sortKey: "idle_efficiency_ratio", sort, onSort })
          )),
          e("tbody", null, ranked.map(v => e("tr", { key: v.device_id },
            e("td", null, v.device_name),
            e("td", { className: "num" }, formatNumber(v.driving_hours, 1)),
            e("td", { className: "num" }, formatNumber(v.idle_hours, 1)),
            e("td", { className: "num" }, formatNumber(v.idle_efficiency_ratio * 100, 1) + "%")
          )))
        )
  );
}

const VEHICLE_CLASS_LABELS = { pesados: "Pesados", livianos: "Livianos", otros: "Otros / sin clasificar" };

function computeLiveSavings(data, threshold) {
  const savings = data.savings_opportunity;
  const fuelConsumption = data.fuel_consumption;
  const pricePerLiter = data.idling_cost.price_per_liter || 0;
  const fuelExcessLiters = Math.round(
    fuelConsumption.by_vehicle
      .filter(v => v.deviation_pct > 0 && Math.abs(v.deviation_pct) >= threshold)
      .reduce((sum, v) => sum + (v.l_per_100km - v.reference_avg_l_per_100km) / 100 * v.total_distance_km, 0) * 10
  ) / 10;
  const fuelExcessCost = Math.round(fuelExcessLiters * pricePerLiter);
  const totalExcessLiters = Math.round((savings.idling_excess_liters + fuelExcessLiters) * 10) / 10;
  return {
    ...savings,
    fuel_excess_liters: fuelExcessLiters,
    fuel_excess_cost: fuelExcessCost,
    total_excess_liters: totalExcessLiters,
    estimated_savings: Math.round(totalExcessLiters * pricePerLiter),
  };
}

function FuelConsumptionPanel({ fuelConsumption, threshold, onThresholdChange, onThresholdSaved, patchSettings }) {
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);
  const [selectedClass, setSelectedClass] = useState("all");
  const [sort, onSort] = useSortableTable();

  function saveThreshold() {
    setSaving(true);
    setSaved(false);
    setError(null);
    patchSettings({ fuel: { consumption_outlier_threshold_pct: threshold } })
      .then(newSettings => { setSaved(true); onThresholdSaved && onThresholdSaved(newSettings); })
      .catch(err => setError(err.message || "Error guardando"))
      .finally(() => setSaving(false));
  }

  const classEntries = Object.entries(fuelConsumption.class_avgs_l_per_100km || {});
  const classFiltered = selectedClass === "all"
    ? fuelConsumption.by_vehicle
    : fuelConsumption.by_vehicle.filter(v => v.vehicle_class === selectedClass);
  const visibleVehicles = sortRows(classFiltered, sort, {
    device_name: v => v.device_name,
    vehicle_class: v => VEHICLE_CLASS_LABELS[v.vehicle_class] || v.vehicle_class,
  });

  return e("div", { className: "panel", style: { marginTop: 18 } },
    e("h2", null, "Consumo de combustible (L/100km)"),
    e("div", { className: "info-box", style: { marginBottom: 14 } },
      "El desvío de cada vehículo se compara contra el promedio de su propia clase " +
      "(Pesados / Livianos, según los grupos ya definidos en Geotab), no contra toda la flota mezclada. " +
      "Los vehículos sin consumo registrado en el período no se contemplan en los promedios."
    ),
    e("div", { className: "toggle-group" },
      e("button", {
        className: "toggle-btn" + (selectedClass === "all" ? " active" : ""),
        onClick: () => setSelectedClass("all"),
      }, "General"),
      classEntries.map(([cls]) => e("button", {
        key: cls,
        className: "toggle-btn" + (selectedClass === cls ? " active" : ""),
        onClick: () => setSelectedClass(cls),
      }, VEHICLE_CLASS_LABELS[cls] || cls))
    ),
    e("div", { className: "totals-row" },
      selectedClass === "all"
        ? classEntries.map(([cls, avg]) => e("div", { className: "stat", key: cls },
            e("div", { className: "label" }, "Promedio " + (VEHICLE_CLASS_LABELS[cls] || cls)),
            e("div", { className: "value" }, formatNumber(avg, 2) + " L/100km")
          ))
        : e("div", { className: "stat" },
            e("div", { className: "label" }, "Promedio " + (VEHICLE_CLASS_LABELS[selectedClass] || selectedClass)),
            e("div", { className: "value" }, formatNumber(fuelConsumption.class_avgs_l_per_100km[selectedClass] || 0, 2) + " L/100km")
          )
    ),
    e("div", { className: "threshold-row" },
      e("span", { style: { color: "var(--text-dim)", fontSize: 13 } }, "Umbral de desvío marcado como outlier: ±" + threshold + "%"),
      e("input", {
        type: "range", min: 0, max: 100, step: 1, value: threshold,
        onChange: ev => onThresholdChange(parseFloat(ev.target.value)),
      }),
      e("button", { className: "icon-btn", onClick: saveThreshold, disabled: saving }, saving ? "Guardando..." : "Guardar como default"),
      saved && e("span", { className: "saved-msg" }, "Guardado"),
      error && e("span", { className: "saved-msg", style: { color: "var(--critical)" } }, error)
    ),
    visibleVehicles.length === 0
      ? e("div", { className: "finding-desc" }, "Sin datos de consumo con distancia recorrida en el período.")
      : e("table", { className: "data-table" },
          e("thead", null, e("tr", null,
            e(SortableTh, { label: "Vehículo", sortKey: "device_name", type: "string", sort, onSort }),
            e(SortableTh, { label: "Clase", sortKey: "vehicle_class", type: "string", sort, onSort }),
            e(SortableTh, { label: "L/100km", sortKey: "l_per_100km", sort, onSort }),
            e(SortableTh, { label: "Desvío vs. su clase", sortKey: "deviation_pct", sort, onSort }),
            e(SortableTh, { label: "Distancia", sortKey: "total_distance_km", sort, onSort }),
            e(SortableTh, { label: "Litros", sortKey: "total_liters", sort, onSort })
          )),
          e("tbody", null, visibleVehicles.map(v => e("tr", { key: v.device_id, className: Math.abs(v.deviation_pct) >= threshold ? "outlier" : "" },
            e("td", null, v.device_name),
            e("td", null, VEHICLE_CLASS_LABELS[v.vehicle_class] || v.vehicle_class),
            e("td", { className: "num" }, formatNumber(v.l_per_100km, 2)),
            e("td", { className: "num" }, (v.deviation_pct > 0 ? "+" : "") + formatNumber(v.deviation_pct, 1) + "%"),
            e("td", { className: "num" }, formatNumber(v.total_distance_km, 1) + " km"),
            e("td", { className: "num" }, formatNumber(v.total_liters, 1) + " L")
          )))
        )
  );
}

function loadMilestones(clientId) {
  try {
    return JSON.parse(localStorage.getItem("geotab_milestones_" + clientId) || "[]");
  } catch (err) {
    return [];
  }
}

function saveMilestones(clientId, milestones) {
  localStorage.setItem("geotab_milestones_" + clientId, JSON.stringify(milestones));
}

function weekIndexForDate(evolution, dateStr) {
  let idx = 0;
  for (let i = 0; i < evolution.length; i++) {
    if (evolution[i].week_start <= dateStr) idx = i;
  }
  return idx;
}

function milestoneLinesPlugin(milestones, evolution) {
  return {
    id: "milestoneLines",
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea) return;
      milestones.forEach(m => {
        const idx = weekIndexForDate(evolution, m.date);
        const x = scales.x.getPixelForValue(idx);
        ctx.save();
        ctx.strokeStyle = "#ffcc33";
        ctx.setLineDash([4, 4]);
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = "#ffcc33";
        ctx.font = "10.5px sans-serif";
        ctx.textAlign = "left";
        ctx.fillText(m.label, x + 4, chartArea.top + 12);
        ctx.restore();
      });
    },
  };
}

const EXCEPTION_CATEGORY_LABELS = {
  velocidad: "Exceso de velocidad",
  frenado_brusco: "Frenados bruscos",
  aceleracion_brusca: "Aceleraciones bruscas",
  giro_brusco: "Giros bruscos",
  cinturon: "Cinturón de seguridad",
  distraccion: "Conductor distraído",
  telefono: "Uso de teléfono celular",
  ralenti: "Ralentí",
  reversa: "Marcha atrás",
  otro: "Otras infracciones",
};

// Colores categóricos: orden fijo, cada categoría siempre el mismo color sin
// importar qué filtro esté activo (así la identidad de la serie no cambia).
const EXCEPTION_CATEGORY_COLORS = {
  velocidad: "#e66767",
  frenado_brusco: "#d95926",
  aceleracion_brusca: "#c98500",
  giro_brusco: "#d55181",
  cinturon: "#3987e5",
  distraccion: "#9085e9",
  telefono: "#199e70",
  ralenti: "#34d399",
  reversa: "#008300",
  otro: "#93a1c4",
};

function ExceptionTimelineChart({ evolution, milestones, categories }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !evolution || evolution.length === 0) return;
    if (chartRef.current) chartRef.current.destroy();

    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels: evolution.map(w => w.week_start),
        datasets: [
          ...categories.map(cat => ({
            label: EXCEPTION_CATEGORY_LABELS[cat],
            data: evolution.map(w => (w.exceptions_by_category || {})[cat] || 0),
            borderColor: EXCEPTION_CATEGORY_COLORS[cat],
            backgroundColor: "transparent",
            tension: 0.3,
            borderWidth: 1.75,
            yAxisID: "y",
            // "otro" es una categoría residual que suele tener volumen mucho mayor
            // al resto y aplasta la escala; arranca oculta, togglable desde la leyenda.
            hidden: cat === "otro",
          })),
          {
            label: "Km recorridos",
            data: evolution.map(w => w.total_distance_km || 0),
            borderColor: "#e6ebf5",
            backgroundColor: "transparent",
            borderDash: [5, 3],
            borderWidth: 2,
            tension: 0.3,
            yAxisID: "y1",
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { beginAtZero: true, grid: { color: "#2a3655" }, ticks: { color: "#93a1c4" } },
          y1: {
            beginAtZero: true, position: "right",
            grid: { drawOnChartArea: false },
            ticks: { color: "#93a1c4" },
            title: { display: true, text: "km", color: "#93a1c4" },
          },
          x: { grid: { color: "#1e2a4a" }, ticks: { color: "#93a1c4" } },
        },
        plugins: { legend: { labels: { color: "#e6ebf5", boxWidth: 12, font: { size: 11.5 } } } },
      },
      plugins: [milestoneLinesPlugin(milestones, evolution)],
    });
  }, [evolution, milestones, categories]);

  return e("div", { style: { height: "300px" } }, e("canvas", { ref: canvasRef }));
}

function milestoneImpact(evolution, milestone) {
  const idx = weekIndexForDate(evolution, milestone.date);
  const before = evolution.slice(0, idx);
  const after = evolution.slice(idx);
  const avg = arr => arr.length ? arr.reduce((s, w) => s + w.weighted_exceptions, 0) / arr.length : 0;
  const beforeAvg = avg(before);
  const afterAvg = avg(after);
  const change = beforeAvg > 0 ? ((afterAvg - beforeAvg) / beforeAvg * 100) : 0;
  return { beforeAvg, afterAvg, change, hasBefore: before.length > 0 };
}

function ExceptionTimelinePanel({ evolution, clientId, exceptionCategories }) {
  const [milestones, setMilestones] = useState([]);
  const [date, setDate] = useState("");
  const [label, setLabel] = useState("");

  useEffect(() => { setMilestones(loadMilestones(clientId)); }, [clientId]);

  function addMilestone() {
    if (!date || !label.trim()) return;
    const next = [...milestones, { date, label: label.trim() }].sort((a, b) => a.date.localeCompare(b.date));
    setMilestones(next);
    saveMilestones(clientId, next);
    setDate("");
    setLabel("");
  }

  function removeMilestone(i) {
    const next = milestones.filter((_, idx) => idx !== i);
    setMilestones(next);
    saveMilestones(clientId, next);
  }

  return e("div", { className: "panel", style: { marginTop: 18 } },
    e("h2", null, "Evolución de eventos de excepción"),
    e(ExceptionTimelineChart, { evolution, milestones, categories: exceptionCategories }),
    e("div", { className: "milestone-form" },
      e("input", { type: "date", value: date, onChange: ev => setDate(ev.target.value) }),
      e("input", { type: "text", placeholder: "Hito (ej. capacitación de manejo defensivo)", value: label, onChange: ev => setLabel(ev.target.value) }),
      e("button", { onClick: addMilestone }, "Agregar hito")
    ),
    milestones.length > 0 && e("div", { className: "milestone-list" },
      milestones.map((m, i) => {
        const impact = milestoneImpact(evolution, m);
        return e("div", { className: "milestone-item", key: i },
          e("div", { className: "info" },
            e("span", { className: "date" }, m.date), e("span", null, m.label),
            impact.hasBefore && e("div", { className: "impact" },
              `Antes: ${formatNumber(impact.beforeAvg, 1)}/sem · Después: ${formatNumber(impact.afterAvg, 1)}/sem · ` +
              `${impact.change <= 0 ? "mejora" : "suba"} de ${formatNumber(Math.abs(impact.change), 0)}%`
            )
          ),
          e("button", { onClick: () => removeMilestone(i) }, "Eliminar")
        );
      })
    )
  );
}

function ratesChartData(evolution, groupBy, exceptionCategories, ruleLabels) {
  const keys = groupBy === "rule"
    ? Object.keys(ruleLabels || {})
    : exceptionCategories;
  const labelFor = groupBy === "rule" ? (k => ruleLabels[k] || k) : (k => EXCEPTION_CATEGORY_LABELS[k] || k);
  const colorFor = (k, i) => groupBy === "rule"
    ? `hsl(${(i * 47) % 360}, 70%, 60%)`
    : (EXCEPTION_CATEGORY_COLORS[k] || "#93a1c4");

  return keys.map((key, i) => ({
    label: labelFor(key),
    data: evolution.map(w => {
      const counts = groupBy === "rule" ? (w.exceptions_by_rule || {}) : (w.exceptions_by_category || {});
      const count = counts[key] || 0;
      const distanceKm = w.total_distance_km || 0;
      return distanceKm > 0 ? Math.round((count / distanceKm) * 100 * 100) / 100 : 0;
    }),
    borderColor: colorFor(key, i),
    backgroundColor: "transparent",
    tension: 0.3,
    borderWidth: 1.75,
    hidden: groupBy === "category" && key === "otro",
  }));
}

function ExceptionRateChart({ evolution, groupBy, exceptionCategories, ruleLabels }) {
  const canvasRef = useRef(null);
  const chartRef = useRef(null);

  useEffect(() => {
    if (!canvasRef.current || !evolution || evolution.length === 0) return;
    if (chartRef.current) chartRef.current.destroy();

    chartRef.current = new Chart(canvasRef.current, {
      type: "line",
      data: {
        labels: evolution.map(w => w.week_start),
        datasets: ratesChartData(evolution, groupBy, exceptionCategories, ruleLabels),
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          y: { beginAtZero: true, grid: { color: "#2a3655" }, ticks: { color: "#93a1c4" } },
          x: { grid: { color: "#1e2a4a" }, ticks: { color: "#93a1c4" } },
        },
        plugins: { legend: { labels: { color: "#e6ebf5", boxWidth: 12, font: { size: 11.5 } } } },
      },
    });
  }, [evolution, groupBy, exceptionCategories, ruleLabels]);

  return e("div", { style: { height: "300px" } }, e("canvas", { ref: canvasRef }));
}

function ExceptionRatePanel({ evolution, exceptionCategories, ruleLabels }) {
  const [groupBy, setGroupBy] = useState("category");
  const hasRules = ruleLabels && Object.keys(ruleLabels).length > 0;

  return e("div", { className: "panel", style: { marginTop: 18 } },
    e("h2", null, "Eventos cada 100km"),
    e("div", { className: "toggle-group" },
      e("button", {
        className: "toggle-btn" + (groupBy === "category" ? " active" : ""),
        onClick: () => setGroupBy("category"),
      }, "Por categoría"),
      e("button", {
        className: "toggle-btn" + (groupBy === "rule" ? " active" : ""),
        onClick: () => setGroupBy("rule"),
        disabled: !hasRules,
      }, "Por regla")
    ),
    e(ExceptionRateChart, { evolution, groupBy, exceptionCategories, ruleLabels })
  );
}

function Findings({ opportunities }) {
  if (!opportunities || opportunities.length === 0) {
    return e("div", { className: "finding-desc" }, "No se detectaron hallazgos relevantes en el período.");
  }
  return opportunities.map((f, i) => {
    const cls = f.tipo === "logro" ? "logro" : f.severidad;
    const tagLabel = f.tipo === "logro" ? "logro" : (f.severidad === "alta" ? "prioridad alta" : "prioridad media");
    return e("div", { className: "finding " + cls, key: i },
      e("div", { className: "finding-title" }, f.titulo, e("span", { className: "tag " + cls }, tagLabel)),
      e("div", { className: "finding-desc" }, f.descripcion)
    );
  });
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function defaultDateRange() {
  const today = new Date();
  const from = new Date(today);
  from.setDate(from.getDate() - 12 * 7);
  return { from: isoDate(from), to: isoDate(today) };
}

function flattenGroupTree(nodes, depth) {
  depth = depth || 0;
  let out = [];
  (nodes || []).forEach(n => {
    out.push({ id: n.id, name: n.name, depth });
    out = out.concat(flattenGroupTree(n.children, depth + 1));
  });
  return out;
}

function RuleMappingPanel({ api, config, onChange }) {
  const [rules, setRules] = useState([]);
  const [groupTree, setGroupTree] = useState([]);
  const [loadingRules, setLoadingRules] = useState(false);

  useEffect(() => {
    setLoadingRules(true);
    Promise.all([
      fetchRules(api),
      fetchGroupTree(api),
    ])
      .then(([rulesList, groups]) => {
        setRules(Array.isArray(rulesList) ? rulesList : []);
        setGroupTree(Array.isArray(groups) ? groups : []);
      })
      .catch(() => { setRules([]); setGroupTree([]); })
      .finally(() => setLoadingRules(false));
  }, [api]);

  function toggleRule(ruleId) {
    const mapping = { ...config.rule_mapping };
    if (ruleId in mapping) delete mapping[ruleId];
    else mapping[ruleId] = "otro";
    onChange({ rule_mapping: mapping });
  }

  function setRuleCategory(ruleId, category) {
    onChange({ rule_mapping: { ...config.rule_mapping, [ruleId]: category } });
  }

  function setGroupFilter(groupId) {
    onChange({ group_filter_id: groupId || null });
  }

  const flatGroups = flattenGroupTree(groupTree);
  const mappedCount = Object.keys(config.rule_mapping || {}).length;

  return e("div", { className: "panel", style: { marginBottom: 18 } },
    e("h2", null, "Configuración del análisis"),
    e("div", { className: "group-select-row" },
      e("span", null, "Grupo de vehículos a analizar:"),
      e("select", {
        value: config.group_filter_id || "",
        onChange: ev => setGroupFilter(ev.target.value),
      },
        e("option", { value: "" }, "Toda la flota"),
        flatGroups.map(g => e("option", { key: g.id, value: g.id }, "—".repeat(g.depth) + " " + g.name))
      )
    ),
    e("div", { style: { color: "var(--text-dim)", fontSize: 12.5, marginBottom: 8 } },
      "Marcá las reglas a incluir y asignales su categoría real. " + mappedCount + " regla(s) seleccionada(s). " +
      "Los cambios se guardan solos en este navegador."
    ),
    loadingRules
      ? e("div", { className: "finding-desc" }, "Cargando reglas...")
      : e("div", { className: "mapping-list" },
          rules.map(r => e("div", { className: "mapping-row", key: r.id },
            e("input", {
              type: "checkbox", id: "map-" + r.id,
              checked: r.id in config.rule_mapping,
              onChange: () => toggleRule(r.id),
            }),
            e("label", { htmlFor: "map-" + r.id }, r.name),
            e("select", {
              value: config.rule_mapping[r.id] || "otro",
              disabled: !(r.id in config.rule_mapping),
              onChange: ev => setRuleCategory(r.id, ev.target.value),
            },
              EXCEPTION_CATEGORIES.map(cat => e("option", { key: cat, value: cat }, EXCEPTION_CATEGORY_LABELS[cat] || cat))
            )
          ))
        )
  );
}

function App({ api, database }) {
  const [dateRange, setDateRange] = useState(defaultDateRange());
  const [showConfig, setShowConfig] = useState(true);
  const [settings, setSettings] = useState(defaultDbSettings());
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [threshold, setThreshold] = useState(20);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  function patchSettings(patch) {
    return updateDbSettings(database, settings, patch).then(newSettings => {
      setSettings(newSettings);
      return newSettings;
    });
  }

  function updateAnalysisConfig(patch) {
    patchSettings(patch);
  }

  // settingsOverride: si viene (justo después de guardar un ajuste), se usa
  // tal cual en vez del estado de React, para no pisarse con un guardado que
  // todavía no terminó de propagarse al estado.
  async function runAnalysis(showSpinner, settingsOverride) {
    if (showSpinner) setLoading(true);
    setError(null);
    try {
      const { fromDate, toDate } = resolveDateRange(dateRange.from, dateRange.to);
      const effective = settingsOverride || settings;
      const d = await buildDashboardData(api, {
        database, fromDate, toDate,
        ruleMapping: effective.rule_mapping,
        groupFilterId: effective.group_filter_id,
        dbSettings: effective,
      });
      setData(d);
      setThreshold(d.fuel_consumption.outlier_threshold_pct);
    } catch (err) {
      setError(err.message || "Error consultando el dashboard.");
    } finally {
      setLoading(false);
    }
  }

  // Se llama después de guardar cualquier ajuste (precio de combustible,
  // consumo estimado, umbral de outlier): recalcula con el valor recién
  // guardado, sin esperar al próximo render.
  function handleSettingsSaved(newSettings) {
    runAnalysis(false, newSettings);
  }

  useEffect(() => {
    setData(null);
    setError(null);
    setSettingsLoaded(false);
    loadDbSettings(database).then(s => {
      setSettings(s);
      setSettingsLoaded(true);
    });
    // No dispara la carga del dashboard: hay que confirmar reglas/grupo y
    // hacer click en "Analizar".
  }, [database]);

  const canAnalyze = settingsLoaded && Object.keys(settings.rule_mapping || {}).length > 0;

  return e("div", null,
    e("div", { className: "topbar" },
      e("div", { className: "brand" },
        e("div", { className: "brand-dot" }),
        e("div", null,
          e("h1", null, "Geotab Insights"),
          e("span", null, database)
        )
      ),
      e("div", { className: "toolbar-controls" },
        e("div", { className: "date-range" },
          e("input", { type: "date", value: dateRange.from, onChange: ev => setDateRange(r => ({ ...r, from: ev.target.value })) }),
          e("span", null, "a"),
          e("input", { type: "date", value: dateRange.to, onChange: ev => setDateRange(r => ({ ...r, to: ev.target.value })) })
        ),
        e("button", { className: "icon-btn" + (showConfig ? " active" : ""), onClick: () => setShowConfig(s => !s) }, "Configurar"),
        e("button", {
          className: "analyze-btn",
          onClick: () => runAnalysis(true),
          disabled: !canAnalyze,
        }, data ? "Actualizar" : "Analizar")
      )
    ),
    e("main", null,
      showConfig && e(RuleMappingPanel, { api, config: settings, onChange: updateAnalysisConfig }),
      error && e("div", { className: "error-box" }, error),
      loading && e("div", { className: "center-msg" }, "Consultando MyGeotab, puede tardar unos segundos..."),
      !data && !loading && !error && settingsLoaded && e("div", { className: "center-msg" }, 'Confirmá las reglas y el grupo a analizar, y hacé click en "Analizar".'),
      data && e(React.Fragment, null,
        e("div", { className: "cards" },
          e(ScoreCard, { label: "SCORE GENERAL", value: data.score.overall, isOverall: true }),
          e(ScoreCard, { label: "SEGURIDAD", value: data.score.safety }),
          e(ScoreCard, { label: "EFICIENCIA", value: data.score.efficiency }),
          e(ScoreCard, { label: "UTILIZACIÓN", value: data.score.utilization })
        ),
        data.fuel_data_available && e(SavingsOpportunityPanel, { savings: computeLiveSavings(data, threshold) }),
        e("div", { className: "grid-2" },
          e("div", { className: "panel" },
            e("h2", null, "Evolución semanal (" + data.weeks_analyzed + " semanas)"),
            e(EvolutionChart, { evolution: data.evolution })
          ),
          e("div", { className: "panel" },
            e("h2", null, "Resumen de flota"),
            e("div", { className: "summary-row" }, e("span", null, "Vehículos totales"), e("span", null, data.fleet_summary.total_devices)),
            e("div", { className: "summary-row" }, e("span", null, "Activos última semana"), e("span", null, data.fleet_summary.active_last_week)),
            e("div", { className: "summary-row" }, e("span", null, "Distancia recorrida (período)"), e("span", null, data.fleet_summary.total_distance_km_period.toLocaleString() + " km")),
            e("div", { className: "summary-row" }, e("span", null, "Viajes en el período"), e("span", null, data.fleet_summary.total_trips_period)),
            e("div", { className: "summary-row" }, e("span", null, "Generado"), e("span", null, new Date(data.generated_at).toLocaleString()))
          )
        ),
        data.fuel_data_available
          ? e(React.Fragment, null,
              e(IdlingCostPanel, { idlingCost: data.idling_cost, onPriceSaved: handleSettingsSaved, patchSettings }),
              e(IdleEfficiencyPanel, { idlingCost: data.idling_cost }),
              e(FuelConsumptionPanel, { fuelConsumption: data.fuel_consumption, threshold, onThresholdChange: setThreshold, onThresholdSaved: handleSettingsSaved, patchSettings })
            )
          : e("div", { className: "panel", style: { marginTop: 18 } },
              e("h2", null, "Costo de ralentí y consumo de combustible"),
              e("div", { className: "info-box" }, "Este cliente no reporta datos de combustible en MyGeotab (objeto FuelUsed no disponible).")
            ),
        e(ExceptionTimelinePanel, { evolution: data.evolution, clientId: database, exceptionCategories: data.exception_categories }),
        e(ExceptionRatePanel, { evolution: data.evolution, exceptionCategories: data.exception_categories, ruleLabels: data.rule_labels }),
        e("div", { className: "panel", style: { marginTop: 18 } },
          e("h2", null, "Oportunidades de mejora y logros"),
          e(Findings, { opportunities: data.opportunities })
        )
      )
    )
  );
}

// Entry point del Add-In: MyGeotab carga esta página en un iframe y llama a
// geotab.addin.<nombre>() una sola vez. El "api" que recibe initialize() ya
// está autenticado contra la base de datos actual (todo el proyecto corre
// 100% en el browser: no hay backend propio ni credenciales que guardar).
// Solo usamos api.getSession() una vez para saber qué base de datos es (se
// usa como key de la config guardada en localStorage y de los hitos). El
// <div id="root"> arranca con un mensaje estático (ver HTML) para cuando esta
// página se abre fuera de MyGeotab; React recién monta acá.
window.geotab = window.geotab || {};
window.geotab.addin = window.geotab.addin || {};
window.geotab.addin.cesettiInsightsV2 = function () {
  return {
    initialize: function (api, state, initializeCallback) {
      // Ojo: declarar el callback con 2 parámetros (credentials, server) a propósito.
      // El SDK de MyGeotab decide qué forma pasarle a este callback según cuántos
      // parámetros declara (function.length): con 1 solo parámetro, si todavía no hay
      // sesión cacheada en el browser, termina llamándolo con las credenciales "peladas"
      // en vez de envueltas en {credentials, path}, y result.credentials explota como
      // undefined. Con 2 parámetros siempre llega (credentials, server) por separado.
      api.getSession(function (credentials, server) {
        const database = credentials.database;
        ReactDOM.createRoot(document.getElementById("root")).render(e(App, { api, database }));
        initializeCallback();
      });
    },
    focus: function () {},
    blur: function () {},
  };
};
