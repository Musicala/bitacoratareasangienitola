/* script.js — Musicala · Tareas académicas + Bitácora (Santiago)
   - Lee config.json (o ?config=otra.json)
   - Pinta TODAS las columnas de la hoja
   - Filtros: Responsable / Estado / Urgencia + buscador
   - Contadores: Pendientes / En curso / Cumplidas
   - Bitácora: modal con lista de logs + POST para agregar registro

   UX incluido:
   · Ordenar por columnas
   · Guardar/restaurar filtros, búsqueda y orden (localStorage)
   · Chips rápidos por estado
   · Atajo: "/" enfoca buscador; ESC cierra modal
   · Resaltado de filas por fechas (vencida / hoy / pronto)
   · Botón "Limpiar filtros"
   · Columna "Documento y Herramientas" como hipervínculo automático
*/

const $  = (s, ctx=document)=>ctx.querySelector(s);
const $$ = (s, ctx=document)=>Array.from(ctx.querySelectorAll(s));
const norm = s => String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
const esc  = v => String(v ?? '').replace(/[&<>"']/g, m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m]));
function setStatus(m, isErr=false){ const el=$('#status'); if(el){ el.textContent=m; el.className=isErr?'status err':'status'; } }
function debounce(fn, ms=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

// ----- Preferencias UI -----
const TZ = 'America/Bogota';
const ls = window.localStorage;
const LS_KEY = 'bitacora_santiago_ui_v2';

// ----- Config y datos -----
const DEFAULT_CONFIG_FILE = 'config.json';
let CONFIG=null, RAW_HEADERS=[], RAW_ROWS=[];
let IDX = {};                 // nombre normalizado -> índice
let SORT = null;              // { col, dir: 1|-1 }
let LAST_RENDER_ROWS = [];    // copia de las filas actualmente renderizadas (post-filtros)

// ===================== Config & Fetch =====================

async function loadConfig(){
  const url = new URL(location.href);
  const confFile = url.searchParams.get('config') || DEFAULT_CONFIG_FILE;

  setStatus('Cargando configuración…');
  const res = await fetch(confFile, { cache:'no-store' });
  if(!res.ok) throw new Error(`No pude cargar ${confFile} (${res.status})`);
  const json = await res.json();

  if (!json?.api?.baseUrl) throw new Error('config.api.baseUrl es requerido');
  if (!json?.dataset)      throw new Error('config.dataset es requerido');
  CONFIG = json;

  // Branding opcional
  if (CONFIG?.branding?.logo)     { const el=$('#site-logo');     if(el) el.src = CONFIG.branding.logo; }
  if (CONFIG?.branding?.title)    { const el=$('#site-title');    if(el) el.textContent = CONFIG.branding.title; }
  if (CONFIG?.branding?.subtitle) { const el=$('#site-subtitle'); if(el) el.textContent = CONFIG.branding.subtitle; }

  setStatus('Configuración lista.');
}

async function fetchData(){
  if(!CONFIG) await loadConfig();

  setStatus('Cargando datos…');
  const base    = CONFIG.api.baseUrl.replace(/\?+$/, '');
  const keyName = (CONFIG.api.paramName || 'consulta').trim();
  const dataset = encodeURIComponent(CONFIG.dataset);
  const extraQS = CONFIG.api.queryString ? `&${CONFIG.api.queryString.replace(/^\&/, '')}` : '';
  const url     = `${base}?${encodeURIComponent(keyName)}=${dataset}${extraQS}`;

  const res  = await fetch(url, { cache:'no-store' });
  const text = await res.text();
  let payload;
  try { payload = JSON.parse(text); }
  catch { throw new Error('Respuesta no-JSON del Web App: ' + text.slice(0, 200)); }
  if (payload.ok === false) throw new Error(payload.error || 'Error backend');

  RAW_HEADERS = payload.headers || [];
  RAW_ROWS    = payload.rows    || [];

  IDX = {};
  RAW_HEADERS.forEach((h,i)=>{ IDX[norm(h)] = i; });

  setStatus(`${RAW_ROWS.length} fila${RAW_ROWS.length===1?'':'s'} cargada${RAW_ROWS.length===1?'':'s'}.`);
}

// ===================== Utilidades de fechas y tipos =====================

function parseDateMaybe(v){
  if(v==null) return null;
  const s = String(v).trim();
  if(!s) return null;

  // 2025-09-08 [hh:mm]
  let m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(m){
    const [_, Y, Mo, D, H='0', Mi='0', S='0'] = m;
    const d = new Date(Date.UTC(+Y, +Mo-1, +D, +H, +Mi, +S));
    return isNaN(d) ? null : d;
  }

  // 08/09/2025 [hh:mm]
  m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if(m){
    const [_, D, Mo, Y, H='0', Mi='0', S='0'] = m;
    const d = new Date(Date.UTC(+Y, +Mo-1, +D, +H, +Mi, +S));
    return isNaN(d) ? null : d;
  }

  const d = new Date(s);
  return isNaN(d) ? null : d;
}

function todayAtTZ(hours=0, minutes=0, seconds=0){
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, year:'numeric', month:'2-digit', day:'2-digit' });
  const parts = fmt.formatToParts(now).reduce((acc,p)=>{ acc[p.type]=p.value; return acc; },{});
  const Y = +parts.year;
  const M = +parts.month;
  const D = +parts.day;
  return new Date(Date.UTC(Y, M-1, D, hours, minutes, seconds));
}

function diffDaysTZ(date){
  if(!date) return null;
  const start = todayAtTZ(0,0,0);
  const end   = todayAtTZ(23,59,59);
  const t0 = start.getTime(), t1 = end.getTime();
  const t  = date.getTime();
  if (t < t0) return Math.ceil((t - t0) / (24*3600e3));
  if (t > t1) return Math.floor((t - t1) / (24*3600e3));
  return 0; // hoy
}

function looksNumeric(s){
  return /^-?\d+([.,]\d+)?$/.test(String(s).trim());
}

// ===================== Linkify para "Documento y Herramientas" =====================

function linkify(text){
  const s = String(text ?? '');
  if(!s) return '';
  // URLs comunes (http/https) y enlaces de Drive/Docs
  const urlRe = /(https?:\/\/[^\s<>"]+[^<>)\s"'])/g;
  return s.replace(urlRe, (u)=>{
    const safe = esc(u);
    return `<a href="${safe}" target="_blank" rel="noopener">${safe}</a>`;
  });
}

// ===================== Render de tabla =====================

function buildHeaderHTML(){
  return '<tr>' +
    RAW_HEADERS.map((h,i)=>`<th data-col="${i}" role="button" aria-label="Ordenar por ${esc(h)}">${esc(h)} <span class="sort-ico" aria-hidden="true"></span></th>`).join('') +
    '<th>Acciones</th></tr>';
}

function decorateCell(hIndex, value){
  const headerName = norm(RAW_HEADERS[hIndex]);

  // Urgencia como badge
  if(headerName === 'urgencia'){
    const v = norm(value);
    const cls = v.includes('alta') ? 'alta' : v.includes('media') ? 'media' : v ? 'baja' : '';
    return `<span class="badge-urg ${cls}">${esc(value)}</span>`;
  }

  // Columna Documento y Herramientas -> hipervínculos
  if(headerName === norm('Documento y Herramientas')){
    const out = linkify(value);
    return out || esc(value);
  }

  return esc(value);
}

function renderTable(rows){
  const thead = $('#tbl thead');
  const tbody = $('#tbl tbody');
  const iId   = IDX[norm('id')];

  thead.innerHTML = buildHeaderHTML();

  const safe = rows || [];
  if(!safe.length){
    tbody.innerHTML = `<tr class="no-results"><td colspan="${RAW_HEADERS.length+1}">No hay resultados con los filtros actuales.</td></tr>`;
    LAST_RENDER_ROWS = [];
    markHeaderSort();
    return;
  }

  tbody.innerHTML = safe.map(r => {
    const id = iId!=null ? r[iId] : '';
    const tds = RAW_HEADERS.map((h,i)=>`<td class="wrap" data-th="${esc(h)}">${decorateCell(i, r[i])}</td>`).join('');
    const acc = `<td data-th="Acciones" style="text-align:center">
      <button class="btn btn-primary btn-detail" data-id="${esc(id)}" title="Abrir registro de bitácora">
        <span class="btn-ico">📝</span><span>Registro</span>
      </button>
    </td>`;
    return `<tr data-id="${esc(id)}">${tds}${acc}</tr>`;
  }).join('');

  LAST_RENDER_ROWS = safe.slice();
  applyDateHighlights();
  markHeaderSort();
}

// ===================== Filtros =====================

function uniqueSorted(values){
  const s = new Set(values.map(v => String(v||'').trim()).filter(Boolean));
  return Array.from(s).sort((a,b)=>a.localeCompare(b, 'es', { sensitivity:'base' }));
}

function fillSelect(sel, options, placeholder){
  if(!sel) return;
  if (!options.length){
    sel.innerHTML = `<option value="">${placeholder}</option>`;
    sel.style.display = 'none';
    return;
  }
  sel.innerHTML = `<option value="">${placeholder}</option>` +
    options.map(o => `<option value="${esc(o)}">${esc(o)}</option>`).join('');
  sel.style.display = '';
}

function fillFilters(){
  const iP = IDX[norm('persona encargada')] ?? IDX[norm('responsable')];
  const iE = IDX[norm('estado')];
  const iU = IDX[norm('urgencia')];

  const personas = (iP!=null) ? uniqueSorted(RAW_ROWS.map(r => r[iP])) : [];
  const estados  = (iE!=null) ? uniqueSorted(RAW_ROWS.map(r => r[iE])) : [];
  const urg      = (iU!=null) ? uniqueSorted(RAW_ROWS.map(r => r[iU])) : [];

  fillSelect($('#fPersona'),  personas, 'Responsable: todos');
  fillSelect($('#fEstado'),   estados,  'Estado: todos');
  fillSelect($('#fUrgencia'), urg,      'Urgencia: todas');
}

function applyFilters(){
  const selP = $('#fPersona')?.value || '';
  const selE = $('#fEstado')?.value  || '';
  const selU = $('#fUrgencia')?.value|| '';
  const qn   = norm( ($('#q')?.value || '').trim() );

  const iP = IDX[norm('persona encargada')] ?? IDX[norm('responsable')];
  const iE = IDX[norm('estado')];
  const iU = IDX[norm('urgencia')];

  let filtered = RAW_ROWS.filter(row => {
    if (selP && iP!=null && String(row[iP]||'') !== selP) return false;
    if (selE && iE!=null && String(row[iE]||'') !== selE) return false;
    if (selU && iU!=null && String(row[iU]||'') !== selU) return false;
    if (qn && !row.some(c => norm(c).includes(qn))) return false;
    return true;
  });

  if(SORT){
    filtered = filtered.slice().sort((a,b)=>compareCells(a,b,SORT.col)*SORT.dir);
  }

  renderTable(filtered);
  updateBadges(filtered);
  saveUI();
}

function updateBadges(rows){
  const pendEl = $('#badgePend');
  const cursoEl= $('#badgeCurso');
  const compEl = $('#badgeComp');

  const iE = IDX[norm('estado')];
  let pend=0, curso=0, comp=0;

  rows.forEach(r=>{
    const s = (iE!=null) ? norm(r[iE]) : '';
    if (!s) { pend++; return; }
    if (s.startsWith('pend') || s.includes('por hacer')) pend++;
    else if (s.includes('curso') || s.includes('progreso')) curso++;
    else if (s.startsWith('cumpl') || s.includes('hecha') || s.includes('termin')) comp++;
    else pend++;
  });

  if (pendEl)  pendEl.textContent  = `Pendientes: ${pend}`;
  if (cursoEl) cursoEl.textContent = `En curso: ${curso}`;
  if (compEl)  compEl.textContent  = `Cumplidas: ${comp}`;
  setStatus(`Mostrando ${rows.length} fila${rows.length===1?'':'s'}.`);
}

// ===================== Ordenamiento =====================

function markHeaderSort(){
  const ths = $$('#tbl thead th');
  ths.forEach(th=>{
    const ico = th.querySelector('.sort-ico');
    if(!ico) return;
    ico.textContent = '';
    th.classList.remove('sorted-asc','sorted-desc');
  });
  if(!SORT) return;
  const th = $(`#tbl thead th[data-col="${SORT.col}"]`);
  if(!th) return;
  const ico = th.querySelector('.sort-ico');
  if(ico) ico.textContent = SORT.dir === 1 ? '▲' : '▼';
  th.classList.add(SORT.dir === 1 ? 'sorted-asc' : 'sorted-desc');
}

function compareCells(a,b,col){
  const av = a[col], bv = b[col];
  const ad = parseDateMaybe(av), bd = parseDateMaybe(bv);
  if(ad && bd){ return ad - bd; }
  if(looksNumeric(av) && looksNumeric(bv)){
    return parseFloat(String(av).replace(',','.')) - parseFloat(String(bv).replace(',','.'));
  }
  return String(av||'').localeCompare(String(bv||''), 'es', { sensitivity:'base', numeric:true });
}

// ===================== Resaltado por fechas =====================

function applyDateHighlights(){
  const cand = ['fecha límite','fecha limite','vence','plazo','entrega','fecha de entrega','fecha'];
  const idxDeadline = cand.map(norm).map(k => IDX[k]).find(i => i!=null);
  if(idxDeadline==null) return;

  const rows = $$('#tbl tbody tr');
  rows.forEach((tr)=>{
    if(tr.classList.contains('no-results')) return;
    const cell = tr.children[idxDeadline];
    const text = cell ? cell.textContent.trim() : '';
    const d = parseDateMaybe(text);
    tr.classList.remove('is-overdue','is-today','is-soon');
    if(!d) return;
    const dd = diffDaysTZ(d);
    if(dd===null) return;
    if(dd < 0) tr.classList.add('is-overdue');
    else if(dd === 0) tr.classList.add('is-today');
    else if(dd <= 3) tr.classList.add('is-soon');
  });
}

// ===================== Bitácora (modal) =====================

function showModal(){ $('#modalLog')?.classList.add('show'); }
function hideModal(){ $('#modalLog')?.classList.remove('show'); $('#logStatus').textContent=''; }

async function openDetailById(id){
  const iId   = IDX[norm('id')];
  const iName = IDX[norm('tarea')];
  const iPers = IDX[norm('persona encargada')] ?? IDX[norm('responsable')];

  const row = RAW_ROWS.find(r => String(r[iId]) === String(id));
  $('#logTaskId').value           = id || '';
  $('#logTaskIdTxt').textContent  = id || '—';
  $('#logTaskName').textContent   = row ? (row[iName] || '—') : '—';

  // Asignar responsable al hidden (Santiago por defecto si no hay columna)
  const resp = row && iPers!=null ? (row[iPers] || 'Santiago Gutiérrez') : 'Santiago Gutiérrez';
  const hiddenPersona = $('#logPersona');
  if(hiddenPersona) hiddenPersona.value = resp;

  await loadLogs(id);
  showModal();
}

async function loadLogs(id){
  try{
    const base    = CONFIG.api.baseUrl.replace(/\?+$/, '');
    const keyName = (CONFIG.api.paramName || 'consulta').trim();
    const url     = `${base}?${encodeURIComponent(keyName)}=logs_tarea&id=${encodeURIComponent(id)}`;

    const res  = await fetch(url, { cache:'no-store' });
    const text = await res.text();
    let payload; try{ payload = JSON.parse(text); }catch{ throw new Error('Respuesta no-JSON del Web App (logs)'); }
    if (payload.ok === false) throw new Error(payload.error || 'Error backend (logs)');

    const headers = payload.headers || [];
    const rows    = payload.rows || [];

    $('#tblLogs thead').innerHTML = '<tr>' + headers.map(h=>`<th>${esc(h)}</th>`).join('') + '</tr>';
    $('#tblLogs tbody').innerHTML = rows.length
      ? rows.map(r => `<tr>${ headers.map((h,i)=>`<td class="wrap" data-th="${esc(h)}">${esc(r[i])}</td>`).join('') }</tr>`).join('')
      : `<tr class="no-results"><td colspan="${headers.length}">Sin registros aún.</td></tr>`;

    $('#logStatus').textContent = `${rows.length} registro${rows.length===1?'':'s'}`;
  }catch(err){
    console.error(err);
    $('#logStatus').textContent = 'Error: ' + err.message;
  }
}

async function submitLog(e){
  e.preventDefault();
  const id     = $('#logTaskId').value.trim();
  const perso  = $('#logPersona')?.value.trim(); // hidden con Santiago
  const inicio = $('#logInicio').value;
  const fin    = $('#logFin').value;
  const tarea  = ($('#logTaskName')?.textContent || '').trim();
  const estado = $('#logEstado').value;

  const avanzo  = $('#logAvanzo').value.trim();
  const falta   = $('#logFalta').value.trim();
  const mejorar = $('#logMejorar').value.trim();

  if (!id){ $('#logStatus').textContent = 'Falta el ID de la tarea.'; return; }

  try{
    $('#logStatus').textContent = 'Guardando…';
    const body = new URLSearchParams({
      action:'add_log',
      id,
      tarea,
      persona: perso || 'Santiago Gutiérrez',
      inicio, fin,
      avanzo, falta, mejorar,
      estado
    });

    const res  = await fetch(CONFIG.api.baseUrl.replace(/\?+$/, ''), { method:'POST', body });
    const text = await res.text();
    const payload = JSON.parse(text);
    if (payload.ok === false) throw new Error(payload.error || 'Error backend (POST)');

    // limpiar y recargar lista
    $('#logInicio').value=''; $('#logFin').value='';
    $('#logAvanzo').value=''; $('#logFalta').value=''; $('#logMejorar').value='';
    $('#logEstado').value='';
    await loadLogs(id);
    $('#logStatus').textContent = 'Guardado ✔';
  }catch(err){
    console.error(err); $('#logStatus').textContent = 'Error: ' + err.message;
  }
}

// ===================== Preferencias (localStorage) =====================

function saveUI(){
  const data = {
    p: $('#fPersona')?.value || '',
    e: $('#fEstado')?.value  || '',
    u: $('#fUrgencia')?.value|| '',
    q: $('#q')?.value || '',
    sort: SORT
  };
  ls.setItem(LS_KEY, JSON.stringify(data));
}

function loadUI(){
  try{
    const data = JSON.parse(ls.getItem(LS_KEY) || '{}');
    if($('#fPersona')) $('#fPersona').value = data.p ?? '';
    if($('#fEstado'))  $('#fEstado').value  = data.e ?? '';
    if($('#fUrgencia'))$('#fUrgencia').value= data.u ?? '';
    if($('#q'))        $('#q').value        = data.q ?? '';
    SORT = data.sort || null;
  }catch(_){}
}

// ===================== UI extra (chips, atajos, botones) =====================

function setupChips(){
  const iE = IDX[norm('estado')];
  if(iE==null) { $('.chips')?.remove(); return; }

  $$('.chip').forEach(ch=>{
    ch.addEventListener('click', ()=>{
      const k = ch.dataset.chip; // 'pend' | 'curso' | 'comp'
      const sel = $('#fEstado');
      if(sel && sel.options.length){
        const want = k==='pend' ? 'pend' : k==='curso' ? 'curso' : 'cumpl';
        let found = '';
        for(const opt of sel.options){
          if(norm(opt.value).includes(want)){ found = opt.value; break; }
        }
        sel.value = found;
      }
      $$('.chip').forEach(c=>c.classList.remove('active'));
      ch.classList.add('active');
      applyFilters();
    });
  });
}

function clearChipsActive(){
  $$('.chip').forEach(c=>c.classList.remove('active'));
}

function setupToolbarExtras(){
  $('#btnClear')?.addEventListener('click', ()=>{
    if($('#fPersona')) $('#fPersona').value = '';
    if($('#fEstado'))  $('#fEstado').value  = '';
    if($('#fUrgencia'))$('#fUrgencia').value= '';
    if($('#q'))        $('#q').value        = '';
    clearChipsActive();
    SORT = null;
    applyFilters();
  });

  // Atajo "/" para enfocar buscador
  document.addEventListener('keydown', (e)=>{
    if(e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey){
      const tag = document.activeElement?.tagName?.toLowerCase();
      if(tag!=='input' && tag!=='textarea'){
        e.preventDefault();
        $('#q')?.focus();
      }
    }
  });
}

// Click en encabezados para ordenar
function setupHeaderSort(){
  $('#tbl thead')?.addEventListener('click', (ev)=>{
    const th = ev.target.closest('th[data-col]');
    if(!th) return;
    const col = +th.dataset.col;
    if(!SORT || SORT.col!==col){
      SORT = { col, dir: 1 };
    } else {
      SORT.dir = SORT.dir===1 ? -1 : 1;
    }
    let rows = LAST_RENDER_ROWS.slice();
    rows.sort((a,b)=>compareCells(a,b,col)*SORT.dir);
    renderTable(rows);
    updateBadges(rows);
    saveUI();
  });
}

// ===================== Init =====================

async function init(){
  try{
    await loadConfig();
    await fetchData();
    fillFilters();
    loadUI();          // restaura filtros, búsqueda y sort
    applyFilters();    // pinta con filtros (y aplica sort si existe)
  }catch(err){
    console.error(err);
    setStatus('Error: ' + err.message, true);
  }

  // Listeners básicos
  $('#btnReload')?.addEventListener('click', async ()=>{
    try{
      await fetchData(); fillFilters(); loadUI(); applyFilters();
    }catch(err){ console.error(err); setStatus('Error: ' + err.message, true); }
  });
  $('#fPersona')?.addEventListener('change', ()=>{ applyFilters(); });
  $('#fEstado') ?.addEventListener('change', ()=>{ clearChipsActive(); applyFilters(); });
  $('#fUrgencia')?.addEventListener('change', ()=>{ applyFilters(); });
  $('#q')?.addEventListener('input', debounce(()=>{ applyFilters(); }, 250));

  $('#tbl')?.addEventListener('click', ev=>{
    const btn = ev.target.closest('.btn-detail');
    if (btn) openDetailById(btn.dataset.id);
  });

  $('#modalLog')?.addEventListener('click', ev=>{ if (ev.target.dataset.close) hideModal(); });
  $$('.modal__close')?.forEach(b => b.addEventListener('click', hideModal));
  $('#logForm')?.addEventListener('submit', submitLog);
  document.addEventListener('keydown', e=>{ if(e.key==='Escape') hideModal(); });

  setupChips();
  setupToolbarExtras();
  setupHeaderSort();
}

document.addEventListener('DOMContentLoaded', init);
