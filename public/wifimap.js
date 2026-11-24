/* wifimap.js — Network Scanner Wi-Fi map on the project's Takeoffs floor plans (v1.5.0, 2026-11-24)
 * Bryn: "it should load the floor plan of the takeoffs wifi aps and we use that as the basis … or survey if no project plan
 * exists yet or general floorplan to add aps … but obviously office gets final approval before plan commit".
 *
 * Sources (one at a time):
 *   takeoffs — the project's Takeoffs floors (takeoffs_floors: rooms = content.areas, outline = content.buildingOutline,
 *              APs = content.symbols with a WAP/AP code, scale = content.scalePxPerM) + the ACTIVE plan image
 *              (takeoffs_floor_plans via the shared sonor-plan-image.js, fitted exactly like Takeoffs, so a tap is a Takeoffs point).
 *   upload   — no Takeoffs plan yet: a photo / PDF of any drawing, fitted the same way; scale set by tapping a known length.
 *   blank    — a grid, for a quick survey with nothing to draw on.
 * Readings (the walk test) are stored at world points with their floor, the room is taken from the room polygon.
 * Heat: measured (inverse-distance between readings, clipped to the building) or predicted (log-distance model from the APs,
 * calibrated against readings that are linked to an AP). Proposed AP changes (add / move / remove) travel with the uploaded
 * scan (net_scans.netinfo.wifiPlan); Takeoffs is only written when the office presses Apply on the review — a version-guarded
 * update of that floor (the same compare-and-swap Takeoffs uses), then the scan's revision note says what changed.
 * Floor plans are never uploaded from here: plans are added in Takeoffs on the Mac; tablets read them.
 */
(function (root) {
  'use strict';
  var C = null;                         // page context, from init()
  var SPACE = { w: 1400, h: 900 };      // the Takeoffs frame (sonor-plan-image.js)
  var AP_RE = /^(\d+-)?W?AP(-|$)/;
  var AP_MODELS = [['WAP-CEIL', 'Ceiling AP'], ['WAP-WALL', 'Wall AP'], ['AP-OUT', 'Outdoor AP']];
  var TARGET = -67;                     // dBm: good enough for calls and streaming everywhere
  var S = load();                       // { source, projectId, projectName, floors[], floorId, proposals[], links{}, upload{img,scale}, model{} }
  var view = { tool: 'stand', heat: 'compare', pos: null, moving: null, scaleA: null, review: null, img: null, imgFor: null, t: null };
  var cv = null, ctx2 = null;

  function blank() { return { source: null, projectId: null, projectName: '', floors: [], floorId: null, proposals: [], links: {}, upload: null }; }
  function load() { try { var s = JSON.parse(localStorage.getItem('netscan.wmap') || 'null'); return s && typeof s === 'object' ? Object.assign(blank(), s) : blank(); } catch (e) { return blank(); } }
  function save() { if (view.review) return; try { localStorage.setItem('netscan.wmap', JSON.stringify(Object.assign({}, S, { upload: S.upload ? { scale: S.upload.scale, name: S.upload.name } : null }))); } catch (e) { } }

  // ── geometry (pure, exported for tests) ─────────────────
  function inPoly(p, pts) { var c = false; for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) { var a = pts[i], b = pts[j]; if (((a.y > p.y) !== (b.y > p.y)) && (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x)) c = !c; } return c; }
  function polyArea(pts) { var s = 0; for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) s += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y); return Math.abs(s / 2); }
  function centroid(pts) { var x = 0, y = 0; pts.forEach(function (p) { x += p.x; y += p.y; }); return { x: x / pts.length, y: y / pts.length }; }
  function roomAt(fl, p) { var best = null; (fl.areas || []).forEach(function (a) { if (a.points && a.points.length > 2 && inPoly(p, a.points)) { var ar = polyArea(a.points); if (!best || ar < best.ar) best = { a: a, ar: ar }; } }); return best ? best.a : null; }
  function inside(fl, p) {
    var outl = (fl.outline || []).filter(function (o) { return o.points && o.points.length > 2; });
    if (outl.length) return outl.some(function (o) { return inPoly(p, o.points); });
    if ((fl.areas || []).length) return !!roomAt(fl, p);
    var r = fl.rect; return !r || (p.x >= r.x && p.y >= r.y && p.x <= r.x + r.w && p.y <= r.y + r.h);
  }
  function isAp(sym) { var ss = sym && sym.sonorSymbol; return !!ss && (ss.glyph === 'WAP' || AP_RE.test(ss.code || '')); }
  function apsFrom(content) {
    return (content.symbols || []).filter(isAp).map(function (s) { var ss = s.sonorSymbol, a = ss.autoId || {};
      return { uid: ss.uid, x: s.x, y: s.y, code: ss.code, id: a.id || ss.labelText || ss.code, label: ss.label || ss.code, outdoor: /OUT/.test(ss.code || ''), room: a.roomName || ss.room || '' }; });
  }
  // log-distance path loss: rssi = p0 - 10 n log10(d), d in metres (floor at 1 m)
  // walls: every room edge the straight line crosses costs WALL_DB (a wall between two rooms is two edges, ~5 dB, a typical
  // internal stud / block wall at 5 GHz); capped so a long line through many rooms does not go to nothing
  var WALL_DB = 2.5, WALL_CAP = 30;
  function segX(a, b, c, d) { var d1 = (d.x - c.x) * (a.y - c.y) - (d.y - c.y) * (a.x - c.x), d2 = (d.x - c.x) * (b.y - c.y) - (d.y - c.y) * (b.x - c.x), d3 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x), d4 = (b.x - a.x) * (d.y - a.y) - (b.y - a.y) * (d.x - a.x); return ((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0)); }
  function walls(fl, a, p) { var n = 0; if (!fl) return 0; (fl.areas || []).forEach(function (r) { var pts = r.points || []; for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) if (segX(a, p, pts[j], pts[i])) n++; }); return n; }
  function predict(aps, p, pxPerM, model, fl) { var best = -120; aps.forEach(function (a) { var d = Math.max(1, Math.hypot(a.x - p.x, a.y - p.y) / pxPerM); var v = model.p0 - 10 * model.n * Math.log10(d) - (a.outdoor ? 6 : 0) - Math.min(WALL_CAP, WALL_DB * walls(fl, a, p)); if (v > best) best = v; }); return best; }
  function calibrate(readings, apsByUid, links, pxPerM, fl) {   // fit p0 from readings whose AP we know (n and wall loss fixed)
    var n = 3.3, xs = [];
    readings.forEach(function (w) { var uid = links[(w.bssid || '').toUpperCase()]; var a = uid && apsByUid[uid]; if (!a || w.signal == null || w.wx == null) return; var d = Math.max(1, Math.hypot(a.x - w.wx, a.y - w.wy) / pxPerM); xs.push(w.signal + 10 * n * Math.log10(d) + Math.min(WALL_CAP, WALL_DB * walls(fl, a, { x: w.wx, y: w.wy }))); });
    if (xs.length < 2) return { p0: -38, n: n, from: 0 };
    xs.sort(function (a, b) { return a - b; }); var med = xs[Math.floor(xs.length / 2)];
    return { p0: Math.max(-55, Math.min(-25, med)), n: n, from: xs.length };
  }
  function idw(readings, p, maxD) { var num = 0, den = 0, near = Infinity; for (var i = 0; i < readings.length; i++) { var w = readings[i]; var d = Math.hypot(w.wx - p.x, w.wy - p.y); if (d < near) near = d; if (d < 1e-6) return w.signal; var k = 1 / (d * d); num += k * w.signal; den += k; } return near > maxD || !den ? null : num / den; }
  // BSSIDs are the AP's MAC with the last byte (and often the local bit of the first) changed: match on bytes 2-5
  function macNear(bssid, mac) { var a = String(bssid || '').toUpperCase().split(':'), b = String(mac || '').toUpperCase().split(':'); if (a.length !== 6 || b.length !== 6) return false; for (var i = 1; i < 5; i++) if (a[i] !== b[i]) return false; return Math.abs(parseInt(a[5], 16) - parseInt(b[5], 16)) <= 16; }
  // the Takeoffs symbol for a proposed AP (cloned from one already on the project so the block / service fields match)
  function newSymbol(p, fl, template, existing) {
    var ss = JSON.parse(JSON.stringify(template || FALLBACK[p.code] || FALLBACK['WAP-CEIL']));
    var room = roomAt(fl, p); var roomCode = room ? String(room.code || room.name || 'RM').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4) : 'EXT';
    var short = (ss.autoId && ss.autoId.short) || (/^AP/.test(p.code) || /OUT/.test(p.code) ? 'AP' : 'WAP');
    var n = 1 + existing.filter(function (s) { var a = s.sonorSymbol && s.sonorSymbol.autoId; return a && a.short === short && a.roomCode === roomCode; }).length;
    var id = [roomCode, short, String(n).padStart(2, '0')].join('-');
    ss.uid = p.uid; ss.code = p.code; ss.room = room ? room.name : undefined; ss.labelText = id; ss.suffix = String(n).padStart(2, '0');
    ss.autoId = { n: n, id: id, short: short, roomCode: roomCode, roomName: room ? room.name : '', floorCode: fl.code || '' };
    ss.source = { at: new Date().toISOString().slice(0, 10), by: 'network-scanner', note: 'Wi-Fi survey' + (p.by ? ' by ' + p.by : '') + ', approved in office review' };
    return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100, angle: 0, scaleX: 1, scaleY: 1, sonorSymbol: ss };
  }
  var BASE = { nn: '09', kind: 'symbol', angle: 0, glyph: 'WAP', colour: '#b7b1a7', scaleX: 0.5, scaleY: 0.5, service: 'network', svcName: 'Network', service_nn: '09' };
  var FALLBACK = {
    'WAP-CEIL': Object.assign({}, BASE, { code: 'WAP-CEIL', label: 'Ceiling-mount access point', shape: 'circle', sub_name: 'WAP Internal', block_code: 'CL-SON-09-WAP-CEIL', sort_order: 10, service_sub: '1', autoId: { short: 'WAP' } }),
    'WAP-WALL': Object.assign({}, BASE, { code: 'WAP-WALL', label: 'Wall-mount access point', shape: 'circle', sub_name: 'WAP Internal', block_code: 'CL-SON-09-WAP-WALL', sort_order: 10, service_sub: '1', autoId: { short: 'WAP' } }),
    'AP-OUT': Object.assign({}, BASE, { code: 'AP-OUT', label: 'Outdoor access point', shape: 'square', sub_name: 'WAP External', block_code: 'CL-SON-09-AP-OUT', sort_order: 20, service_sub: '2', autoId: { short: 'AP' } }),
  };
  // apply accepted proposals to one floor's Takeoffs content (pure) → { content, done[], skipped[] }
  function applyToContent(content, fl, props, templates) {
    var c = JSON.parse(JSON.stringify(content || {})); c.symbols = Array.isArray(c.symbols) ? c.symbols : []; var done = [], skipped = [];
    props.forEach(function (p) {
      var i = c.symbols.findIndex(function (s) { return s.sonorSymbol && s.sonorSymbol.uid === p.uid; });
      if (p.op === 'add') { if (i >= 0) { skipped.push([p, 'already there']); return; } c.symbols.push(newSymbol(p, fl, templates[p.code], c.symbols)); done.push(p); }
      else if (i < 0) skipped.push([p, 'no longer on the plan']);
      else if (p.op === 'remove') { c.symbols.splice(i, 1); done.push(p); }
      else if (p.op === 'move') { c.symbols[i].x = Math.round(p.x * 100) / 100; c.symbols[i].y = Math.round(p.y * 100) / 100; done.push(p); }
    });
    return { content: c, done: done, skipped: skipped };
  }

  // ── data ────────────────────────────────────────────────
  var floor = function () { return S.floors.find(function (f) { return f.floorId === S.floorId; }) || S.floors[0] || null; };
  var pxPerM = function (fl) { return (fl && fl.scalePxPerM) || (S.upload && S.upload.scale) || null; };
  var readings = function () { var fl = floor(); return C.getWalk().filter(function (w) { return w.wx != null && fl && (w.floorId || null) === (fl.floorId || null) && w.signal != null; }); };
  function apsNow(fl) {   // the APs as they would be with the proposals: existing (moved / removed) + added
    var props = S.proposals.filter(function (p) { return p.floorId === fl.floorId; });
    var list = (fl.aps || []).map(function (a) { var mv = props.find(function (p) { return p.op === 'move' && p.uid === a.uid; }); var rm = props.some(function (p) { return p.op === 'remove' && p.uid === a.uid; });
      return Object.assign({}, a, mv ? { x: mv.x, y: mv.y, moved: { x: a.x, y: a.y } } : {}, rm ? { removed: true } : {}); });
    props.filter(function (p) { return p.op === 'add'; }).forEach(function (p) { list.push({ uid: p.uid, x: p.x, y: p.y, code: p.code, id: 'New ' + (AP_MODELS.find(function (m) { return m[0] === p.code; }) || [0, 'AP'])[1], label: 'Proposed', outdoor: /OUT/.test(p.code), added: true }); });
    return list;
  }
  function nmLinks() {   // Network Map devices that are Takeoffs APs (takeoffUid + MAC) → BSSID guesses
    var plan = C.getPlan(); var out = []; if (!plan || plan.projectId !== S.projectId) return out;
    (plan.devices || []).forEach(function (d) { if (d.takeoffUid && d._mac && (d.takeoffRole === 'wifi-ap' || /access point|wap/i.test(d.device || ''))) out.push({ uid: d.takeoffUid, mac: d._mac }); });
    return out;
  }
  function apForBssid(bssid) {
    var b = String(bssid || '').toUpperCase(); if (!b) return null;
    if (S.links[b]) return { uid: S.links[b], how: 'linked on site' };
    var hit = nmLinks().find(function (l) { return macNear(b, l.mac); }); return hit ? { uid: hit.uid, how: 'from the Network Map MAC' } : null;
  }
  function allLinks() { var o = Object.assign({}, S.links); C.getWalk().forEach(function (w) { var b = (w.bssid || '').toUpperCase(); if (b && !o[b]) { var a = apForBssid(b); if (a) o[b] = a.uid; } }); return o; }

  // ── loading plans ───────────────────────────────────────
  var supa = {   // the tiny supabase-js shape sonor-plan-image.js needs, over the page's REST + storage (same sign-in as the page)
    from: function (t) { var q = { f: [], sel: '*', ord: '', select: function (s) { q.sel = s; return q; }, eq: function (k, v) { q.f.push(k + '=eq.' + encodeURIComponent(v)); return q; }, order: function (k, o) { q.ord = '&order=' + k + '.' + (o && o.ascending === false ? 'desc' : 'asc'); return q; },
      then: function (res, rej) { return C.rest('/' + t + '?select=' + q.sel + (q.f.length ? '&' + q.f.join('&') : '') + q.ord).then(function (data) { return { data: data, error: null }; }, function (error) { return { data: null, error: error }; }).then(res, rej); } }; return q; },
    storage: { from: function (b) { return { createSignedUrl: async function (path, exp) {
      try { var r = await fetch(C.sbUrl + '/storage/v1/object/sign/' + b + '/' + path.split('/').map(encodeURIComponent).join('/'), { method: 'POST', headers: Object.assign({}, await C.sbHeaders(), { 'Content-Type': 'application/json' }), body: JSON.stringify({ expiresIn: exp }) });
        var j = await r.json(); if (!r.ok) return { error: { message: j.message || j.error || r.statusText } }; return { data: { signedUrl: C.sbUrl + '/storage/v1' + (j.signedURL || j.signedUrl) } }; } catch (e) { return { error: { message: e.message } }; } } }; } },
  };
  var idb = (function () {   // plan images cached on the tablet, so a plan loaded in the office still shows on a site with no internet
    var dbp = null; function db() { if (!dbp) dbp = new Promise(function (res, rej) { var r = indexedDB.open('netscan-plans', 1); r.onupgradeneeded = function () { r.result.createObjectStore('b'); }; r.onsuccess = function () { res(r.result); }; r.onerror = function () { rej(r.error); }; }); return dbp; }
    function tx(mode, fn) { return db().then(function (d) { return new Promise(function (res, rej) { var t = d.transaction('b', mode); var q = fn(t.objectStore('b')); t.oncomplete = function () { res(q && q.result); }; t.onerror = function () { rej(t.error); }; }); }); }
    return { get: function (k) { return tx('readonly', function (s) { return s.get(k); }); }, set: function (k, v) { return tx('readwrite', function (s) { return s.put(v, k); }); } };
  })();
  async function ensurePdfJs() {
    if (root.pdfjsLib) return; await C.loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
    root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
  async function listProjects() {
    var rows = await C.rest('/takeoffs_floors?select=project_id&deleted_at=is.null&limit=5000'); var ids = Array.from(new Set(rows.map(function (r) { return r.project_id; })));
    if (!ids.length) return [];
    var ps = await C.rest('/projects?select=id,name,ref&id=in.(' + ids.join(',') + ')');
    return ps.map(function (p) { return { id: p.id, name: [p.ref, p.name].filter(Boolean).join(' · ') || p.id }; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  async function loadTakeoffs(pid, name) {
    var rows = await C.rest('/takeoffs_floors?project_id=eq.' + pid + '&deleted_at=is.null&select=floor_id,code,name,seq,version,content&order=seq.asc');
    if (!rows.length) throw new Error('This project has no Takeoffs floors yet. Use “Own plan” to survey, the office adds the plan in Takeoffs.');
    var templates = {};
    S = Object.assign(blank(), { source: 'takeoffs', projectId: pid, projectName: name || '', links: S.projectId === pid ? S.links : {}, proposals: S.projectId === pid ? S.proposals : [],
      floors: rows.map(function (r) { var c = r.content || {}; (c.symbols || []).filter(isAp).forEach(function (s) { templates[s.sonorSymbol.code] = templates[s.sonorSymbol.code] || s.sonorSymbol; });
        return { floorId: r.floor_id, code: r.code, name: r.name, version: r.version, scalePxPerM: c.scalePxPerM || null, areas: (c.areas || []).map(function (a) { return { name: a.name, code: a.code, points: a.points, sqm: a.sqm }; }),
          outline: (c.buildingOutline || []).map(function (o) { return { points: o.points }; }), aps: apsFrom(c) }; }) });
    S.templates = templates; S.floorId = (S.floors.find(function (f) { return f.aps.length; }) || S.floors[0]).floorId;
    save(); await loadImage(); return S;
  }
  async function loadImage() {
    var fl = floor(); view.img = null; view.imgFor = null; if (!fl) return;
    if (S.source === 'upload' && S.upload && S.upload.img) { view.img = await imageFrom(S.upload.img); }
    else if (S.source === 'upload') { var url = await idb.get('upload:' + S.projectId).catch(function () { return null; }); if (url) { S.upload.img = url; view.img = await imageFrom(url); } }
    else if (S.source === 'takeoffs' && S.projectId && S.projectId !== 'demo' && root.SonorPlanImage) {
      try {
        var plan = await root.SonorPlanImage.activePlan(supa, S.projectId, fl.floorId);
        if (plan) { if (/pdf/i.test(plan.mime_type || '') || /\.pdf$/i.test(plan.filename || '')) await ensurePdfJs().catch(function () { });
          var r = await root.SonorPlanImage.loadImage(supa, plan, { blobGet: idb.get, blobSet: idb.set }); view.img = r.image; fl.planName = plan.revision_label || plan.filename || ''; }
      } catch (e) { C.toast('Plan image: ' + e.message + ' (rooms and APs still show)', true); }
    }
    view.imgFor = fl.floorId;
    if (view.img) { var k = Math.min(SPACE.w / view.img.width, SPACE.h / view.img.height); fl.rect = { x: 0, y: 0, w: view.img.width * k, h: view.img.height * k }; }
    else if (!fl.rect && !(fl.areas || []).length) fl.rect = { x: 0, y: 0, w: SPACE.w, h: SPACE.h };
    draw();
  }
  function imageFrom(src) { return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = rej; i.src = src; }); }
  async function useUpload(file) {
    var url;
    if (/pdf/i.test(file.type) || /\.pdf$/i.test(file.name)) { await ensurePdfJs(); var blob = await root.SonorPlanImage.renderPdf(await file.arrayBuffer(), 1); url = await shrink(blob); }
    else url = await shrink(file);
    var pid = S.projectId || C.currentProject() || null;
    S = Object.assign(blank(), { source: 'upload', projectId: pid, projectName: S.projectName, floors: [{ floorId: null, code: '', name: file.name.replace(/\.[^.]+$/, ''), areas: [], outline: [], aps: [] }], upload: { img: url, scale: null, name: file.name } });
    S.floorId = null; idb.set('upload:' + pid, url).catch(function () { }); save(); await loadImage();
    C.toast('Plan added. Tap Set scale and tap both ends of a wall you know the length of, so coverage can be predicted.');
  }
  function useBlank() { S = Object.assign(blank(), { source: 'blank', projectId: S.projectId || C.currentProject() || null, projectName: S.projectName, floors: [{ floorId: null, code: '', name: 'Grid', areas: [], outline: [], aps: [], scalePxPerM: 40 }] }); save(); loadImage(); }
  function shrink(blob) { return new Promise(function (res, rej) { var i = new Image(); i.onload = function () { var k = Math.min(1, 2000 / Math.max(i.width, i.height)); var c = document.createElement('canvas'); c.width = Math.round(i.width * k); c.height = Math.round(i.height * k); c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', 0.78)); }; i.onerror = rej; i.src = URL.createObjectURL(blob); }); }

  // ── drawing ─────────────────────────────────────────────
  function bounds(fl) {
    var xs = [], ys = []; var add = function (p) { xs.push(p.x); ys.push(p.y); };
    if (fl.rect) { add(fl.rect); add({ x: fl.rect.x + fl.rect.w, y: fl.rect.y + fl.rect.h }); }
    (fl.areas || []).forEach(function (a) { (a.points || []).forEach(add); }); (fl.outline || []).forEach(function (o) { (o.points || []).forEach(add); });
    apsNow(fl).forEach(add); readings().forEach(function (w) { add({ x: w.wx, y: w.wy }); });
    if (!xs.length) return { x: 0, y: 0, w: SPACE.w, h: SPACE.h };
    var x0 = Math.min.apply(null, xs), y0 = Math.min.apply(null, ys), x1 = Math.max.apply(null, xs), y1 = Math.max.apply(null, ys); var pad = Math.max(20, (x1 - x0) * 0.04);
    return { x: x0 - pad, y: y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  }
  function draw() {
    if (!cv) return; var fl = floor(); var wrap = cv.parentElement; var W = wrap.clientWidth || 600;
    var empty = !fl; C.$('#wmEmpty').hidden = !empty; cv.hidden = empty; renderSide(); if (empty) return;
    var b = bounds(fl); var H = Math.min(Math.round(W * b.h / b.w), Math.round(root.innerHeight * 0.72)); var s = Math.min(W / b.w, H / b.h);
    var dpr = root.devicePixelRatio || 1; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.height = H + 'px';
    view.t = { s: s, ox: (W - b.w * s) / 2 - b.x * s, oy: (H - b.h * s) / 2 - b.y * s };
    var g = ctx2; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    var X = function (x) { return view.t.ox + x * s; }, Y = function (y) { return view.t.oy + y * s; };
    g.fillStyle = view.img ? '#ffffff' : '#1a1a1c'; g.fillRect(0, 0, W, H);
    if (view.img && fl.rect) { g.globalAlpha = 0.9; g.drawImage(view.img, X(fl.rect.x), Y(fl.rect.y), fl.rect.w * s, fl.rect.h * s); g.globalAlpha = 1; }
    if (!view.img) { var ppm = pxPerM(fl); if (ppm) { g.strokeStyle = 'rgba(255,255,255,.05)'; g.lineWidth = 1; for (var gx = Math.floor(b.x / ppm) * ppm; gx < b.x + b.w; gx += ppm) { g.beginPath(); g.moveTo(X(gx), 0); g.lineTo(X(gx), H); g.stroke(); } for (var gy = Math.floor(b.y / ppm) * ppm; gy < b.y + b.h; gy += ppm) { g.beginPath(); g.moveTo(0, Y(gy)); g.lineTo(W, Y(gy)); g.stroke(); } } }
    heat(g, fl, W, H, X, Y, s);
    var ink = view.img ? 'rgba(20,20,24,.75)' : 'rgba(245,245,247,.55)';
    (fl.outline || []).forEach(function (o) { path(g, o.points, X, Y); g.strokeStyle = ink; g.lineWidth = 2; g.stroke(); });
    var fs = Math.max(10, Math.min(13, s * 12));
    (fl.areas || []).forEach(function (a) { if (!a.points || a.points.length < 3) return; path(g, a.points, X, Y); g.strokeStyle = view.img ? 'rgba(20,20,24,.35)' : 'rgba(245,245,247,.28)'; g.lineWidth = 1; g.stroke();
      var lx = Math.min.apply(null, a.points.map(function (q) { return q.x; })), ly = Math.min.apply(null, a.points.map(function (q) { return q.y; })); g.font = '500 ' + (fs * 0.85) + 'px DM Sans, sans-serif'; g.textAlign = 'left'; g.fillStyle = view.img ? 'rgba(20,20,24,.7)' : 'rgba(245,245,247,.55)'; g.fillText(a.name || a.code || '', X(lx) + 4, Y(ly) + fs); });
    var links = allLinks(); var linkedUids = new Set(Object.keys(links).map(function (k) { return links[k]; }));
    apsNow(fl).forEach(function (a) { drawAp(g, a, X(a.x), Y(a.y), fs, linkedUids.has(a.uid)); if (a.moved) { g.setLineDash([4, 4]); g.strokeStyle = '#4bb9d3'; g.beginPath(); g.moveTo(X(a.moved.x), Y(a.moved.y)); g.lineTo(X(a.x), Y(a.y)); g.stroke(); g.setLineDash([]); } });
    var pred = pxPerM(fl), predAps = apsNow(fl).filter(function (a) { return !a.removed; }), predModel = modelFor(fl); if (!predAps.length) pred = null;
    readings().forEach(function (w) { var x = X(w.wx), y = Y(w.wy); g.fillStyle = C.sigHex(w.signal); g.strokeStyle = '#000'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 6, 0, 7); g.fill(); g.stroke(); var dl = ''; if (view.heat === 'compare' && pred) { var dv = Math.round(w.signal - predict(predAps, { x: w.wx, y: w.wy }, pred, predModel, fl)); dl = ' (' + (dv >= 0 ? '+' : '') + dv + ')'; }
      label(g, view.heat === 'speed' && w.downMbps != null ? '↓' + Math.round(w.downMbps) : String(w.signal) + dl + (w.downMbps != null && view.heat !== 'predicted' ? ' · ↓' + Math.round(w.downMbps) : ''), x, y - 10, fs); });
    if (view.pos && view.pos.floorId === fl.floorId) { var px = X(view.pos.x), py = Y(view.pos.y); g.strokeStyle = '#4bb9d3'; g.lineWidth = 3; g.beginPath(); g.arc(px, py, 12, 0, 7); g.stroke(); g.beginPath(); g.arc(px, py, 3, 0, 7); g.fillStyle = '#4bb9d3'; g.fill(); }
    if (view.scaleA) { g.fillStyle = '#e3a72f'; g.beginPath(); g.arc(X(view.scaleA.x), Y(view.scaleA.y), 5, 0, 7); g.fill(); }
    if (view.moving) { var m = apsNow(fl).find(function (a) { return a.uid === view.moving; }); if (m) { g.strokeStyle = '#e3a72f'; g.lineWidth = 3; g.beginPath(); g.arc(X(m.x), Y(m.y), 16, 0, 7); g.stroke(); } }
  }
  function path(g, pts, X, Y) { g.beginPath(); pts.forEach(function (p, i) { if (i) g.lineTo(X(p.x), Y(p.y)); else g.moveTo(X(p.x), Y(p.y)); }); g.closePath(); }
  function label(g, t, x, y, fs) { g.font = '600 ' + fs + 'px DM Sans, sans-serif'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(0,0,0,.75)'; g.strokeText(t, x, y); g.fillStyle = '#fff'; g.fillText(t, x, y); }
  function drawAp(g, a, x, y, fs, linked) {
    var r = 9; g.save(); g.globalAlpha = a.removed ? 0.45 : 1;
    g.fillStyle = a.added ? '#4bb9d3' : '#b7b1a7'; g.strokeStyle = linked ? '#2fbf71' : '#111'; g.lineWidth = linked ? 3 : 1.5;
    if (a.added) g.setLineDash([3, 2]);
    g.beginPath(); if (a.outdoor) g.rect(x - r, y - r, 2 * r, 2 * r); else g.arc(x, y, r, 0, 7); g.fill(); g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#111'; g.lineWidth = 1.4; [4, 7].forEach(function (rr) { g.beginPath(); g.arc(x, y + 2, rr, Math.PI * 1.2, Math.PI * 1.8); g.stroke(); });
    if (a.removed) { g.strokeStyle = '#e5484d'; g.lineWidth = 3; g.beginPath(); g.moveTo(x - r - 2, y - r - 2); g.lineTo(x + r + 2, y + r + 2); g.moveTo(x + r + 2, y - r - 2); g.lineTo(x - r - 2, y + r + 2); g.stroke(); }
    g.restore(); label(g, a.id || 'AP', x, y + r + fs + 2, fs * 0.9);
  }
  // compare (default, Bryn: "predicted heatmap vs actual test … default blank, then realworld becomes live as each tested"):
  // the predicted map is shown faint over the whole floor; around every tested spot (within TESTED_M) the real readings
  // take over at full strength, so the plan turns from prediction into fact one test at a time.
  var TESTED_M = 3;
  function nearest(rs, p) { var d = Infinity; for (var i = 0; i < rs.length; i++) { var x = Math.hypot(rs[i].wx - p.x, rs[i].wy - p.y); if (x < d) d = x; } return d; }
  function heat(g, fl, W, H, X, Y, s) {
    if (view.heat === 'off') return; var cell = 7, ppm = pxPerM(fl), rs = readings(); var mode = view.heat;
    if (mode === 'speed') rs = rs.filter(function (w) { return w.downMbps != null; }).map(function (w) { return { wx: w.wx, wy: w.wy, signal: w.downMbps }; });
    var aps = apsNow(fl).filter(function (a) { return !a.removed; }); var model = modelFor(fl); var canPredict = !!ppm && aps.length > 0;
    if ((mode === 'measured' || mode === 'speed') && !rs.length) return; if (mode === 'predicted' && !canPredict) return; if (mode === 'compare' && !canPredict && !rs.length) return;
    var maxD = ppm ? 6 * ppm : 220, tested = ppm ? TESTED_M * ppm : 110, faint = view.img ? '38' : '30', solid = view.img ? '78' : '70';
    for (var py = 0; py < H; py += cell) for (var px = 0; px < W; px += cell) {
      var p = { x: (px + cell / 2 - view.t.ox) / s, y: (py + cell / 2 - view.t.oy) / s }; if (!inside(fl, p)) continue;
      if (mode === 'compare') {
        if (rs.length && nearest(rs, p) <= tested) { var m = idw(rs, p, tested); if (m != null) { g.fillStyle = C.sigHex(m) + solid; g.fillRect(px, py, cell, cell); continue; } }
        if (canPredict) { g.fillStyle = C.sigHex(predict(aps, p, ppm, model, fl)) + faint; g.fillRect(px, py, cell, cell); }
        continue;
      }
      var v = mode === 'predicted' ? predict(aps, p, ppm, model, fl) : idw(rs, p, maxD); if (v == null) continue;
      g.fillStyle = (mode === 'speed' ? C.mbHex(v) : C.sigHex(v)) + (view.img ? '70' : '60'); g.fillRect(px, py, cell, cell);
    }
  }
  function testedPct(fl) {   // share of the floor within TESTED_M of a reading
    var ppm = pxPerM(fl), rs = readings(); if (!rs.length) return 0; var b = bounds(fl), st = Math.max(b.w, b.h) / 80, n = 0, t = 0, lim = (ppm || 36) * TESTED_M;
    for (var y = b.y; y < b.y + b.h; y += st) for (var x = b.x; x < b.x + b.w; x += st) { var p = { x: x, y: y }; if (!inside(fl, p)) continue; n++; if (nearest(rs, p) <= lim) t++; }
    return n ? Math.round(100 * t / n) : 0;
  }
  function modelFor(fl) { var byUid = {}; (fl.aps || []).forEach(function (a) { byUid[a.uid] = a; }); return calibrate(readings(), byUid, allLinks(), pxPerM(fl) || 40, fl); }

  // ── coverage summary, proposals, review ─────────────────
  function coverage(fl) {
    var ppm = pxPerM(fl); var aps = apsNow(fl).filter(function (a) { return !a.removed; }); var model = modelFor(fl); var rs = readings();
    return (fl.areas || []).filter(function (a) { return a.points && a.points.length > 2; }).map(function (a) {
      var xs = a.points.map(function (p) { return p.x; }), ys = a.points.map(function (p) { return p.y; }); var x0 = Math.min.apply(null, xs), x1 = Math.max.apply(null, xs), y0 = Math.min.apply(null, ys), y1 = Math.max.apply(null, ys);
      var st = Math.max(4, (x1 - x0) / 10), ok = 0, n = 0, worst = 0;
      if (ppm && aps.length) for (var y = y0 + st / 2; y < y1; y += st) for (var x = x0 + st / 2; x < x1; x += st) { var p = { x: x, y: y }; if (!inPoly(p, a.points)) continue; var v = predict(aps, p, ppm, model, fl); n++; if (v >= TARGET) ok++; worst = Math.min(worst, v); }
      var mine = rs.filter(function (w) { return roomAt(fl, { x: w.wx, y: w.wy }) === a; }); var meas = mine.length ? Math.min.apply(null, mine.map(function (w) { return w.signal; })) : null; var sp = mine.filter(function (w) { return w.downMbps != null; });
      return { room: a, pct: n ? Math.round(100 * ok / n) : null, worst: n ? Math.round(worst) : null, measured: meas, readings: mine.length, down: sp.length ? Math.min.apply(null, sp.map(function (w) { return w.downMbps; })) : null, up: sp.length ? Math.min.apply(null, sp.map(function (w) { return w.upMbps; })) : null };
    });
  }
  function word(c) { var v = c.measured != null ? c.measured : c.pct == null ? null : c.pct >= 90 ? 0 : c.pct >= 60 ? -70 : -80; if (v == null && c.down == null) return ['', '—']; var r = v == null ? 0 : v >= TARGET ? 0 : v >= -75 ? 1 : 2; if (c.down != null) r = Math.max(r, c.down >= 25 ? 0 : c.down >= 10 ? 1 : 2); return [['ok', 'Good'], ['warn', 'Patchy'], ['bad', 'Weak']][r]; }   // a room is only Good if its speed test is too (25 Mb/s = a 4K stream)
  function renderSide() {
    var el = C.$('#wmSide'); if (!el) return; var fl = floor(); if (!fl) { el.innerHTML = ''; return; }
    var ppm = pxPerM(fl), cov = coverage(fl), props = S.proposals.filter(function (p) { return p.floorId === fl.floorId; }); var model = modelFor(fl);
    var h = '<div class="small muted" style="margin-bottom:6px">' + (S.source === 'takeoffs' ? 'Takeoffs · ' + C.esc(S.projectName || '') + ' · ' + C.esc(fl.name) + (fl.planName ? ' · plan ' + C.esc(fl.planName) : view.img ? '' : ' · no plan image, rooms only') : S.source === 'upload' ? 'Own plan' + (S.projectName ? ' · ' + C.esc(S.projectName) : '') + (ppm ? '' : ' · <b style="color:var(--warn)">set the scale</b> for predicted coverage') : 'Grid survey (1 square = 1 m)') + '</div>';
    if (view.heat === 'compare') { var tp = testedPct(fl); h += '<div class="small muted" style="margin-bottom:6px">Faint colour is the prediction from the APs on the plan; strong colour is where it has been tested (within ' + TESTED_M + ' m of a reading). <b>' + tp + '% of the floor tested</b>' + (readings().length ? '. Each reading shows how far it is from the prediction, e.g. −61 (−6) is 6 dB worse than predicted.' : ': tap where you stand and press Record to start.') + '</div>'; }
    if (view.heat === 'speed') h += '<div class="small muted" style="margin-bottom:6px">Real-world speed: the download speed tests taken at each spot, spread between them. Green is 100 Mb/s or more, amber under 25 (one 4K stream), red under 10. It is the Wi-Fi and the internet line together, so check the line on its own with Speed test at the top.</div>';
    if (view.heat === 'predicted') h += '<div class="small muted" style="margin-bottom:6px">Prediction: ' + (model.from ? 'calibrated from ' + model.from + ' readings next to known APs' : 'a typical house (walk-test readings next to linked APs calibrate it)') + '. Each wall on the way costs about 5 dB; floors, brick and stone walls are not known, so check with a walk test.</div>';
    if (cov.length) h += '<table class="wmcov"><tr><th>Room</th><th>Predicted</th><th>Measured</th><th>Speed</th><th></th></tr>' + cov.map(function (c) { var w = word(c);
      return '<tr><td>' + C.esc(c.room.name || c.room.code) + '</td><td>' + (c.pct == null ? '<span class="muted">—</span>' : c.pct + '% ≥ ' + TARGET) + '</td><td>' + (c.measured == null ? '<span class="muted">—</span>' : c.measured + ' dBm') + '</td><td>' + (c.down == null ? '<span class="muted">—</span>' : '<span style="color:' + C.mbHex(c.down) + '" title="Slowest speed test in the room, download / upload">↓' + Math.round(c.down) + ' ↑' + Math.round(c.up) + '</span>') + '</td><td>' + (w[0] ? '<span class="pill ' + w[0] + '">' + w[1] + '</span>' : '') + (w[0] && w[0] !== 'ok' && !view.review ? ' <button class="btn-sm" data-wmadd="' + C.esc(c.room.name) + '">+ AP</button>' : '') + '</td></tr>'; }).join('') + '</table>';
    var desc = function (p) { var a = (fl.aps || []).find(function (x) { return x.uid === p.uid; }); var room = roomAt(fl, p); return p.op === 'add' ? 'Add ' + ((AP_MODELS.find(function (m) { return m[0] === p.code; }) || [0, p.code])[1]) + (room ? ' in ' + room.name : '') : p.op === 'move' ? 'Move ' + (a ? a.id : 'AP') + (room ? ' to ' + room.name : '') : 'Remove ' + (a ? a.id : 'AP'); };
    h += '<div class="lbl" style="margin:12px 0 6px">Proposed changes for the office' + (props.length ? ' · ' + props.length : '') + '</div>';
    h += props.length ? props.map(function (p, i) { return '<div class="wrow" style="grid-template-columns:auto 1fr auto">' + (view.review ? '<input type="checkbox" data-wmok="' + i + '" checked>' : '<span></span>') + '<div>' + C.esc(desc(p)) + (p.note ? '<div class="m">' + C.esc(p.note) + '</div>' : '') + (p.by ? '<div class="m">' + C.esc(p.by) + '</div>' : '') + '</div>' + (view.review ? '<span></span>' : '<button class="btn-sm" data-wmdel="' + C.esc(p.uid + p.op) + '">✕</button>') + '</div>'; }).join('') : '<p class="muted small" style="margin:0">None. Use Add AP, Move AP or Remove AP on the plan. Nothing changes in Takeoffs until the office approves it.</p>';
    if (view.review && props.length) h += S.source === 'takeoffs' ? '<div class="row" style="margin-top:8px"><button class="primary" id="wmApply">Apply ticked changes to Takeoffs</button></div><p class="muted small">Writes to this floor in Takeoffs only if nobody has saved it since it was loaded here; the revision note records who surveyed and who approved.</p>'
      : '<p class="muted small" style="margin-top:8px">This survey was done on the engineer’s own plan, so it can’t be applied automatically: draw these APs in Takeoffs when the plan is added, then Mark reviewed.</p>';
    el.innerHTML = h;
    el.querySelectorAll('[data-wmadd]').forEach(function (b) { b.onclick = function () { var a = (fl.areas || []).find(function (x) { return x.name === b.dataset.wmadd; }); if (!a) return; var c = centroid(a.points); propose({ op: 'add', code: C.$('#wmModel').value, x: c.x, y: c.y, note: 'Weak signal in ' + a.name }); }; });
    el.querySelectorAll('[data-wmdel]').forEach(function (b) { b.onclick = function () { S.proposals = S.proposals.filter(function (p) { return p.uid + p.op !== b.dataset.wmdel; }); save(); draw(); }; });
    var ap = C.$('#wmApply'); if (ap) ap.onclick = function () { applyReview(fl, props.filter(function (p, i) { var c = el.querySelector('[data-wmok="' + i + '"]'); return !c || c.checked; })); };
  }
  function propose(p) {
    var fl = floor(); p.floorId = fl.floorId; p.at = new Date().toISOString(); p.uid = p.uid || ('ns' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)); p.by = (C.who && C.who()) || '';
    S.proposals = S.proposals.filter(function (x) { return !(x.uid === p.uid && x.op === p.op); }); S.proposals.push(p); save(); draw();
  }

  // ── taps ────────────────────────────────────────────────
  function worldAt(e) { var r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left - view.t.ox) / view.t.s, y: (e.clientY - r.top - view.t.oy) / view.t.s }; }
  function apNear(p) { var fl = floor(); var best = null; apsNow(fl).forEach(function (a) { var d = Math.hypot(a.x - p.x, a.y - p.y) * view.t.s; if (d < 22 && (!best || d < best.d)) best = { a: a, d: d }; }); return best && best.a; }
  function onTap(e) {
    var fl = floor(); if (!fl || !view.t) return; var p = worldAt(e); var tool = view.tool; var hit = apNear(p);
    if (view.review) { if (hit) C.toast(hit.id + (hit.added ? ' (proposed)' : '')); return; }
    if (tool === 'stand') { var room = roomAt(fl, p); view.pos = { floorId: fl.floorId, x: p.x, y: p.y, room: room ? room.name : '' }; if (room && !C.$('#walkRoom').value.trim()) C.$('#walkRoom').placeholder = room.name + ' (from the plan)'; C.$('#wmTip').textContent = (room ? room.name + ': ' : '') + 'press Record'; draw(); return; }
    if (tool === 'add') { var r2 = roomAt(fl, p); propose({ op: 'add', code: C.$('#wmModel').value, x: p.x, y: p.y, note: r2 ? '' : 'Outside the rooms on the plan' }); return; }
    if (tool === 'remove') { if (!hit) return C.toast('Tap an AP to remove it', true); if (hit.added) { S.proposals = S.proposals.filter(function (x) { return x.uid !== hit.uid; }); save(); draw(); return; }
      if (S.proposals.some(function (x) { return x.uid === hit.uid && x.op === 'remove'; })) { S.proposals = S.proposals.filter(function (x) { return !(x.uid === hit.uid && x.op === 'remove'); }); save(); draw(); return; }
      var why = prompt('Why remove ' + hit.id + '? (for the office)', ''); if (why === null) return; propose({ op: 'remove', uid: hit.uid, x: hit.x, y: hit.y, note: why }); return; }
    if (tool === 'move') { if (!view.moving) { if (!hit) return C.toast('Tap the AP to move first', true); view.moving = hit.uid; C.$('#wmTip').textContent = 'Now tap where ' + hit.id + ' should go'; draw(); return; }
      var m = apsNow(fl).find(function (a) { return a.uid === view.moving; }); view.moving = null; C.$('#wmTip').textContent = '';
      if (m && m.added) { var pp = S.proposals.find(function (x) { return x.uid === m.uid && x.op === 'add'; }); pp.x = p.x; pp.y = p.y; save(); draw(); } else if (m) propose({ op: 'move', uid: m.uid, x: p.x, y: p.y, note: '' }); return; }
    if (tool === 'link') { if (!hit || hit.added) return C.toast('Tap one of the plan’s APs', true); linkAp(hit); return; }
    if (tool === 'scale') { if (!view.scaleA) { view.scaleA = p; C.$('#wmTip').textContent = 'Now tap the other end'; draw(); return; }
      var px = Math.hypot(p.x - view.scaleA.x, p.y - view.scaleA.y); view.scaleA = null; C.$('#wmTip').textContent = ''; var m2 = parseFloat(prompt('How many metres between the two points?', '') || ''); if (!(m2 > 0)) return draw();
      if (S.source === 'upload') { S.upload.scale = px / m2; } else fl.scalePxPerM = px / m2; save(); C.toast('Scale set: ' + (px / m2).toFixed(1) + ' per metre'); draw(); }
  }
  async function linkAp(a) {
    try { var r = await C.api('wifiLink'); var l = r && r.link; if (!l || !l.bssid) throw new Error('Not on Wi-Fi'); var b = l.bssid.toUpperCase();
      if (!confirm('Stand under ' + a.id + ': this tablet is on ' + b + ' (' + (l.signal != null ? l.signal + ' dBm' : '') + '). Link that radio to ' + a.id + '?')) return;
      S.links[b] = a.uid; save(); draw(); C.toast(a.id + ' linked to ' + b);
    } catch (e) { C.toast(e.message, true); }
  }

  // ── office: apply to Takeoffs (only from a review, only with approval) ──
  async function applyReview(fl, props) {
    if (!props.length) return C.toast('Tick at least one change', true);
    if (!confirm('Apply ' + props.length + ' change' + (props.length > 1 ? 's' : '') + ' to ' + fl.name + ' in Takeoffs?')) return;
    try {
      var rows = await C.rest('/takeoffs_floors?project_id=eq.' + S.projectId + '&floor_id=eq.' + encodeURIComponent(fl.floorId) + '&select=content,version,code');
      var row = rows[0]; if (!row) throw new Error('That floor is no longer in Takeoffs');
      var res = applyToContent(row.content, Object.assign({}, fl, { code: row.code }), props, S.templates || {});
      if (!res.done.length) throw new Error('Nothing to apply: ' + res.skipped.map(function (x) { return x[1]; }).join(', '));
      var upd = await C.rest('/takeoffs_floors?project_id=eq.' + S.projectId + '&floor_id=eq.' + encodeURIComponent(fl.floorId) + '&version=eq.' + row.version, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ content: res.content, version: row.version + 1 }) });
      if (!upd || !upd.length) throw new Error('Takeoffs saved this floor a moment ago: reload the review and apply again');
      var summary = 'Wi-Fi plan applied to Takeoffs ' + fl.name + ': ' + res.done.map(function (p) { return p.op; }).reduce(function (o, k) { o[k] = (o[k] || 0) + 1; return o; }, {});
      summary = 'Wi-Fi plan applied to Takeoffs ' + fl.name + ': ' + ['add', 'move', 'remove'].map(function (k) { var n = res.done.filter(function (p) { return p.op === k; }).length; return n ? n + ' ' + { add: 'added', move: 'moved', remove: 'removed' }[k] : ''; }).filter(Boolean).join(', ') + (res.skipped.length ? ' (' + res.skipped.length + ' skipped: ' + res.skipped.map(function (x) { return x[1]; }).join(', ') + ')' : '') + '.';
      fl.version = row.version + 1; C.toast('Takeoffs updated. Network Map picks the new APs up on its next Takeoffs sync.');
      await C.markReviewed(summary, { wifiPlan: { floorId: fl.floorId, takeoffsVersion: row.version + 1, applied: res.done, skipped: res.skipped.map(function (x) { return Object.assign({}, x[0], { reason: x[1] }); }) } });
    } catch (e) { C.toast(e.message, true); }
  }
  async function openReview(r) {   // office opens an uploaded scan: its plan, readings and proposals, read-only except Apply
    var wp = r.netinfo && r.netinfo.wifiPlan; if (!wp) return false;
    var keep = S; view.review = { id: r.id };
    try {
      if (wp.source === 'takeoffs' && r.project_id) { S = blank(); await loadTakeoffs(r.project_id, wp.projectName || ''); }
      else { S = Object.assign(blank(), { source: wp.source, projectId: r.project_id, floors: [{ floorId: null, code: '', name: 'Own plan', areas: [], outline: [], aps: [] }], upload: wp.upload || null }); await loadImage(); }
      S.proposals = wp.proposals || []; S.links = wp.links || {}; S.floorId = wp.floorId || S.floorId; await loadImage(); fillFloors();
      C.$('#wmBanner').hidden = false; C.$('#wmBanner').innerHTML = '<b>Reviewing</b> the Wi-Fi survey from this upload. <button class="btn-sm" id="wmEndReview">Close review</button>';
      C.$('#wmEndReview').onclick = function () { view.review = null; S = keep; C.$('#wmBanner').hidden = true; loadImage(); fillFloors(); };
      return true;
    } catch (e) { view.review = null; S = keep; C.toast(e.message, true); return false; }
  }
  function exportPlan() {
    if (!S.source) return null;
    return { source: S.source, projectId: S.projectId, projectName: S.projectName, floorId: S.floorId, floors: S.floors.map(function (f) { return { floorId: f.floorId, code: f.code, name: f.name, version: f.version }; }),
      proposals: S.proposals, links: allLinks(), upload: S.source === 'upload' && S.upload ? { scale: S.upload.scale, img: S.upload.img } : null };
  }

  // ── UI wiring ───────────────────────────────────────────
  function fillFloors() {
    var sel = C.$('#wmFloor'); sel.innerHTML = S.floors.map(function (f) { return '<option value="' + C.esc(f.floorId || '') + '">' + C.esc(f.name) + (f.aps && f.aps.length ? ' · ' + f.aps.length + ' AP' + (f.aps.length > 1 ? 's' : '') : '') + '</option>'; }).join('');
    sel.value = S.floorId || ''; sel.hidden = S.floors.length < 2;
  }
  async function fillProjects() {
    var sel = C.$('#wmProj');
    if (C.mode() === 'demo') { sel.innerHTML = '<option value="demo">Sonor Demo House (Takeoffs)</option>'; return; }
    try { var ps = await listProjects(); sel.innerHTML = '<option value="">Project with a Takeoffs plan…</option>' + ps.map(function (p) { return '<option value="' + C.esc(p.id) + '">' + C.esc(p.name) + '</option>'; }).join('');
      var want = S.projectId || C.currentProject(); if (want && ps.some(function (p) { return p.id === want; })) sel.value = want; C.$('#wmState').textContent = '';
    } catch (e) { sel.innerHTML = '<option value="">Projects need a Sonor sign-in</option>'; }
  }
  async function loadDemo() {
    var d = await (await fetch('data/demo-floors.json')).json();
    S = Object.assign(blank(), { source: 'takeoffs', projectId: 'demo', projectName: d.name, floors: d.floors, floorId: d.floors[0].floorId, templates: {} }); save();
    // starts blank: the prediction shows straight away and each spot the engineer stands on and tests fills in live.
    // (older versions pre-loaded demo readings sitting on the APs; drop those)
    var old = {}; (d.readings || []).forEach(function (r) { old[r.at] = 1; }); var w0 = C.getWalk(); var w1 = w0.filter(function (w) { return !old[w.at]; }); if (w1.length !== w0.length) C.setWalk(w1);
    fillFloors(); await loadImage();
  }
  function setTool(t) { view.tool = t; view.moving = null; view.scaleA = null; C.$('#wmTools').querySelectorAll('button').forEach(function (b) { b.classList.toggle('on', b.dataset.tool === t); }); C.$('#wmTip').textContent = { stand: 'Tap where you are standing, then Record', add: 'Tap where a new AP should go', move: 'Tap an AP, then where it should go', remove: 'Tap an AP to propose removing it', link: 'Stand under an AP and tap it to link the radio you are on', scale: 'Tap both ends of something you know the length of' }[t] || ''; draw(); }
  function init(ctx) {
    C = ctx; cv = C.$('#wmCv'); ctx2 = cv.getContext('2d');
    cv.addEventListener('click', onTap);
    C.$('#wmTools').querySelectorAll('button').forEach(function (b) { b.onclick = function () { setTool(b.dataset.tool); }; });
    C.$('#wmHeat').querySelectorAll('button').forEach(function (b) { b.onclick = function () { view.heat = b.dataset.heat; C.$('#wmHeat').querySelectorAll('button').forEach(function (x) { x.classList.toggle('on', x === b); }); draw(); }; });
    C.$('#wmModel').innerHTML = AP_MODELS.map(function (m) { return '<option value="' + m[0] + '">' + m[1] + '</option>'; }).join('');
    C.$('#wmLoad').onclick = async function () { var pid = C.$('#wmProj').value; if (!pid) return C.toast('Pick a project', true); if (pid === 'demo') return loadDemo();
      C.$('#wmState').textContent = 'Loading…'; try { await loadTakeoffs(pid, C.$('#wmProj').selectedOptions[0].textContent); fillFloors(); C.$('#wmState').textContent = ''; } catch (e) { C.$('#wmState').textContent = e.message; } };
    C.$('#wmFloor').onchange = function (e) { S.floorId = e.target.value || null; view.pos = null; save(); loadImage(); };
    C.$('#wmFile').onchange = function (e) { var f = e.target.files[0]; if (f) useUpload(f).catch(function (err) { C.toast(err.message, true); }); e.target.value = ''; };
    C.$('#wmBlank').onclick = useBlank;
    root.addEventListener('resize', function () { clearTimeout(view.rz); view.rz = setTimeout(draw, 150); });
    setTool('stand'); fillFloors();
    if (C.mode() === 'demo') { fillProjects(); loadDemo(); } else { if (S.source) loadImage(); }
  }
  var api = {
    init: init, draw: draw, exportPlan: exportPlan, openReview: openReview, fillProjects: fillProjects,
    simAt: function (p) { var fl = floor(); if (!fl || !p) return null; var ppm = pxPerM(fl) || 40, m = modelFor(fl), best = null; apsNow(fl).filter(function (a) { return !a.removed; }).forEach(function (a) { var v = predict([a], p, ppm, m, fl); if (!best || v > best.v) best = { v: v, ap: a.id }; }); if (!best) return null; return { signal: Math.round(best.v + (Math.random() * 8 - 5)), ap: best.ap }; },
    pos: function () { return view.pos; }, clearPos: function () { view.pos = null; C.$('#wmTip').textContent = ''; draw(); },
    roomFor: function (p) { var fl = floor(); var r = fl && roomAt(fl, p); return r ? r.name : ''; },
    apFor: function (bssid) { var a = apForBssid(bssid); if (!a) return null; var fl = floor(); var ap = fl && (fl.aps || []).find(function (x) { return x.uid === a.uid; }); return ap ? { id: ap.id, how: a.how } : null; },
    hasPlan: function () { return !!floor(); }, state: function () { return S; },
    _t: { inPoly: inPoly, roomAt: roomAt, inside: inside, apsFrom: apsFrom, predict: predict, calibrate: calibrate, walls: walls, idw: idw, macNear: macNear, newSymbol: newSymbol, applyToContent: applyToContent, isAp: isAp },
  };
  root.WifiMap = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
