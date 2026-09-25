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
const compareProgress = $("compareProgress");

let catalog = [];
let climateMetrics = [];
let catalogReady = false;
const metricDataCache = new Map();

function path(p){return p.split("/").map(encodeURIComponent).join("/");}
function norm(x){return String(x ?? "").trim().toLowerCase().replace(/\s+/g," ");}
function climateNorm(x){return norm(x).replace(/and/g,"&");}
function status(el,msg,error=false){el.textContent=msg;el.classList.toggle("error",error);}

/* ---------- catalog: this is the old parser's metric_catalog ---------- */
async function loadCatalog(){
    try{
        const r=await fetch("data/metric_catalog.json",{cache:"no-store"});
        if(!r.ok) throw new Error(`metric_catalog.json: HTTP ${r.status}`);
        const data=await r.json();
        catalog=Array.isArray(data.metrics)?data.metrics:[];
        catalogReady=true;
        status(exploreStatus,`${catalog.length.toLocaleString()} metrics loaded. Select a climate zone.`);
    }catch(e){
        console.error(e);
        status(exploreStatus,`Could not load metric catalog: ${e.message}`,true);
    }
}
loadCatalog();

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach(button=>button.addEventListener("click",()=>{
    document.querySelectorAll(".tab").forEach(x=>x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(x=>x.classList.remove("active"));
    button.classList.add("active");
    $(button.dataset.tab).classList.add("active");
}));

/* ---------- explorer ---------- */
climateSelect.addEventListener("change",()=>{
    const climate=climateSelect.value;
    metricSearch.value=""; suggestions.hidden=true; chartContainer.hidden=true; metricInfo.hidden=true;
    climateMetrics=catalog.filter(x=>climateNorm(x.climate_zone)===climateNorm(climate));
    metricSearch.disabled=!climate;
    if(!climate){metricSearch.placeholder="Select a climate zone first...";status(exploreStatus,"Select a climate zone.");return;}
    metricSearch.placeholder="Search EnergyPlus variables...";
    status(exploreStatus,`${climateMetrics.length.toLocaleString()} metrics available.`);
});

metricSearch.addEventListener("input",()=>{
    const q=norm(metricSearch.value); suggestions.innerHTML=""; suggestions.hidden=true;
    if(!q)return;
    const matches=climateMetrics.filter(m=>[
        m.variable_name,m.display_name,m.key_value,m.unit,m.original_unit,m.aggregation,m.reporting_frequency
    ].map(norm).join(" ").includes(q)).slice(0,50);
    if(!matches.length){status(exploreStatus,"No matching variables found.");return;}
    for(const metric of matches){
        const b=document.createElement("button");b.type="button";b.className="suggestion";
        const title=document.createElement("div");title.className="suggestion-title";title.textContent=metric.variable_name||metric.display_name||metric.metric_id;
        const details=document.createElement("div");details.className="suggestion-details";
        details.textContent=[metric.key_value,metric.unit,metric.aggregation].filter(Boolean).join(" • ");
        b.append(title,details);b.onclick=()=>selectExploreMetric(metric);suggestions.appendChild(b);
    }
    suggestions.hidden=false;status(exploreStatus,`${matches.length} matching variable(s).`);
});

document.addEventListener("click",e=>{if(!e.target.closest(".search-wrap"))suggestions.hidden=true;});

async function loadMetric(metric){
    if(metricDataCache.has(metric.file))return metricDataCache.get(metric.file);
    const r=await fetch(path(`data/${metric.file}`),{cache:"no-store"});
    if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const data=await r.json();metricDataCache.set(metric.file,data);return data;
}

async function selectExploreMetric(metric){
    metricSearch.value=metric.variable_name||metric.display_name; suggestions.hidden=true; chartContainer.hidden=true; metricInfo.hidden=true;
    status(exploreStatus,"Loading metric...");
    try{const data=await loadMetric(metric);showMetricInfo(data);drawExplore(data);chartContainer.hidden=false;}
    catch(e){console.error(e);status(exploreStatus,`Could not load metric: ${e.message}`,true);}
}

function showMetricInfo(data){
    metricInfo.innerHTML="";
    const h=document.createElement("h2");h.textContent=data.variable_name||data.display_name;
    const p=document.createElement("p");
    p.textContent=[data.key_value?`Key: ${data.key_value}`:"",data.unit?`Unit: ${data.unit}`:"",data.aggregation?`Aggregation: ${data.aggregation}`:"",`Simulations: ${data.simulation_count??(data.values||[]).length}`].filter(Boolean).join("  |  ");
    metricInfo.append(h,p);metricInfo.hidden=false;
}

function quantile(sorted,q){
    if(!sorted.length)return NaN;
    const pos=(sorted.length-1)*q,base=Math.floor(pos),rest=pos-base;
    return sorted[base+1]!==undefined?sorted[base]+rest*(sorted[base+1]-sorted[base]):sorted[base];
}
function boxStats(values){
    const sorted=[...values].sort((a,b)=>a-b);
    const q1=quantile(sorted,.25),median=quantile(sorted,.5),q3=quantile(sorted,.75),iqr=q3-q1;
    const lowerFence=q1-1.5*iqr,upperFence=q3+1.5*iqr;
    const inside=sorted.filter(v=>v>=lowerFence&&v<=upperFence);
    return {q1,median,q3,iqr,lowerFence,upperFence,whiskerLow:inside[0]??q1,whiskerHigh:inside.at(-1)??q3};
}

function drawExplore(data){
    const values=(data.values||[]).map(x=>({location:x.location,state:x.state||"",value:Number(x.value)})).filter(x=>Number.isFinite(x.value));
    if(!values.length){status(exploreStatus,"This metric contains no numeric values.",true);return;}
    const stats=boxStats(values.map(x=>x.value));
    const normal=values.filter(x=>x.value>=stats.lowerFence&&x.value<=stats.upperFence);
    const outliers=values.filter(x=>x.value<stats.lowerFence||x.value>stats.upperFence);
    const unit=data.unit||"";

    const traces=[{
        type:"box",q1:[stats.q1],median:[stats.median],q3:[stats.q3],lowerfence:[stats.whiskerLow],upperfence:[stats.whiskerHigh],
        name:"Distribution",boxpoints:false,showlegend:false,hovertemplate:`Q1: %{q1:.2f}<br>Median: %{median:.2f}<br>Q3: %{q3:.2f}<extra></extra>`
    },{
        type:"scatter",mode:"markers",x:normal.map(()=>"All simulations"),y:normal.map(x=>x.value),customdata:normal.map(x=>[x.location,x.state]),
        marker:{size:7,opacity:.72,symbol:"circle"},name:"Locations",
        hovertemplate:`<b>%{customdata[0]}</b><br>Value: %{y:,.2f} ${unit}<extra></extra>`
    }];
    if(outliers.length)traces.push({
        type:"scatter",mode:"markers",x:outliers.map(()=>"All simulations"),y:outliers.map(x=>x.value),customdata:outliers.map(x=>[x.location,x.state]),
        marker:{size:10,opacity:.9,symbol:"diamond",color:"#c43b3b"},name:"Outliers",
        hovertemplate:`<b>%{customdata[0]}</b><br>Value: %{y:,.2f} ${unit}<br>Outlier<extra></extra>`
    });
    Plotly.react("chart",traces,{margin:{l:85,r:30,t:30,b:60},showlegend:outliers.length>0,xaxis:{showticklabels:false},yaxis:{title:unit||"Value",zeroline:false},paper_bgcolor:"white",plot_bgcolor:"white"},{responsive:true,displaylogo:false});
    $("chart").on("plotly_click",ev=>{const p=ev.points?.[0];if(!p?.customdata)return;status(exploreStatus,`${p.customdata[0]}: ${Number(p.y).toLocaleString(undefined,{maximumFractionDigits:2})} ${unit}`);});
    status(exploreStatus,`${values.length.toLocaleString()} simulations plotted — ${outliers.length} statistical outlier(s). Tukey fences: ${stats.lowerFence.toLocaleString(undefined,{maximumFractionDigits:2})} to ${stats.upperFence.toLocaleString(undefined,{maximumFractionDigits:2})} ${unit}`);
}

/* ---------- comparison ---------- */
modelFile.addEventListener("change",runComparison);

const ZONE_RE=/\b(zone|space|surface|window|wall|roof|floor|door|people|lights|electric equipment|gas equipment|hot water|water use|infiltration|daylighting|thermal zone)\b/i;
const SYSTEM_RE=/\b(airloop|air loop|air system|plant|chiller|boiler|cooling tower|pump|fan|coil|heat exchanger|system|condenser|humidifier|dehumidifier)\b/i;
function scopeFor(key,name){const text=`${key||""} ${name||""}`;if(ZONE_RE.test(text))return null;if(SYSTEM_RE.test(text))return "system";return "building";}
function aggregationFor(name,unit){const s=`${name||""} ${unit||""}`.toLowerCase().replace(/\s/g,"");if(/(j|wh|kwh|mwh|mj|gj)/.test(unit||"")&&!/(w\/m2|w\/m\^2)/.test(unit||""))return "sum";if(/(energy|electricity|gas|fuel|steam|districtcooling|districtheating|water)/.test(s))return "sum";if(/(power|rate|load|capacity|flow|demand)/.test(s))return "max";return "mean";}

function normalizeUnit(u){
    const x=String(u||"").toLowerCase().replace(/\s/g,"").replace("²","2");
    if(["j","kj","mj","gj","wh","kwh","mwh"].includes(x))return "kWh";
    if(["j/m2","j/m^2","kj/m2","kj/m^2","mj/m2","mj/m^2","wh/m2","wh/m^2","kwh/m2","kwh/m^2","mwh/m2","mwh/m^2"].includes(x))return "kWh/m²";
    if(["w","kw","mw"].includes(x))return "kW";
    if(["w/m2","w/m^2","kw/m2","kw/m^2","mw/m2","mw/m^2"].includes(x))return "kW/m²";
    if(["c","degc","°c"].includes(x))return "°C";
    return String(u||"");
}
function convertUnitValue(value,from,to){
    const f=String(from||"").toLowerCase().replace(/\s/g,"").replace("²","2"), t=normalizeUnit(to);
    let v=Number(value);if(!Number.isFinite(v))return NaN;
    if(t==="kWh"){
        if(f==="j")return v/3600000;if(f==="kj")return v/3600;if(f==="mj")return v/3600;if(f==="gj")return v/3.6;if(f==="wh")return v/1000;if(f==="kwh")return v;if(f==="mwh")return v*1000;
    }
    if(t==="kWh/m²"){
        if(f==="j/m2")return v/3600000;if(f==="kj/m2")return v/3600;if(f==="mj/m2")return v/3600;if(f==="gj/m2")return v/3.6;if(f==="wh/m2")return v/1000;if(f==="kwh/m2")return v;if(f==="mwh/m2")return v*1000;
    }
    if(t==="kW"){
        if(f==="w")return v/1000;if(f==="kw")return v;if(f==="mw")return v*1000;
    }
    if(t==="kW/m²"){
        if(f==="w/m2")return v/1000;if(f==="kw/m2")return v;if(f==="mw/m2")return v*1000;
    }
    return v;
}

async function runComparison(){
    const file=modelFile.files[0],climate=compareClimate.value;
    summary.hidden=true;resultsWrap.hidden=true;outlierChart.hidden=true;compareProgress.hidden=true;
    if(!climate||!file){status(compareStatus,"Select a climate zone and upload a result file.");return;}
    if(!catalogReady){status(compareStatus,"Metric catalog is still loading.",true);return;}
    status(compareStatus,`Reading ${file.name}...`);
    try{
        const records=file.name.toLowerCase().endsWith(".sql")?await parseSQL(file):await parseHTML(file);
        status(compareStatus,`Matching ${records.length.toLocaleString()} extracted records against the ${climate} metric catalog...`);
        const results=await compareRecords(records,climate);
        renderComparison(results,file.name);
    }catch(e){console.error(e);status(compareStatus,`Comparison failed: ${e.message}`,true);}
}

async function getSQL(){
    return await initSqlJs({locateFile:file=>`https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.13.0/${file}`});
}
function tableExists(db,name){return db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?",[name]).length>0;}
function columnNames(db,table){try{return db.exec(`PRAGMA table_info("${table.replaceAll('"','""')}")`)[0]?.values.map(r=>r[1])||[];}catch{return[];}}
function environmentIds(db){if(!tableExists(db,"EnvironmentPeriods")||!tableExists(db,"Time"))return[];try{const rows=db.exec("SELECT EnvironmentPeriodIndex, EnvironmentName FROM EnvironmentPeriods")[0]?.values||[];const ids=rows.filter(r=>!/(design day|sizing)/i.test(String(r[1]||""))&&/(weather|run period|runperiod|annual)/i.test(String(r[1]||""))).map(r=>r[0]);return ids;}catch{return[];}}

async function parseSQL(file){
    const SQL=await getSQL(),buffer=await file.arrayBuffer(),db=new SQL.Database(new Uint8Array(buffer));const records=[];
    if(tableExists(db,"ReportDataDictionary")&&tableExists(db,"ReportData")){
        const dict=db.exec("SELECT ReportDataDictionaryIndex,KeyValue,Name,ReportingFrequency,Units,IsMeter FROM ReportDataDictionary WHERE Name IS NOT NULL")[0]?.values||[];
        const env=environmentIds(db),hasEnv=env.length&&columnNames(db,"Time").includes("EnvironmentPeriodIndex");
        for(const [did,key,name,freq,unit,isMeter] of dict){
            const scope=scopeFor(key,name);if(!["building","system"].includes(scope))continue;
            if(isMeter&&scope==="building"&&!/^(|whole building|facility|whole building:facility|electricity:facility|gas:facility|naturalgas:facility)$/i.test(String(key||"")))continue;
            let rows=[];
            try{
                if(hasEnv){const marks=env.map(()=>"?").join(",");rows=db.exec(`SELECT rd.Value FROM ReportData rd JOIN Time t ON t.TimeIndex=rd.TimeIndex WHERE rd.ReportDataDictionaryIndex=? AND t.EnvironmentPeriodIndex IN (${marks})`,[did,...env])[0]?.values||[];}
                else rows=db.exec("SELECT Value FROM ReportData WHERE ReportDataDictionaryIndex=?",[did])[0]?.values||[];
            }catch{rows=[];}
            const vals=rows.map(r=>Number(r[0])).filter(Number.isFinite);if(!vals.length)continue;
            const targetUnit=normalizeUnit(unit),converted=vals.map(v=>convertUnitValue(v,unit,targetUnit));
            const agg=aggregationFor(name,unit);let value;
            if(agg==="sum")value=converted.reduce((a,b)=>a+b,0);else if(agg==="max")value=Math.max(...converted);else value=converted.reduce((a,b)=>a+b,0)/converted.length;
            records.push({scope,variable_name:String(name||""),key_value:String(key||""),unit:targetUnit,original_unit:String(unit||""),aggregation:agg,value});
        }
    }
    if(tableExists(db,"TabularDataWithStrings")){
        try{const rows=db.exec("SELECT ReportName,ReportForString,TableName,RowName,ColumnName,Units,Value FROM TabularDataWithStrings WHERE Value IS NOT NULL")[0]?.values||[];for(const [report,reportFor,table,row,column,unit,value] of rows){const name=`${table} | ${row} | ${column}`,scope=scopeFor(reportFor,name);if(!["building","system"].includes(scope))continue;const n=Number(String(value).replace(/,/g,""));if(!Number.isFinite(n))continue;records.push({scope,variable_name:name,key_value:`${report} | ${reportFor||""}`,unit:normalizeUnit(unit),original_unit:String(unit||""),aggregation:"direct",value:convertUnitValue(n,unit,normalizeUnit(unit))});}}catch(e){console.warn(e);}
    }
    db.close();return records;
}

async function parseHTML(file){
    const html=await file.text(),doc=new DOMParser().parseFromString(html,"text/html"),records=[];
    for(const table of doc.querySelectorAll("table")){
        const rows=[...table.querySelectorAll("tr")];if(!rows.length)continue;
        const headers=[...rows[0].querySelectorAll("th,td")].map(x=>x.textContent.trim().replace(/\s+/g," "));
        for(const row of rows.slice(1)){
            const cells=[...row.querySelectorAll("th,td")].map(x=>x.textContent.trim().replace(/\s+/g," "));if(!cells.length)continue;
            const rowName=cells[0];for(let i=1;i<cells.length;i++){
                const match=cells[i].replace(/,/g,"").match(/[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[Ee][-+]?\d+)?/);if(!match)continue;
                const column=headers[i]||`Column ${i}`,name=`${rowName} — ${column}`,scope=scopeFor("",name);if(!scope)continue;
                const unitMatch=(headers[i]||"").match(/\[([^\]]+)\]|\{([^}]+)\}/);const rawUnit=unitMatch?(unitMatch[1]||unitMatch[2]):"";
                records.push({scope,variable_name:name,key_value:"",unit:normalizeUnit(rawUnit),original_unit:rawUnit,aggregation:"direct",value:convertUnitValue(Number(match[0]),rawUnit,normalizeUnit(rawUnit))});
            }
        }
    }return records;
}

function same(a,b){return norm(a)===norm(b);}
function metricScope(metric){
    if(metric.scope)return norm(metric.scope);
    return scopeFor(metric.key_value,metric.variable_name)||"";
}
function metricKey(m){return [metricScope(m),norm(m.variable_name),norm(m.key_value||""),norm(m.unit||""),norm(m.aggregation||"")].join("||");}

function updateCompareProgress(done,total,matched=0){
    const pct=total?Math.round(done/total*100):0;
    const bar=$("compareProgressBar"),label=$("compareProgressLabel");
    if(bar)bar.style.width=`${pct}%`;
    if(label)label.textContent=`Checking reference metrics: ${done.toLocaleString()} / ${total.toLocaleString()} (${pct}%) • ${matched.toLocaleString()} matched`;
}

async function compareRecords(records,climate){
    const candidates=catalog.filter(m=>climateNorm(m.climate_zone)===climateNorm(climate)&&["building","system"].includes(metricScope(m))&&m.file);
    const byKey=new Map();
    for(const m of candidates){
        const k=metricKey(m);if(!byKey.has(k))byKey.set(k,[]);byKey.get(k).push(m);
    }

    // Index the uploaded model once. The previous version compared every uploaded
    // record against every reference metric, which becomes very expensive.
    const recordsByKey=new Map();
    for(const record of records){
        const k=metricKey(record);
        if(!recordsByKey.has(k))recordsByKey.set(k,[]);
        recordsByKey.get(k).push(record);
    }

    const entries=[...byKey.entries()];
    const results=[];const used=new Set();let done=0,matched=0;
    compareProgress.hidden=false;
    updateCompareProgress(0,entries.length,0);
    status(compareStatus,`Preparing ${entries.length.toLocaleString()} reference metrics...`);

    // Fetch reference files in parallel batches. This keeps the browser responsive
    // while replacing the old one-file-at-a-time loop.
    const batchSize=24;
    for(let start=0;start<entries.length;start+=batchSize){
        const batch=entries.slice(start,start+batchSize);
        const loaded=await Promise.all(batch.map(async([key,ms])=>{
            try{
                const payload=await loadMetric(ms[0]);
                const vals=(payload.values||[]).map(x=>Number(x.value)).filter(Number.isFinite);
                return {key,metric:ms[0],vals};
            }catch(e){console.warn("Reference metric load failed",key,e);return {key,metric:ms[0],vals:[]};}
        }));

        for(const {key,metric,vals} of loaded){
            done++;
            if(vals.length<4)continue;
            const modelRecords=recordsByKey.get(key)||[];
            if(!modelRecords.length)continue;
            const stats=boxStats(vals);
            for(const record of modelRecords){
                const converted=convertUnitValue(record.value,record.unit,metric.unit);if(!Number.isFinite(converted))continue;
                const out=converted<stats.lowerFence||converted>stats.upperFence;
                const robustZ=stats.iqr===0?0:(converted-stats.median)/(stats.iqr/1.349);
                const id=`${key}::${record.scope}::${record.variable_name}`;if(used.has(id))continue;used.add(id);
                matched++;
                results.push({...record,value:converted,reference:{...metric,median:stats.median,lower_fence:stats.lowerFence,upper_fence:stats.upperFence,q1:stats.q1,q3:stats.q3,iqr:stats.iqr,reference_count:vals.length},isOutlier:out,direction:converted>stats.upperFence?"high":converted<stats.lowerFence?"low":"within",robustZ});
            }
        }
        updateCompareProgress(done,entries.length,matched);
        status(compareStatus,`Checking reference metrics: ${done.toLocaleString()} / ${entries.length.toLocaleString()} • ${matched.toLocaleString()} matched`);
        await new Promise(requestAnimationFrame);
    }
    updateCompareProgress(entries.length,entries.length,matched);
    return results.sort((a,b)=>Math.abs(b.robustZ)-Math.abs(a.robustZ));
}

function fmt(x){return Number(x).toLocaleString(undefined,{maximumFractionDigits:2});}
function renderComparison(results,fileName){
    const outliers=results.filter(x=>x.isOutlier),building=results.filter(x=>x.scope==="building"),system=results.filter(x=>x.scope==="system");
    summary.innerHTML=`<div class="summary-item"><strong>${results.length}</strong><span>matched metrics</span></div><div class="summary-item"><strong>${outliers.length}</strong><span>outliers</span></div><div class="summary-item"><strong>${building.length}</strong><span>building metrics</span></div><div class="summary-item"><strong>${system.length}</strong><span>system metrics</span></div>`;summary.hidden=false;
    resultsTable.querySelector("tbody").innerHTML="";
    for(const x of outliers){const r=x.reference,tr=document.createElement("tr"),diff=r.median===0?NaN:((x.value-r.median)/Math.abs(r.median))*100;tr.innerHTML=`<td>${escapeHTML(x.scope)}</td><td>${escapeHTML(x.variable_name)}</td><td>${fmt(x.value)} ${escapeHTML(x.unit)}</td><td>${fmt(r.median)} ${escapeHTML(r.unit)}</td><td>${fmt(r.lower_fence)} – ${fmt(r.upper_fence)} ${escapeHTML(r.unit)}</td><td>${Number.isFinite(diff)?`${diff>=0?"+":""}${fmt(diff)}%`:"—"}</td>`;resultsTable.querySelector("tbody").appendChild(tr);}
    resultsWrap.hidden=false;
    compareProgress.hidden=true;
    if(outliers.length){const top=outliers.slice(0,25).reverse();Plotly.react("outlierPlot",[{type:"bar",orientation:"h",x:top.map(x=>x.robustZ),y:top.map(x=>x.variable_name),customdata:top.map(x=>[x.value,x.unit,x.direction]),hovertemplate:"<b>%{y}</b><br>Model: %{customdata[0]:,.2f} %{customdata[1]}<br>Direction: %{customdata[2]}<br>Robust z: %{x:.2f}<extra></extra>"}],{margin:{l:280,r:30,t:20,b:50},xaxis:{title:"Robust z-score"},yaxis:{automargin:true},shapes:[{type:"line",x0:0,x1:0,y0:-.5,y1:top.length-.5}]},{responsive:true,displaylogo:false});outlierChart.hidden=false;}
    status(compareStatus,`${fileName}: ${results.length} comparable building/system metrics found; ${outliers.length} flagged as outliers.${results.length===0?" No metrics matched the selected climate zone — this is a matching issue, not evidence that the model has no discrepancies.":""}`);
}
function escapeHTML(v){return String(v??"").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#039;");}
