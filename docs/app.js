const $ = id => document.getElementById(id);

const climateSelect = $("climateSelect");
const metricSearch = $("metricSearch");
const suggestions = $("suggestions");
const exploreStatus = $("exploreStatus");
const metricInfo = $("metricInfo");
const chartContainer = $("chartContainer");

const compareClimate = $("compareClimate");
const modelFile = $("modelFile");
const compareStatus = $("compareStatus");
const summary = $("summary");
const resultsWrap = $("resultsWrap");
const resultsTable = $("resultsTable");
const outlierChart = $("outlierChart");

let catalog = [];
let climateMetrics = [];
let reference = null;

function path(p) {
    return p.split("/").map(encodeURIComponent).join("/");
}

// Trim, lowercase, and collapse internal whitespace runs to a single
// space — used for climate-zone comparisons so labels from the
// dropdown ("Hot & Dry") reliably match whatever the parser wrote
// from folder names, even with minor spacing/casing differences.
function norm(x) {
    return String(x ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// Standard linear-interpolation quantile (matches numpy/Plotly's
// default "linear" method).
function quantile(sortedValues, q) {
    const pos = (sortedValues.length - 1) * q;
    const base = Math.floor(pos);
    const rest = pos - base;
    if (sortedValues[base + 1] !== undefined) {
        return sortedValues[base] +
            rest * (sortedValues[base + 1] - sortedValues[base]);
    }
    return sortedValues[base];
}

// Computes box-plot statistics ourselves (rather than letting Plotly
// derive its own from raw values), so the drawn whiskers and the
// outlier flags on the scatter points are guaranteed to agree.
// - fenceLow/fenceHigh: standard Tukey 1.5×IQR outlier cutoff.
// - whiskerLow/whiskerHigh: the most extreme *actual* data point
//   still within that fence — where the whisker is drawn to.
function computeBoxStats(numericValues) {
    const sorted = [...numericValues].sort((a, b) => a - b);
    const q1 = quantile(sorted, 0.25);
    const median = quantile(sorted, 0.5);
    const q3 = quantile(sorted, 0.75);
    const iqr = q3 - q1;
    const fenceLow = q1 - 1.5 * iqr;
    const fenceHigh = q3 + 1.5 * iqr;
    const inBounds = sorted.filter(v => v >= fenceLow && v <= fenceHigh);
    const whiskerLow = inBounds.length ? inBounds[0] : q1;
    const whiskerHigh = inBounds.length ? inBounds[inBounds.length - 1] : q3;
    return { q1, median, q3, fenceLow, fenceHigh, whiskerLow, whiskerHigh };
}

function status(el, msg, error=false) {
    el.textContent = msg;
    el.classList.toggle("error", error);
}

// The explorer (box plots of raw per-simulation values, parsed by
// parse_results.py and unit-normalized to kWh) and the comparison
// tool (aggregate population statistics from build_reference.py, in
// EnergyPlus's native, unconverted units — MJ, W, etc.) are two
// separate build outputs. They must be loaded and used separately:
// metric_catalog.json drives the Explore tab, reference_metrics.json
// drives the Compare tab.

async function loadCatalog() {
    try {
        const r = await fetch(path("data/metric_catalog.json"), {cache:"no-store"});
        if (!r.ok) throw new Error(`metric_catalog.json: HTTP ${r.status}`);
        const data = await r.json();
        catalog = data.metrics || [];
        status(exploreStatus, `${catalog.length.toLocaleString()} metrics loaded. Select a climate zone.`);
    } catch(e) {
        console.error(e);
        const isFileProtocol = window.location.protocol === "file:";
        status(
            exploreStatus,
            isFileProtocol
                ? "Could not load metric catalog. You're opening this file directly (file://) — " +
                  "browsers block fetch() for local files. Serve this folder with a local server " +
                  "instead, e.g. run 'python -m http.server' and open http://localhost:8000/."
                : `Could not load metric catalog: ${e.message}`,
            true
        );
    }
}
loadCatalog();

async function loadReferenceStats() {
    try {
        const r = await fetch(path("data/reference_metrics.json"), {cache:"no-store"});
        if (!r.ok) throw new Error(`reference_metrics.json: HTTP ${r.status}`);
        reference = await r.json();
    } catch(e) {
        console.error(e);
        // Only affects the Compare tab — don't overwrite exploreStatus.
        status(compareStatus, `Could not load reference data: ${e.message}`, true);
    }
}
loadReferenceStats();

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach(button => {
    button.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
        document.querySelectorAll(".panel").forEach(x => x.classList.remove("active"));
        button.classList.add("active");
        $(button.dataset.tab).classList.add("active");
    });
});

/* ---------- existing explorer ---------- */
climateSelect.addEventListener("change", () => {
    const climate = climateSelect.value;
    metricSearch.value = "";
    suggestions.hidden = true;
    chartContainer.hidden = true;
    metricInfo.hidden = true;

    if (!climate) {
        metricSearch.disabled = true;
        metricSearch.placeholder = "Select a climate zone first...";
        status(exploreStatus, "Select a climate zone.");
        return;
    }

    climateMetrics = catalog.filter(x => norm(x.climate_zone) === norm(climate));
    metricSearch.disabled = false;
    metricSearch.placeholder = "Search EnergyPlus variables...";

    if (!climateMetrics.length && catalog.length) {
        const available = [...new Set(catalog.map(m => m.climate_zone))].join(", ");
        status(
            exploreStatus,
            `No metrics found for "${climate}". Climate zones present in the catalog: ${available || "(none)"}.`,
            true
        );
    } else {
        status(exploreStatus, `${climateMetrics.length.toLocaleString()} metrics available.`);
    }
});

metricSearch.addEventListener("input", () => {
    const q = norm(metricSearch.value);
    suggestions.innerHTML = "";
    suggestions.hidden = true;

    if (!q) return;

    const matches = climateMetrics.filter(m =>
        [
            m.variable_name, m.display_name, m.key_value,
            m.unit, m.scope, m.aggregation
        ].map(norm).join(" ").includes(q)
    ).slice(0, 30);

    if (!matches.length) {
        status(exploreStatus, "No matching variables found.");
        return;
    }

    for (const metric of matches) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "suggestion";
        b.innerHTML = `<div class="suggestion-title"></div><div class="suggestion-details"></div>`;
        b.querySelector(".suggestion-title").textContent = metric.variable_name;

        // Same convention as the explorer-only version: key value and
        // unit always shown, aggregation shown unless it's "direct"
        // (which just means "not aggregated" and isn't informative).
        const parts = [];
        if (metric.key_value) parts.push(metric.key_value);
        if (metric.unit) parts.push(metric.unit);
        if (metric.aggregation && metric.aggregation !== "direct") {
            parts.push(metric.aggregation);
        }
        b.querySelector(".suggestion-details").textContent = parts.join(" • ");

        b.onclick = () => selectExploreMetric(metric);
        suggestions.appendChild(b);
    }
    suggestions.hidden = false;
    status(exploreStatus, `${matches.length} matching variable(s).`);
});

document.addEventListener("click", e => {
    if (!e.target.closest(".search-wrap")) suggestions.hidden = true;
});

async function selectExploreMetric(metric) {
    metricSearch.value = metric.variable_name;
    suggestions.hidden = true;

    if (!metric.file) {
        // Whole-model summary metrics (from EnergyPlus tabular reports,
        // e.g. "Site and Source Energy") are single values per
        // simulation, not a per-timestep series — the parser has
        // aggregate stats for these (used by the Compare tab) but
        // never records a distribution file, so there's nothing to
        // plot here.
        showSummaryMetricInfo(metric);
        chartContainer.hidden = true;
        status(
            exploreStatus,
            "This is a whole-model summary value, not a per-simulation distribution, " +
            "so there's no chart to plot. Reference median: " +
            `${fmt(metric.median)} ${metric.unit || ""}, typical range ` +
            `${fmt(metric.lower_fence)}–${fmt(metric.upper_fence)} ${metric.unit || ""}. ` +
            "It's still used for comparison in the \"Check Your Model\" tab."
        );
        return;
    }

    status(exploreStatus, "Loading metric...");
    try {
        /* Explorer metrics remain compatible with the V0 metric JSON files. */
        const r = await fetch(path(`data/${metric.file}`), {cache:"no-store"});
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        showMetricInfo(data);
        chartContainer.hidden = false;
        // drawExplore sets its own status message, including the
        // outlier count once it's finished computing the box stats.
        drawExplore(data);
    } catch(e) {
        status(exploreStatus, `Could not load metric: ${e.message}`, true);
    }
}

function showSummaryMetricInfo(metric) {
    metricInfo.innerHTML = "";
    const h = document.createElement("h2");
    h.textContent = metric.variable_name || metric.display_name;
    const p = document.createElement("p");
    p.textContent = [
        metric.key_value ? `Key: ${metric.key_value}` : "",
        metric.unit ? `Unit: ${metric.unit}` : "",
        metric.aggregation ? `Aggregation: ${metric.aggregation}` : "",
        "Whole-model summary value (no per-simulation distribution)"
    ].filter(Boolean).join("  |  ");
    metricInfo.append(h, p);
    metricInfo.hidden = false;
}

function showMetricInfo(data) {
    metricInfo.innerHTML = "";
    const h = document.createElement("h2");
    h.textContent = data.variable_name || data.display_name;
    const p = document.createElement("p");
    p.textContent = [
        data.key_value ? `Key: ${data.key_value}` : "",
        data.unit ? `Unit: ${data.unit}` : "",
        data.aggregation ? `Aggregation: ${data.aggregation}` : "",
        `Simulations: ${data.simulation_count ?? data.values.length}`
    ].filter(Boolean).join("  |  ");
    metricInfo.append(h,p);
    metricInfo.hidden = false;
}

function drawExplore(data) {
    const values = (data.values || []).map(x => ({
        location: x.location, value: Number(x.value)
    })).filter(x => Number.isFinite(x.value));

    if (!values.length) {
        status(exploreStatus, "This metric contains no numeric values.", true);
        return;
    }

    const numericValues = values.map(x => x.value);
    const stats = computeBoxStats(numericValues);
    const isOutlier = v => v < stats.fenceLow || v > stats.fenceHigh;

    const normalValues = values.filter(x => !isOutlier(x.value));
    const outlierValues = values.filter(x => isOutlier(x.value));

    // Precomputed statistics, not raw y-values — forces Plotly to
    // draw exactly the box/whiskers we calculated above, so they
    // match the outlier flags on the points below.
    const boxTrace = {
        type: "box",
        q1: [stats.q1],
        median: [stats.median],
        q3: [stats.q3],
        lowerfence: [stats.whiskerLow],
        upperfence: [stats.whiskerHigh],
        name: "Distribution",
        boxpoints: false,
        showlegend: false
    };

    function toPointTrace(valueSet, name, color, symbol, size) {
        return {
            type: "scatter",
            mode: "markers",
            x: valueSet.map(() => "All simulations"),
            y: valueSet.map(x => x.value),
            customdata: valueSet.map(x => [x.location]),
            marker: { size, opacity: 0.75, color, symbol },
            hovertemplate:
                "<b>%{customdata[0]}</b><br>Value: %{y:,.2f}" +
                ` ${data.unit || ""}` +
                `${name === "Outliers" ? " (outlier)" : ""}` +
                "<extra></extra>",
            name
        };
    }

    const pointTrace = toPointTrace(normalValues, "Locations", "#3b7dd8", "circle", 7);

    // Points beyond 1.5×IQR — same rule the whiskers use, drawn
    // separately so they're visually flagged instead of blending in.
    const outlierTrace = toPointTrace(outlierValues, "Outliers", "#d43d3d", "diamond", 9);

    Plotly.react("chart", [boxTrace, pointTrace, outlierTrace], {
        margin: { l: 80, r: 30, t: outlierValues.length ? 50 : 20, b: 60 },
        showlegend: outlierValues.length > 0,
        legend: { orientation: "h", y: 1.08 },
        xaxis: { showticklabels: false },
        yaxis: { title: data.unit || "Value" }
    }, { responsive: true, displaylogo: false });

    const count = data.simulation_count ?? values.length;
    const fenceText =
        `(outside ${stats.fenceLow.toLocaleString(undefined, {maximumFractionDigits: 2})}` +
        `–${stats.fenceHigh.toLocaleString(undefined, {maximumFractionDigits: 2})} ${data.unit || ""})`;

    status(
        exploreStatus,
        outlierValues.length
            ? `${count.toLocaleString()} simulations plotted — ${outlierValues.length} flagged as outliers ${fenceText}.`
            : `${count.toLocaleString()} simulations plotted — no statistical outliers detected ${fenceText}.`
    );

    document.getElementById("chart").on("plotly_click", event => {
        const point = event.points && event.points[0];
        if (!point || !point.customdata) return;
        const location = point.customdata[0];
        const value = Number(point.y);
        status(
            exploreStatus,
            `${location}: ${value.toLocaleString(undefined, {maximumFractionDigits: 2})} ${data.unit || ""}`
        );
    });
}

/* ---------- upload comparison ---------- */
modelFile.addEventListener("change", runComparison);

async function runComparison() {
    const file = modelFile.files[0];
    const climate = compareClimate.value;

    summary.hidden = true;
    resultsWrap.hidden = true;
    outlierChart.hidden = true;

    if (!climate || !file) {
        status(compareStatus, "Select a climate zone and upload a result file.");
        return;
    }

    if (!reference) {
        status(compareStatus, "Reference data is still loading.", true);
        return;
    }

    status(compareStatus, `Reading ${file.name}...`);

    try {
        let records;

        if (file.name.toLowerCase().endsWith(".sql")) {
            records = await parseSQL(file);
        } else if (/\.(htm|html)$/i.test(file.name)) {
            records = await parseHTML(file);
        } else {
            throw new Error("Please upload an .sql, .htm, or .html file.");
        }

        const results = compareRecords(records, climate);
        renderComparison(results, file.name);
    } catch(e) {
        console.error(e);
        status(compareStatus, `Could not compare file: ${e.message}`, true);
    }
}

/* ---------- SQL parser: sql.js / SQLite ---------- */
let SQLPromise = null;

function getSQL() {
    if (!SQLPromise) {
        SQLPromise = initSqlJs({
            locateFile: file =>
                `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/${file}`
        });
    }
    return SQLPromise;
}

function tableExists(db, name) {
    const r = db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
        [name]
    );
    return r.length > 0;
}

function columnNames(db, table) {
    return new Set(
        db.exec(`PRAGMA table_info("${table}")`)[0]?.values.map(x=>x[1]) || []
    );
}

function environmentIds(db) {
    if (!tableExists(db,"EnvironmentPeriods")) return [];
    try {
        const rows = db.exec(
            "SELECT EnvironmentPeriodIndex, EnvironmentName FROM EnvironmentPeriods"
        )[0]?.values || [];
        return rows
            .filter(r => !/(design day|sizing)/i.test(String(r[1]||"")))
            .filter(r => /(weather|run period|annual)/i.test(String(r[1]||"")))
            .map(r => r[0]);
    } catch(e) { return []; }
}

function scopeFor(key,name) {
    const text = `${key||""} ${name||""}`;
    if (/\b(zone|space|surface|window|wall|roof|floor|door|people|lights|electric equipment|gas equipment|hot water|water use|infiltration|daylighting|thermal zone)\b/i.test(text))
        return null;
    if (/\b(airloop|air loop|air system|plant|chiller|boiler|cooling tower|pump|fan|coil|heat exchanger|system|condenser|humidifier|dehumidifier)\b/i.test(text))
        return "system";
    return "building";
}

// Must match build_reference.py's aggregation_for() EXACTLY, including
// its substring (not word-boundary) matching and the "w/" exclusion —
// this value becomes part of the key used to match an uploaded model's
// metrics against the reference population (see metricKey below), so
// any drift here silently breaks matching for affected metrics.
function aggregationFor(name, unit) {
    const text = `${name || ""} ${unit || ""}`.toLowerCase();
    const energyUnits = ["j", "kj", "mj", "gj", "wh", "kwh", "mwh"];
    if (energyUnits.some(x => text.includes(x)) && !text.includes("w/")) {
        return "sum";
    }
    if (["power", "load", "capacity", "rate"].some(x => text.includes(x))) {
        return "max";
    }
    return "mean";
}

// Must match build_reference.py's BUILDING_KEYS filter EXACTLY: when
// building reference_metrics.json, per-end-use meters (e.g. lighting,
// cooling, individual equipment meters) are dropped for building
// scope — only whole-facility meters are kept. Skipping this filter
// here means the uploaded model would carry many building-scope meter
// records that have NO counterpart in the reference set at all, so
// they'd just be silently skipped in compareRecords — not wrong, but
// wasted parsing, and worth staying consistent with the server side.
const BUILDING_METER_KEYS = new Set([
    "", "whole building", "facility", "whole building:facility",
    "electricity:facility", "gas:facility", "naturalgas:facility"
]);

async function parseSQL(file) {
    const SQL = await getSQL();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const db = new SQL.Database(bytes);

    if (!tableExists(db,"ReportDataDictionary") || !tableExists(db,"ReportData"))
        throw new Error("This SQL file does not contain the expected EnergyPlus ReportData tables.");

    const env = environmentIds(db);
    const timeCols = columnNames(db,"Time");

    const dict = db.exec(`
        SELECT ReportDataDictionaryIndex, KeyValue, Name,
               ReportingFrequency, Units, IsMeter
        FROM ReportDataDictionary
        WHERE Name IS NOT NULL
    `)[0]?.values || [];

    const records = [];

    for (const [id,key,name,freq,unit,isMeter] of dict) {
        const scope = scopeFor(key,name);
        if (!scope) continue;
        if (isMeter && scope === "building" && !BUILDING_METER_KEYS.has(norm(key))) continue;

        let query, params;
        if (env.length && timeCols.has("EnvironmentPeriodIndex")) {
            const marks = env.map(()=>"?").join(",");
            query = `
                SELECT r.Value
                FROM ReportData r
                JOIN Time t ON t.TimeIndex=r.TimeIndex
                WHERE r.ReportDataDictionaryIndex=?
                AND t.EnvironmentPeriodIndex IN (${marks})
            `;
            params = [id,...env];
        } else {
            query = `
                SELECT Value FROM ReportData
                WHERE ReportDataDictionaryIndex=?
            `;
            params = [id];
        }

        const values = db.exec(query, params)[0]?.values.map(x=>Number(x[0]))
            .filter(Number.isFinite) || [];

        if (!values.length) continue;

        const agg = aggregationFor(name,unit);
        let value;
        if (agg==="sum") value=values.reduce((a,b)=>a+b,0);
        else if (agg==="max") value=Math.max(...values);
        else value=values.reduce((a,b)=>a+b,0)/values.length;

        records.push({
            scope, variable_name:name, key_value:key||"",
            unit:unit||"", aggregation:agg, value
        });
    }

    if (tableExists(db,"TabularDataWithStrings")) {
        try {
            const rows = db.exec(`
                SELECT ReportName, ReportForString, TableName,
                       RowName, ColumnName, Units, Value
                FROM TabularDataWithStrings
                WHERE Value IS NOT NULL
            `)[0]?.values || [];

            for (const [report,reportFor,table,row,column,unit,value] of rows) {
                const name=`${table} — ${row} — ${column}`;
                const scope=scopeFor(reportFor,name);
                if (!scope) continue;
                const n=Number(String(value).replace(/,/g,""));
                if (!Number.isFinite(n)) continue;
                records.push({
                    scope, variable_name:name, key_value:reportFor||"",
                    unit:unit||"", aggregation:"direct", value:n
                });
            }
        } catch(e) {}
    }

    db.close();
    return records;
}

/* ---------- HTML parser ---------- */
async function parseHTML(file) {
    const html = await file.text();
    const doc = new DOMParser().parseFromString(html,"text/html");
    const records=[];

    for (const table of doc.querySelectorAll("table")) {
        const rows=[...table.querySelectorAll("tr")];
        if (!rows.length) continue;

        const headers=[...rows[0].querySelectorAll("th,td")]
            .map(x=>x.textContent.trim().replace(/\s+/g," "));

        for (const row of rows.slice(1)) {
            const cells=[...row.querySelectorAll("th,td")]
                .map(x=>x.textContent.trim().replace(/\s+/g," "));
            if (!cells.length) continue;

            const rowName=cells[0];

            for (let i=1;i<cells.length;i++) {
                const raw=cells[i].replace(/,/g,"");
                const match=raw.match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][-+]?\d+)?/);
                if (!match) continue;

                const column=headers[i] || `Column ${i}`;
                const name=`${rowName} — ${column}`;
                const scope=scopeFor("",name);
                if (!scope) continue;

                records.push({
                    scope, variable_name:name, key_value:"",
                    unit:"", aggregation:"direct", value:Number(match[0])
                });
            }
        }
    }
    return records;
}

/* ---------- matching/outliers ---------- */
function metricKey(m,climate) {
    return [
        climate,m.scope,m.variable_name,m.key_value||"",
        m.unit||"",m.aggregation||""
    ].join("||");
}

function compareRecords(records, climate) {
    const ref = reference.metrics.filter(x => norm(x.climate_zone) === norm(climate));
    const index = new Map(ref.map(x=>[
        metricKey(x,climate),x
    ]));

    const matched = new Map();

    for (const record of records) {
        if (!["building","system"].includes(record.scope)) continue;

        const r=index.get(metricKey(record,climate));
        if (!r) continue;

        // Avoid duplicate report entries for the same metric.
        if (!matched.has(r.metric_id)) {
            const value=Number(record.value);
            const low=value<r.lower_fence;
            const high=value>r.upper_fence;
            const robustZ=r.iqr===0 ? 0 :
                (value-r.median)/(r.iqr/1.349);

            matched.set(r.metric_id,{
                ...record,
                reference:r,
                isOutlier:low||high,
                direction:high?"high":low?"low":"within",
                robustZ
            });
        }
    }

    return [...matched.values()].sort((a,b)=>
        Math.abs(b.robustZ)-Math.abs(a.robustZ)
    );
}

function fmt(x) {
    return Number(x).toLocaleString(undefined,{
        maximumFractionDigits:2
    });
}

function renderComparison(results,fileName) {
    const outliers=results.filter(x=>x.isOutlier);

    summary.innerHTML=`
        <div class="summary-item"><strong>${results.length}</strong><span>matched metrics</span></div>
        <div class="summary-item"><strong>${outliers.length}</strong><span>outliers</span></div>
        <div class="summary-item"><strong>${results.filter(x=>x.scope==="building").length}</strong><span>building metrics</span></div>
        <div class="summary-item"><strong>${results.filter(x=>x.scope==="system").length}</strong><span>system metrics</span></div>
    `;
    summary.hidden=false;

    resultsTable.querySelector("tbody").innerHTML="";

    for (const x of outliers) {
        const r=x.reference;
        const tr=document.createElement("tr");
        const diff=((x.value-r.median)/Math.abs(r.median))*100;

        tr.innerHTML=`
            <td>${x.scope}</td>
            <td>${escapeHTML(x.variable_name)}</td>
            <td>${fmt(x.value)} ${escapeHTML(x.unit)}</td>
            <td>${fmt(r.median)} ${escapeHTML(r.unit)}</td>
            <td>${fmt(r.lower_fence)} – ${fmt(r.upper_fence)} ${escapeHTML(r.unit)}</td>
            <td>${diff>=0?"+":""}${fmt(diff)}%</td>
        `;
        resultsTable.querySelector("tbody").appendChild(tr);
    }

    resultsWrap.hidden=false;

    if (outliers.length) {
        const top=outliers.slice(0,25).reverse();

        Plotly.react("outlierPlot",[{
            type:"bar",
            orientation:"h",
            x:top.map(x=>x.robustZ),
            y:top.map(x=>x.variable_name),
            customdata:top.map(x=>[x.value,x.unit,x.direction]),
            hovertemplate:
                "<b>%{y}</b><br>" +
                "Model: %{customdata[0]:,.2f} %{customdata[1]}<br>" +
                "Direction: %{customdata[2]}<br>" +
                "Robust z: %{x:.2f}<extra></extra>"
        }],{
            margin:{l:280,r:30,t:20,b:50},
            xaxis:{title:"Robust z-score"},
            yaxis:{automargin:true},
            shapes:[{type:"line",x0:0,x1:0,y0:-.5,y1:top.length-.5}],
        },{responsive:true,displaylogo:false});
        outlierChart.hidden=false;
    }

    status(
        compareStatus,
        `${fileName}: ${results.length} comparable building/system metrics found; ${outliers.length} flagged as outliers.`
    );
}

function escapeHTML(value) {
    return String(value??"")
        .replaceAll("&","&amp;")
        .replaceAll("<","&lt;")
        .replaceAll(">","&gt;")
        .replaceAll('"',"&quot;")
        .replaceAll("'","&#039;");
}