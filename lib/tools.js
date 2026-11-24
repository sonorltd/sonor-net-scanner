'use strict';
// Engineer's tools: ping, port check, traceroute, DNS lookup, Wake-on-LAN. Same code on the Pi agent and in the app.
const dgram = require('dgram');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const net = require('./net');
const { PORTS } = require('./probes');

const HOST_RE = /^[a-z0-9.-]{1,253}$/i;
const okHost = (h) => HOST_RE.test(String(h || '')) && !String(h).startsWith('-');

// One ping: ICMP via the system tool, falling back to a TCP knock (any answer, even "refused", is a reply).
async function pingOnce(host) {
  if (!okHost(host)) throw new Error('Enter an IP address or host name');
  const ms = await net.ping(host, 1000);
  if (ms !== null && ms !== undefined) return { ok: true, ms: Math.round(ms * 10) / 10, via: 'icmp' };
  const t0 = Date.now();
  for (const p of [80, 443, 22, 7000]) {
    const r = await net.tcp(host, p, 700);
    if (r) return { ok: true, ms: Date.now() - t0, via: `tcp ${p}` };
  }
  return { ok: false, ms: null, via: '' };
}

// "80,443,1000-1100" → [80, 443, 1000…1100] (max 2048 ports); "common" = the scanner's AV list.
const PI = require('../public/data/portinfo.js');
// spec: a preset id (common, control, tv, audio, cctv, network, remote, top1024) or a list "80,443,5020" / range "1-1024".
function parsePorts(spec) {
  let s = String(spec || 'common').trim();
  const pre = PI.PRESETS.find((x) => x[0] === s); if (pre) { if (Array.isArray(pre[3])) return [...new Set(pre[3])].sort((a, b) => a - b); s = pre[3]; }
  const out = new Set();
  for (const part of s.split(/[\s,]+/)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/); if (!m) continue;
    const a = Number(m[1]); const b = Math.min(Number(m[2] || m[1]), a + 2047, 65535);
    for (let p = a; p <= b && out.size < 2048; p++) if (p > 0) out.add(p);
  }
  if (!out.size) throw new Error('Enter ports like 80,443,5020 or 1-1024, or pick a preset');
  return [...out].sort((x, y) => x - y);
}
const WEB = [80, 443, 8000, 8080, 8443, 9090, 5000, 5001];
const BANNER = [21, 22, 23, 25, 4998, 5020, 8102, 10001, 60006];
async function portCheck(host, spec) {
  if (!okHost(host)) throw new Error('Enter an IP address or host name');
  const ports = parsePorts(spec);
  const t0 = Date.now();
  const res = await net.pool(ports, 64, async (p) => ({ port: p, state: await net.tcp(host, p, 900) }));
  const open = res.filter((r) => r.state === 'open').map((r) => r.port).sort((a, b) => a - b);
  const extra = {};
  // What answers on the open ports: banners on text protocols, page title + Server header on web ports.
  await Promise.all(open.slice(0, 24).map(async (p) => {
    if (BANNER.includes(p)) { const b = await net.banner(host, p, { timeoutMs: 1200 }); if (b) extra[p] = { banner: b.replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, 140) }; }
    else if (WEB.includes(p)) {
      const r = await net.httpGet(`${[443, 8443, 5001].includes(p) ? 'https' : 'http'}://${host}:${p}/`, { timeoutMs: 1800, max: 60000 }).catch(() => null);
      if (r) { const t = ((String(r.body || '').match(/<title[^>]*>([^<]{1,120})<\/title>/i) || [])[1] || '').trim(); const sv = (r.headers || {}).server || ''; extra[p] = { banner: [t && `“${t}”`, sv && `server ${sv}`, r.status && r.status !== 200 && `HTTP ${r.status}`].filter(Boolean).join(' · ') }; }
    }
  }));
  const row = (p) => ({ port: p, ...(PI.info(p) || { name: '', what: '', group: '' }), banner: (extra[p] || {}).banner || '' });
  return { host, spec: String(spec || 'common'), checked: ports.length, seconds: Math.round((Date.now() - t0) / 100) / 10,
    open: open.map(row), refused: res.filter((r) => r.state === 'closed').length, silent: res.filter((r) => r.state !== 'open' && r.state !== 'closed').length,
    knownClosed: res.filter((r) => r.state !== 'open' && PI.info(r.port)).map((r) => ({ ...row(r.port), state: r.state })).slice(0, 120) };
}

// Traceroute by raising the ping TTL until the target answers (needs no root on Linux, macOS or Android).
function pingTtl(host, ttl) {
  return new Promise((resolve) => {
    const plat = process.platform;
    const args = plat === 'win32' ? ['-n', '1', '-i', String(ttl), '-w', '1000', host] : plat === 'darwin' ? ['-c', '1', '-m', String(ttl), '-t', '1', host] : ['-c', '1', '-t', String(ttl), '-W', '1', host];
    const t0 = Date.now();
    execFile('ping', args, { timeout: 2500 }, (err, out) => {
      const text = String(out || '');
      const from = (text.match(/[Ff]rom (\d+\.\d+\.\d+\.\d+)/) || text.match(/Reply from (\d+\.\d+\.\d+\.\d+)/) || [])[1];
      const exceeded = /exceeded|TTL expired/i.test(text);
      const ms = (text.match(/time[=<]\s*([\d.]+)\s*ms/i) || [])[1];
      if (!err && !exceeded) return resolve({ ip: (text.match(/bytes from (\d+\.\d+\.\d+\.\d+)/i) || [])[1] || host, ms: ms ? Number(ms) : Date.now() - t0, done: true });
      resolve({ ip: from || '', ms: from ? Date.now() - t0 : null, done: false });
    });
  });
}
async function trace(host, maxHops = 16) {
  if (!okHost(host)) throw new Error('Enter an IP address or host name');
  const hops = []; let silent = 0;
  for (let ttl = 1; ttl <= maxHops; ttl++) {
    const h = await pingTtl(host, ttl);
    hops.push({ hop: ttl, ip: h.ip, ms: h.ms });
    if (h.done) break;
    silent = h.ip ? 0 : silent + 1;
    if (silent >= 4) { hops.push({ hop: ttl + 1, ip: '', ms: null, note: 'Stopped: 4 hops in a row did not answer (ping blocked, or the target is down)' }); break; }
  }
  return { host, hops };
}

async function lookup(name) {
  if (!okHost(name)) throw new Error('Enter a host name or IP address');
  if (net.isIp(name)) { let names = []; try { names = await dns.reverse(name); } catch {} return { name, addresses: [name], names }; }
  let addresses = [];
  try { addresses = dns.resolve4 ? await dns.resolve4(name) : []; } catch {}
  if (!addresses.length && dns.lookup) { try { addresses = (await dns.lookup(name, { all: true, family: 4 })).map((a) => a.address); } catch {} }
  return { name, addresses, names: [] };
}

// Wake-on-LAN magic packet to the subnet broadcast (and 255.255.255.255) on ports 9 and 7.
function wol(mac, broadcasts = ['255.255.255.255']) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '');
  if (hex.length !== 12) return Promise.reject(new Error('Enter a MAC address, e.g. 00:11:22:33:44:55'));
  const pkt = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(Buffer.from(hex, 'hex'))]);
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', () => {});
    s.bind(0, () => {
      try { s.setBroadcast(true); } catch {}
      let sent = 0; const targets = [...new Set(broadcasts)].flatMap((b) => [[b, 9], [b, 7]]);
      targets.forEach(([b, p]) => s.send(pkt, p, b, () => { if (++sent === targets.length) { try { s.close(); } catch {} resolve({ mac: hex.match(/../g).join(':').toUpperCase(), sentTo: targets.map((t) => t.join(':')) }); } }));
    });
  });
}

module.exports = { pingOnce, portCheck, parsePorts, trace, lookup, wol };
