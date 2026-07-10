// Reemplaza storage.js (que guardaba la config de cada cliente en AddInData,
// la Storage API de MyGeotab, solo disponible corriendo como Add-In). Acá no
// hay Add-In ni backend propio: la config editable desde el panel de
// "Configuración" (mapeo de reglas, grupo analizado, precio de combustible)
// se guarda en el localStorage del navegador, separada por base de datos.
//
// La primera vez que se abre un cliente (nada guardado todavía en este
// navegador) se arranca desde los valores hardcodeados en config.js para ese
// cliente, igual que antes arrancaba vacío y había que cargarlo a mano.

function settingsStorageKey(database) {
  return "geotab_insights_settings_" + database;
}

function defaultDbSettings(clientDefaults) {
  clientDefaults = clientDefaults || {};
  return {
    rule_mapping: clientDefaults.rule_mapping || {},
    group_filter_id: clientDefaults.group_filter_id != null ? clientDefaults.group_filter_id : null,
    fuel: clientDefaults.fuel || {},
  };
}

function loadDbSettings(database, clientDefaults) {
  try {
    const raw = JSON.parse(localStorage.getItem(settingsStorageKey(database)) || "null");
    if (raw && typeof raw.rule_mapping === "object") {
      return Promise.resolve({
        rule_mapping: raw.rule_mapping || {},
        group_filter_id: raw.group_filter_id !== undefined ? raw.group_filter_id : null,
        fuel: raw.fuel || {},
      });
    }
  } catch (err) {
    // localStorage corrupto o inaccesible: seguimos con los defaults del cliente.
  }
  return Promise.resolve(defaultDbSettings(clientDefaults));
}

function saveDbSettings(database, settings) {
  const details = {
    rule_mapping: settings.rule_mapping || {},
    group_filter_id: settings.group_filter_id != null ? settings.group_filter_id : null,
    fuel: settings.fuel || {},
  };
  localStorage.setItem(settingsStorageKey(database), JSON.stringify(details));
  return Promise.resolve(details);
}

// Mergea patch sobre el settings actual (con merge dedicado para "fuel", que
// se edita de a un campo por vez desde distintos formularios) y lo guarda.
// "current" lo pasa el caller (el estado de React ya en memoria) en vez de
// releerlo de localStorage acá: evita una carrera si se editan dos campos
// rápido, uno atrás del otro, antes de que el primer guardado actualice el
// estado (ej. tildar varias reglas seguidas en el panel de configuración).
function updateDbSettings(database, current, patch) {
  const merged = {
    ...current,
    ...patch,
    fuel: { ...current.fuel, ...(patch.fuel || {}) },
  };
  return saveDbSettings(database, merged);
}
