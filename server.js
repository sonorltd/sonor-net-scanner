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

const VERSION = '1.4.0';
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
