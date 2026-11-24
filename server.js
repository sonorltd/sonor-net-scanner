#!/usr/bin/env node
'use strict';
// Sonor Network Scanner agent. Runs on the site Pi (or a laptop) and does what a browser can't:
// sweeps the LAN, reads MACs, listens for mDNS / SSDP / Control4 SDDP / Ubiquiti / ONVIF, probes ports
// and asks devices for model + firmware. Serves the scanner page at http://<this-ip>:8050.
// Run: node server.js
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('./lib/net');
const { scan } = require('./lib/scan');
const tools = require('./lib/tools');
const { netinfo, speedtest } = require('./lib/netinfo');
const wifi = require('./lib/wifi');

const VERSION = '1.6.9';
const PORT = Number(process.env.PORT || 8050);
const DATA = process.env.NETSCAN_DATA || path.join(__dirname, 'scans');
const PUBLIC = path.join(__dirname, 'public');
const KEEP = 40; // saved scans kept on the agent
fs.mkdirSync(DATA, { recursive: true });

const NOTES = path.join(DATA, 'notes.json'); // engineer's names/notes per MAC (or IP when no MAC)
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
let notes = readJson(NOTES, {});

let state = { running: false, progress: null, error: null, lastId: null };
let latest = null;
let lastInfo = null; let speed = null;

function listScans() {
  return fs.readdirSync(DATA).filter((f) => /^scan-.*\.json$/.test(f)).sort().reverse().map((f) => {
    const s = readJson(path.join(DATA, f), null);
    return s && { id: s.id, startedAt: s.startedAt, seconds: s.seconds, targets: s.targets, count: s.devices.length, label: s.label || '' };
  }).filter(Boolean);
}
function loadScan(id) {
  const f = path.join(DATA, `scan-${String(id).replace(/[^\w-]/g, '')}.json`);
  return readJson(f, null);
}
function saveScan(s) {
  fs.writeFileSync(path.join(DATA, `scan-${s.id}.json`), JSON.stringify(s));
  const all = fs.readdirSync(DATA).filter((f) => /^scan-.*\.json$/.test(f)).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP))) try { fs.unlinkSync(path.join(DATA, f)); } catch {}
}
latest = (() => { const l = listScans()[0]; return l ? loadScan(l.id) : null; })();
if (latest) state.lastId = latest.id;

const W = require('./public/data/sonor-wireless.js');
let nodeCache = null;
async function probeGet(kind, ip, args) {
  if (!net.isIp(ip || '')) return [400, { error: 'pick the probe or enter its IPv4 address' }];
  const { path, timeout } = W.probePath(kind, args);
  const r = await new Promise((resolve, reject) => { const q = require('http').get(`http://${ip}/${path}`, { timeout }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error(`Not a ${W.PROBES[kind].kind} at ${ip}`)); } }); }); q.on('timeout', () => q.destroy(new Error('The probe did not answer'))); q.on('error', reject); });
  return [200, r];
}

const actions = {
  state: async () => [200, { version: VERSION, hostname: os.hostname(), interfaces: net.localSubnets(), scan: state, latest: latest && { id: latest.id, startedAt: latest.startedAt, count: latest.devices.length } }],

  scan: async ({ targets, ping, label } = {}) => {
    if (state.running) return [409, { error: 'A scan is already running' }];
    const list = (Array.isArray(targets) ? targets : String(targets || '').split(/[\s,]+/)).map((t) => String(t).trim()).filter(Boolean);
    const bad = list.filter((t) => !net.expandTarget(t).length);
    if (bad.length) return [400, { error: `Not a subnet or range: ${bad.join(', ')}. Use 192.168.1.0/24, 192.168.1 or 10.0.0.10-10.0.0.60.` }];
    state = { running: true, progress: { phase: 'starting', done: 0, total: 0 }, error: null, lastId: state.lastId };
    const infoP = netinfo().catch(() => null);
    scan({ targets: list, ping, onProgress: (p) => { state.progress = p; } })
      .then(async (s) => { s.netinfo = await infoP; lastInfo = s.netinfo || lastInfo; s.label = String(label || '').slice(0, 80); saveScan(s); latest = s; state = { running: false, progress: null, error: null, lastId: s.id }; })
      .catch((e) => { state = { running: false, progress: null, error: e.message, lastId: state.lastId }; });
    return [202, { started: true }];
  },

  results: async ({ id } = {}) => {
    const s = id ? loadScan(id) : latest;
    if (!s) return [404, { error: 'No scan yet' }];
    return [200, { ...s, notes }];
  },

  scans: async () => [200, { scans: listScans() }],

  note: async ({ key, name, note } = {}) => {
    if (!key) return [400, { error: 'key needed' }];
    const k = String(key).toUpperCase().slice(0, 40);
    notes[k] = { name: String(name || '').slice(0, 60), note: String(note || '').slice(0, 300), at: new Date().toISOString() };
    if (!notes[k].name && !notes[k].note) delete notes[k];
    fs.writeFileSync(NOTES, JSON.stringify(notes, null, 1));
    return [200, { notes }];
  },

  // Network at a glance (top of the page). fresh=1 re-runs it; otherwise the last result (or the latest scan's).
  netinfo: async ({ fresh } = {}) => {
    if (fresh || !lastInfo) lastInfo = await netinfo();
    return [200, { ...lastInfo, speed }];
  },
  speedtest: async () => { speed = await speedtest(); if (latest) { latest.speed = speed; saveScan(latest); } return [200, speed]; },

  // Tools tab
  wifiSurvey: async () => { const r = await wifi.survey(); if (latest) { latest.wifiSurvey = r; saveScan(latest); } return [200, r]; },
  wifiLink: async () => [200, { link: await wifi.link() }],
  ping: async ({ host } = {}) => [200, await tools.pingOnce(String(host || '').trim())],
  ports: async ({ host, ports } = {}) => [200, await tools.portCheck(String(host || '').trim(), ports)],
  trace: async ({ host } = {}) => [200, await tools.trace(String(host || '').trim())],
  lookup: async ({ name } = {}) => [200, await tools.lookup(String(name || '').trim())],
  wol: async ({ mac } = {}) => [200, await tools.wol(mac, ['255.255.255.255', ...net.localSubnets().map((l) => { const [b, bits] = l.cidr.split('/'); return net.intToIp((net.ipToInt(b) | (2 ** (32 - Number(bits)) - 1)) >>> 0); })])],

  // RF tab: read a Sonor RF probe (ESP32 + CC1101, rf-probe/) on the site network. The agent fetches it so an https page can too.
  // RF / Zigbee tabs: read a Sonor probe on the site network (paths from the shared data/sonor-wireless.js). The agent fetches it so an https page can too.
  rfProbe: async ({ ip, mhz } = {}) => probeGet('rf', ip, { mhz }),
  zbProbe: async ({ ip, op, ch, reset } = {}) => probeGet('zb', ip, { op, ch, reset }),
  // Site nodes (Sonor node scheme, sonor-wireless.js NODE): every probe / capture node on the LAN, found by mDNS + the last scan,
  // asked for /info. Cached 15 s; the page asks every 20 s while the RF or Zigbee tab is open, so a probe switched on mid-visit appears.
  nodes: async ({ fresh, extra } = {}) => {
    const add = (Array.isArray(extra) ? extra : []).filter((ip) => net.isIp(String(ip))).slice(0, 20);
    if (!fresh && !add.some((ip) => !((nodeCache && nodeCache.nodes) || []).some((n) => n.ip === ip)) && nodeCache && Date.now() - nodeCache.at < 15000) return [200, nodeCache];
    const ips = new Set(); const types = [W.NODE.service, W.PROBES.rf.service, W.PROBES.zb.service];
    try { const m = await require('./lib/discovery').mdns(2500); for (const [ip, h] of m) if (((h && h.services) || []).some((x) => types.includes(x.type))) ips.add(ip); } catch {}
    for (const d of (latest && latest.devices) || []) if (W.probeKindOf(d)) ips.add(d.ip);
    for (const n of (nodeCache && nodeCache.nodes) || []) ips.add(n.ip);
    for (const ip of add) ips.add(ip);
    const old = new Map(((nodeCache && nodeCache.nodes) || []).map((n) => [n.ip, n]));
    const nodes = (await Promise.all([...ips].filter((ip) => net.isIp(ip)).map(async (ip) => {
      try { const [, r] = await probeGet('rf', ip, { op: 'info' }); return { ...r, ip, online: true, seen: new Date().toISOString() }; }
      catch { const d = ((latest && latest.devices) || []).find((x) => x.ip === ip); const o = old.get(ip);
        if (o) return { ...o, online: false }; if (d && W.probeKindOf(d)) return { ip, kind: W.probeKindOf(d) === 'zb' ? 'zigbee' : 'rf', id: (d.mac || '').replace(/:/g, ''), name: d.name || d.kind, spot: '', online: false, legacy: true }; return null; }
    }))).filter(Boolean).sort((a, b) => String(a.kind).localeCompare(b.kind) || String(a.spot || a.name).localeCompare(b.spot || b.name));
    nodeCache = { at: Date.now(), nodes }; return [200, nodeCache];
  },
  node: async ({ ip, op, spot } = {}) => { if (!['info', 'identify', 'spot'].includes(op)) return [400, { error: 'op must be info, identify or spot' }]; const r = await probeGet('rf', ip, { op, spot }); if (op === 'spot' && nodeCache) nodeCache.at = 0; return r; },

  // Art-Net tab: ArtPoll (2.x, 10.x and each local broadcast, never 255.255.255.255) + sACN universe discovery. Discovery and info only:
  // DMX testing is the Sonor Art-Net app. op poll (3 s) | sacn (11 s, also sniffs the universes given) | locate (ArtAddress to one node).
  artnet: async ({ op = 'poll', universes, ip, on, bindIndex } = {}) => {
    const A = require('./lib/artnet'); const locals = net.localSubnets();
    const bc = (c) => { const [b, bits] = c.split('/'); return net.intToIp((net.ipToInt(b) | (2 ** (32 - Number(bits)) - 1)) >>> 0); };
    if (op === 'locate') { if (!net.isIp(ip || '')) return [400, { error: 'pick the node' }]; return [200, await A.locate(ip, on !== false && on !== 0 && on !== '0', Number(bindIndex) || 0)]; }
    if (op === 'sacn') { const r = await A.sacn({ universes: (Array.isArray(universes) ? universes : []).map(Number).filter((u) => u >= 1 && u <= 63999) }); if (latest) { latest.artnet = { ...(latest.artnet || {}), sacn: r.sources, sacnAt: new Date().toISOString() }; saveScan(latest); } return [200, r]; }
    const r = await A.poll({ broadcasts: ['2.255.255.255', '10.255.255.255', ...locals.map((l) => bc(l.cidr))], timeoutMs: 3000, locals: locals.map((l) => l.address) });
    if (latest && !r.error) { latest.artnet = { ...(latest.artnet || {}), at: new Date().toISOString(), nodes: r.nodes, dmx: r.dmx }; saveScan(latest); }
    return [200, { ...r, locals: locals.map((l) => l.cidr) }];
  },

  // Zigbee channels read straight from the hubs, so nobody types them (research zbm.lan.*).
  // neoHub legacy API: TCP 4242, JSON + NUL, no token (off unless enabled in the Heatmiser app). The channel field name is
  // not documented, so any key containing "channel" in GET_SYSTEM's answer is used.
  neoHubSystem: async ({ ip } = {}) => {
    if (!net.isIp(ip || '')) return [400, { error: 'pick the neoHub' }];
    const sock = require('net').connect(4242, ip); let buf = '';
    const r = await new Promise((resolve, reject) => {
      const t = setTimeout(() => { sock.destroy(); reject(new Error('The neoHub did not answer on 4242 (turn on the legacy API in the Heatmiser app, or use the Zigbee probe)')); }, 3000);
      sock.on('connect', () => sock.write('{"GET_SYSTEM":0}\0'));
      sock.on('data', (d) => { buf += d; if (buf.includes('\0') || /}\s*$/.test(buf)) { clearTimeout(t); sock.end(); try { resolve(JSON.parse(buf.replace(/\0/g, ''))); } catch { reject(new Error('Unexpected answer from the neoHub')); } } });
      sock.on('error', (e) => { clearTimeout(t); reject(e); });
    });
    const key = Object.keys(r).find((k) => /channel/i.test(k)); const ch = key ? Number(r[key]) : null;
    return [200, { channel: ch >= 11 && ch <= 26 ? ch : null, field: key || null, firmware: r.HUB_VERSION || r.FIRMWARE || null, raw: r }];
  },
  // Hue: needs an app key. With no key, ask the bridge for one (works for 30 s after the bridge's button is pressed).
  hueZigbee: async ({ ip, key } = {}) => {
    if (!net.isIp(ip || '')) return [400, { error: 'pick the Hue bridge' }];
    const req = (method, path, body) => new Promise((resolve, reject) => {
      const q = require('https').request({ host: ip, port: 443, path, method, rejectUnauthorized: false, timeout: 3000, headers: { 'Content-Type': 'application/json' } }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { reject(new Error('Unexpected answer from the Hue bridge')); } }); });
      q.on('timeout', () => q.destroy(new Error('The Hue bridge did not answer'))); q.on('error', reject); if (body) q.write(JSON.stringify(body)); q.end();
    });
    if (!key) {
      const r = await req('POST', '/api', { devicetype: 'sonor#scanner' });
      const ok = Array.isArray(r) && r[0] && r[0].success; if (!ok) return [200, { needButton: true, error: (r[0] && r[0].error && r[0].error.description) || 'press the button on the bridge' }];
      key = ok.username;
    }
    const c = await req('GET', `/api/${encodeURIComponent(key)}/config`);
    if (Array.isArray(c) && c[0] && c[0].error) return [200, { needButton: true, error: c[0].error.description }];
    return [200, { key, channel: Number(c.zigbeechannel) || null, bridgeid: c.bridgeid || null, name: c.name || null }];
  },

  // Re-probe one address (after a device is plugged in or renamed).
  probe: async ({ ip } = {}) => {
    if (!net.isIp(ip || '')) return [400, { error: 'enter an IPv4 address' }];
    const s = await scan({ targets: [`${ip}/32`], ping: true, foreign: false });
    const d = s.devices[0];
    if (!d) return [404, { error: `Nothing answered at ${ip}` }];
    if (latest) {
      const i = latest.devices.findIndex((x) => x.ip === ip);
      if (i >= 0) latest.devices[i] = d; else latest.devices.push(d);
      latest.devices.sort((a, b) => net.ipToInt(a.ip) - net.ipToInt(b.ip));
      saveScan(latest);
    }
    return [200, { device: d }];
  },
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^\/api\/(\w+)$/);
  if (m && actions[m[1]]) {
    try {
      const args = req.method === 'POST' ? await readBody(req) : Object.fromEntries(url.searchParams);
      const [code, obj] = await actions[m[1]](args);
      json(res, code, obj);
    } catch (e) { if (!res.headersSent) json(res, e.message && /^Enter /.test(e.message) ? 400 : 500, { error: e.message }); }
    return;
  }
  const file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\nSonor Network Scanner v${VERSION} running.`);
    console.log(`  On this computer:  http://localhost:${PORT}`);
    for (const s of net.localSubnets()) console.log(`  From a phone / laptop on ${s.ifname} (${s.cidr}): http://${s.address}:${PORT}`);
    console.log('');
  });
}

module.exports = { server, actions, VERSION };
