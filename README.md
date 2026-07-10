# Geotab Insights - Cesetti (Add-In v2)

Versión Add-In de `geotab_insights_standalone`: mismo dashboard y la misma
interfaz mejorada, pero empaquetado para correr **dentro de MyGeotab** como
Add-In (igual que `geotab_insights_ADDIN`, la versión anterior) en vez de
autenticarse con credenciales hardcodeadas.

100% estático: sin backend propio. Corre entero en el browser dentro del
iframe que MyGeotab le da al Add-In, usando la sesión ya autenticada del
usuario (`api.call`/`api.multiCall` del SDK de Add-Ins). No hay credenciales
que guardar, ni server que mantener, ni CORS que configurar.

## Diferencias con `geotab_insights_ADDIN` (la v1)

- **Interfaz rediseñada**: la misma que `geotab_insights_standalone` —
  paleta de colores revisada, cards con hover, tablas más prolijas,
  responsive.
- **Sin `AddInData`.** La v1 guardaba el mapeo de reglas/grupo/combustible en
  la Storage API de MyGeotab (`AddInData`), compartido entre cualquiera que
  abriera el Add-In en esa base de datos. Esta versión lo guarda en el
  `localStorage` del navegador (igual que la standalone) — más simple, pero
  cada persona que abra el Add-In configura la suya; no se comparte entre
  compañeros. Si en algún momento se necesita que sea compartido, hay que
  volver a `AddInData` (`storage.js` de la v1 sirve de referencia).
- **`id` distinto en `addin-config.json`** (`aCesettiGeotabInsightsAddInV201`)
  para poder instalar esta versión al lado de la v1 sin pisarla mientras se
  prueba.

Todo lo demás (cómo se calcula el score, cómo se detectan oportunidades,
`dashboard.js`/`metrics.js`/`fuel.js`/`analyzer.js`/`groups.js`) es idéntico
a la v1 — ver `geotab_insights_ADDIN/README.md`.

## Arquitectura

- `static/index.html`: define `geotab.addin.cesettiInsightsV2`, el entry
  point que MyGeotab invoca al cargar la página en el iframe del Add-In.
- `static/js/`: mismos módulos de cálculo que las otras dos versiones
  (`utils.js`, `metrics.js`, `fuel.js`, `analyzer.js`, `groups.js`,
  `dashboard.js`), más:
  - `settings.js`: persiste la config editable de cada base en
    `localStorage` (mismo archivo que `geotab_insights_standalone`).
  - `app.js`: la UI en React. El entry point del Add-In (al final del
    archivo) recibe el `api` ya autenticado por el SDK y renderiza `App`
    directo — no hay selector de cliente ni login, eso es exclusivo de la
    versión standalone.

## Desplegar

1. Subí este repo (o esta carpeta) a GitHub y activá **GitHub Pages**
   apuntando a `static/`. No requiere build.
2. Completá `addin-config.json` con la URL real donde quedó publicado
   (reemplazá el placeholder `geotab_insights_v2` del campo `url`).
3. En cada base de datos de cliente donde quieras que aparezca:
   *Administration → System Settings → Add-Ins → New Add-In* → pegar ese
   JSON.
4. Repetir el paso 3 en cada base de datos — la primera vez que alguien lo
   abre en una base nueva, el Add-In arranca vacío (sin reglas mapeadas) y
   se configura desde "Configurar" en la página. Esa config queda en el
   navegador de quien la configuró (ver nota sobre `localStorage` arriba).

## Uso local / de prueba

Al no haber backend, alcanza con servir `static/` con cualquier file server
estático para editar y ver cambios de CSS. Pero `geotab.addin.cesettiInsightsV2`
solo lo invoca MyGeotab, así que para probar el flujo real (login, datos de
una flota) hace falta tenerlo instalado como Add-In (paso 3 de arriba) contra
una base de prueba.
