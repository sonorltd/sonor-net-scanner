'use strict';
// Full network scan: sweep → listen/ask discovery → deep probe of every live host → identify.
const os = require('os');
const fs = require('fs');
const dns = require('dns').promises;
const { execFile } = require('child_process');
const net = require('./net');
const disc = require('./discovery');
const probes = require('./probes');
const { vendor, isRandom, normMac } = require('./oui');
const { identify } = require('./identify');
const { addressing, conflicts } = require('./addressing');

function defaultGateways() {
  return new Promise((resolve) => {
    const out = new Set();
    if (process.platform === 'linux') {
      try {
        for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
          const f = line.trim().split(/\s+/);
          if (f[1] === '00000000' && f[2] && f[2] !== '00000000') out.add(Buffer.from(f[2], 'hex').reverse().join('.'));
        }
      } catch {}
      return resolve([...out]);
    }
    execFile('netstat', ['-rn'], { timeout: 3000 }, (err, txt) => {
      if (!err) for (const line of String(txt).split('\n')) {
        const m = line.match(/^\s*(?:default|0\.0\.0\.0)\s+(?:0\.0\.0\.0\s+)?(\d+\.\d+\.\d+\.\d+)/); if (m) out.add(m[1]);
      }
      resolve([...out]);
    });
  });
}

async function rdns(ip) {
  try { const r = await Promise.race([dns.reverse(ip), net.sleep(1200).then(() => [])]); return (r && r[0]) || ''; } catch { return ''; }
}

const broadcastOf = (cidr) => { const [b, bits] = cidr.split('/'); return net.intToIp((net.ipToInt(b) | (2 ** (32 - Number(bits)) - 1)) >>> 0); };

// opts: { targets:[cidr|range], deep:true, onProgress(p) }
async function scan(opts = {}) {
  const t0 = Date.now();
  const locals = net.localSubnets();
  const targets = (opts.targets && opts.targets.length ? opts.targets : locals.map((l) => l.cidr)).map(String);
  const hostSet = new Set(targets.flatMap(net.expandTarget));
  const hosts = [...hostSet];
  const progress = { phase: 'sweep', done: 0, total: hosts.length, found: 0, started: new Date(t0).toISOString() };
  const tick = () => { if (opts.onProgress) try { opts.onProgress({ ...progress }); } catch {} };
  tick();

  // discovery listeners run alongside the sweep
  const localIps = locals.map((l) => l.address);
  const discoveryP = Promise.all([
    disc.mdns(5000), disc.ssdp(4000), disc.sddp(localIps, 4500), disc.ubiquiti(['255.255.255.255', ...locals.map((l) => broadcastOf(l.cidr))], 3000),
    disc.onvif(3500), disc.amxBeacon(6000), disc.sadp(4500), disc.dahua(4000),
  ]);

  // 1) sweep: TCP knock (+ system ping). Any answer, even "refused", means alive.
  const alive = new Map(); // ip → { via:[], latency }
  await net.pool(hosts, 64, async (ip) => {
    const [knock, ms] = await Promise.all([
      Promise.all(probes.ALIVE_PORTS.map((p) => net.tcp(ip, p, 650))),
      opts.ping === false ? null : net.ping(ip, 800),
    ]);
    const via = [];
    if (knock.some(Boolean)) via.push('tcp');
    if (ms !== null && ms !== undefined) via.push('ping');
    if (via.length) alive.set(ip, { via, latency: ms });
    progress.done++; progress.found = alive.size;
    if (progress.done % 8 === 0) tick();
  });

  // 2) ARP table: catches silent devices (the sweep made the OS ARP for every address)
  progress.phase = 'listening'; tick();
  const [mdns, ssdp, sddp, ubnt, onvif, amx, sadp, dahua] = await discoveryP;
  const arp = await net.arpTable();
  for (const [ip] of arp) if (hostSet.has(ip)) { const a = alive.get(ip) || { via: [] }; if (!a.via.includes('arp')) a.via.push('arp'); alive.set(ip, a); }
  const discovered = (m, tagName) => { for (const ip of m.keys()) if (hostSet.has(ip)) { const a = alive.get(ip) || { via: [] }; if (!a.via.includes(tagName)) a.via.push(tagName); alive.set(ip, a); } };
  discovered(mdns, 'mdns'); discovered(ssdp, 'ssdp'); discovered(sddp, 'sddp'); discovered(ubnt, 'ubiquiti'); discovered(onvif, 'onvif'); discovered(amx, 'beacon'); discovered(sadp, 'sadp'); discovered(dahua, 'dahua');
  // kit that answered discovery from an address outside every network we're on (factory defaults, wrong mask…)
  const inLocal = (ip) => locals.some((l) => { const [b, bits] = l.cidr.split('/'); const m = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0; return ((net.ipToInt(ip) & m) >>> 0) === ((net.ipToInt(b) & m) >>> 0); });
  const foreign = new Map();
  for (const [m, tagName] of [[mdns, 'mdns'], [ssdp, 'ssdp'], [sddp, 'sddp'], [ubnt, 'ubiquiti'], [onvif, 'onvif'], [amx, 'beacon'], [sadp, 'sadp'], [dahua, 'dahua']]) {
    for (const ip of m.keys()) if (net.isIp(ip) && !hostSet.has(ip) && !inLocal(ip) && !ip.startsWith('127.')) { const a = foreign.get(ip) || { via: [] }; if (!a.via.includes(tagName)) a.via.push(tagName); foreign.set(ip, a); }
  }
  if (opts.foreign !== false) for (const [ip, a] of foreign) alive.set(ip, { ...a, foreign: true });
  for (const l of locals) if (hostSet.has(l.address)) { const a = alive.get(l.address) || { via: [] }; a.via.push('self'); alive.set(l.address, a); }

  // 3) deep probe
  const gateways = new Set(await defaultGateways());
  const ips = [...alive.keys()].sort((a, b) => net.ipToInt(a) - net.ipToInt(b));
  progress.phase = 'probing'; progress.done = 0; progress.total = ips.length; progress.found = ips.length; tick();
  const upnpCache = new Map();
  const devices = [];
  await net.pool(ips, 12, async (ip) => {
    const a = alive.get(ip);
    const self = locals.find((l) => l.address === ip);
    const mac = normMac((self && self.mac) || arp.get(ip) || (ubnt.get(ip) || {}).mac || (onvif.get(ip) || {}).mac || '');
    const h = { ip, mac, vendor: vendor(mac), randomMac: isRandom(mac), seenBy: a.via, latency: a.latency, isGateway: gateways.has(ip), isSelf: !!self,
      mdns: mdns.get(ip), ssdp: ssdp.get(ip), sddp: sddp.get(ip), ubnt: ubnt.get(ip), onvif: onvif.get(ip), amx: amx.get(ip), sadp: sadp.get(ip), dahua: dahua.get(ip), foreign: !!a.foreign };
    if (!h.mac) { h.mac = normMac((h.sadp || {}).mac || (h.dahua || {}).mac || ''); h.vendor = vendor(h.mac); h.randomMac = isRandom(h.mac); }
    if (opts.deep !== false && !self) {
      const [ports, nb, mname, dname] = await Promise.all([probes.scanPorts(ip), disc.netbios(ip), disc.mdnsReverse(ip), rdns(ip)]);
      h.ports = ports; h.netbios = nb; h.mdnsName = mname; h.dnsName = dname;
      if (!h.mac && nb && nb.mac) { h.mac = nb.mac; h.vendor = vendor(nb.mac); h.randomMac = isRandom(nb.mac); }
      const fp = await probes.fingerprint(ip, ports);
      h.details = fp.details; h.web = fp.web;
      // UPnP descriptions (root first, at most two per device)
      const locs = ((h.ssdp && h.ssdp.locations) || []).slice(0, 2);
      h.upnp = (await Promise.all(locs.map(async (l) => { if (!upnpCache.has(l)) upnpCache.set(l, disc.upnpDescription(l)); return upnpCache.get(l); }))).filter(Boolean);
      if (!h.mac) { const m = h.upnp.map((u) => u.macAddress).find(Boolean) || (h.details.sonos && h.details.sonos.mac) || (h.details.cast && h.details.cast.mac); if (m) { h.mac = m; h.vendor = vendor(m); } }
    } else { h.ports = []; h.details = {}; h.web = []; h.upnp = []; }
    const id = identify(h);
    const claims = [{ via: 'ARP', mac: arp.get(ip) }, { via: 'UniFi', mac: (h.ubnt || {}).mac }, { via: 'ONVIF', mac: (h.onvif || {}).mac }, { via: 'SADP', mac: (h.sadp || {}).mac },
      ...(((h.sadp || {}).otherMacs) || []).map((m) => ({ via: 'SADP', mac: m })), { via: 'Dahua', mac: (h.dahua || {}).mac }, ...(((h.dahua || {}).otherMacs) || []).map((m) => ({ via: 'Dahua', mac: m })),
      { via: 'NetBIOS', mac: (h.netbios || {}).mac }, { via: 'UPnP', mac: ((h.upnp || []).find((u) => u.macAddress) || {}).macAddress }].map((c) => ({ ...c, mac: normMac(c.mac || '') }));
    h.addressing = addressing({ ip, make: id.make, vendor: h.vendor, isGateway: h.isGateway }, { sadp: h.sadp, dahua: h.dahua });
    h.conflict = conflicts({ ip }, claims);
    if (h.foreign) {
      const on = locals.map((l) => l.cidr).join(', ') || 'no network';
      const reached = (h.ports || []).length > 0;
      const rep = h.sadp || h.dahua;
      h.subnetNote = `Answered discovery from ${ip}, outside the network this scanner is on (${on}). `
        + (reached ? 'Its ports answered, so it is routed and reachable.' : 'It did not answer directly, so it is on the wrong subnet or a VLAN with no route.')
        + (rep && rep.mask ? ` Its own settings: mask ${rep.mask}, gateway ${rep.gateway || 'none'}.` : '');
    }
    if (self) Object.assign(id, { name: os.hostname(), kind: 'This scanner', service: 'design', serviceLabel: '10 Infrastructure', confidence: 'high' });
    devices.push(record(h, id));
    progress.done++; tick();
  });
  devices.sort((x, y) => net.ipToInt(x.ip) - net.ipToInt(y.ip));

  return {
    id: new Date(t0).toISOString().replace(/[:.]/g, '-'),
    startedAt: new Date(t0).toISOString(), finishedAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    agent: { hostname: os.hostname(), platform: process.platform, interfaces: locals },
    targets, gateways: [...gateways], devices,
  };
}

// The stored / shown shape of one device.
function record(h, id) {
  const ports = (h.ports || []).map((p) => ({ port: p, label: probes.PORTS[p] || '' }));
  return {
    ip: h.ip, mac: h.mac || '', vendor: h.vendor || '', randomMac: !!h.randomMac,
    name: id.name || '', make: id.make || '', model: id.model || '', kind: id.kind || '', service: id.service, serviceLabel: id.serviceLabel,
    firmware: id.firmware || '', firmwareHint: id.firmwareHint || '', serial: id.serial || '', confidence: id.confidence, evidence: id.evidence,
    c4Driver: id.c4Driver || '', isGateway: !!h.isGateway, isSelf: !!h.isSelf, seenBy: h.seenBy || [], latency: h.latency ?? null,
    hostnames: [...new Set([h.netbios && h.netbios.name, h.mdnsName, h.mdns && h.mdns.hostname, h.dnsName].filter(Boolean))],
    ports, web: (h.web || []).filter((w) => w.title || w.server || w.realm),
    services: ((h.mdns && h.mdns.services) || []).map((s) => ({ type: s.type, name: s.name, port: s.port, txt: s.txt })),
    upnp: h.upnp || [], ssdpServer: (h.ssdp && h.ssdp.server) || '', sddp: h.sddp || null, ubnt: h.ubnt || null, onvif: h.onvif || null, beacon: h.amx || null,
    netbios: h.netbios || null, sadp: h.sadp || null, dahua: h.dahua || null,
    foreign: !!h.foreign, subnetNote: h.subnetNote || '', addressing: h.addressing || { mode: 'unknown', source: '', note: '' }, conflict: h.conflict || null,
  };
}

module.exports = { scan, defaultGateways };
