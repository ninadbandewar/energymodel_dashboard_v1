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

function norm(x) {
    return String(x ?? "").trim().toLowerCase();
}

function status(el, msg, error=false) {
    el.textContent = msg;
    el.classList.toggle("error", error);
}

async function loadReference() {
    try {
        const r = await fetch(path("data/reference_metrics.json"), {cache:"no-store"});
        if (!r.ok) throw new Error(`reference_metrics.json: HTTP ${r.status}`);
        reference = await r.json();
        catalog = reference.metrics || [];
        status(exploreStatus, `${catalog.length.toLocaleString()} metrics loaded. Select a climate zone.`);
    } catch(e) {
        console.error(e);
        status(exploreStatus, `Could not load reference data: ${e.message}`, true);
    }
}
loadReference();

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

    climateMetrics = catalog.filter(x => x.climate_zone === climate);
    metricSearch.disabled = !climate;

    if (!climate) {
        metricSearch.placeholder = "Select a climate zone first...";
        status(exploreStatus, "Select a climate zone.");
        return;
    }

    metricSearch.placeholder = "Search EnergyPlus variables...";
    status(exploreStatus, `${climateMetrics.length.toLocaleString()} metrics available.`);
});

metricSearch.addEventListener("input", () => {
    const q = norm(metricSearch.value);
    suggestions.innerHTML = "";
    suggestions.hidden = true;

    if (!q) return;

    const matches = climateMetrics.filter(m =>
        [
            m.variable_name, m.key_value, m.unit,
            m.scope, m.aggregation
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
        b.querySelector(".suggestion-details").textContent =
            [metric.scope, metric.key_value, metric.unit, metric.aggregation]
            .filter(Boolean).join(" • ");
        b.onclick = () => selectExploreMetric(metric);
        suggestions.appendChild(b);
    }
    suggestions.hidden = false;
});

document.addEventListener("click", e => {
    if (!e.target.closest(".search-wrap")) suggestions.hidden = true;
});

async function selectExploreMetric(metric) {
    metricSearch.value = metric.variable_name;
    suggestions.hidden = true;
    status(exploreStatus, "Loading metric...");
    try {
        /* Explorer metrics remain compatible with the V0 metric JSON files. */
        const climate = metric.climate_zone;
        const file = metric.file;
        if (!file) throw new Error("This catalog entry has no metric file.");
        const r = await fetch(path(`data/${file}`), {cache:"no-store"});
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        showMetricInfo(data);
        drawExplore(data);
        chartContainer.hidden = false;
        status(exploreStatus, `${data.simulation_count ?? data.values.length} simulations plotted.`);
    } catch(e) {
        status(exploreStatus, `Could not load metric: ${e.message}`, true);
    }
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
        location:x.location, value:Number(x.value)
    })).filter(x => Number.isFinite(x.value));

    Plotly.react("chart", [
        {type:"box", y:values.map(x=>x.value), name:"Distribution", boxpoints:false},
        {
            type:"scatter", mode:"markers",
            x:values.map(()=>"All simulations"),
            y:values.map(x=>x.value),
            customdata:values.map(x=>[x.location]),
            marker:{size:8,opacity:.7},
            hovertemplate:"<b>%{customdata[0]}</b><br>Value: %{y:,.2f}<extra></extra>"
        }
    ], {
        margin:{l:80,r:30,t:20,b:60},
        showlegend:false,
        xaxis:{showticklabels:false},
        yaxis:{title:data.unit || "Value"}
    }, {responsive:true,displaylogo:false});
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

function aggregationFor(name,unit) {
    const text = `${name||""} ${unit||""}`.toLowerCase();
    if (/\b(j|kj|mj|gj|wh|kwh|mwh)\b/.test(text)) return "sum";
    if (/(power|load|capacity|rate)/.test(text)) return "max";
    return "mean";
}

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
    const ref = reference.metrics.filter(x=>x.climate_zone===climate);
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
