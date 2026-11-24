'use strict';
// "Network at a glance": everything an engineer wants first on a site, before the device list.
// This device (IP / mask / MAC / Wi-Fi), gateway, DNS servers (each tested), DHCP server(s) (rogue check),
// internet (latency, captive portal, IPv6), WAN (public IP, ISP, router's own WAN IP → double NAT / CGNAT)
// and an on-demand speed test. Every part is best effort: a missing tool or blocked port just leaves it blank.
const os = require('os');
const fs = require('fs');
const dgram = require('dgram');
const dns = require('dns');
const net = require('./net');
const { vendor, normMac } = require('./oui');
const { execFile } = require('child_process');

const run = (cmd, args, ms = 3000) => new Promise((res) => { try { execFile(cmd, args, { timeout: ms }, (e, out) => res(e ? '' : String(out))); } catch { res(''); } });
const within = (p, ms, d = null) => Promise.race([p.catch(() => d), new Promise((r) => setTimeout(() => r(d), ms))]);
const PRIVATE = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip || '');
const CGNAT = (ip) => { const m = String(ip || '').match(/^100\.(\d+)\./); return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127; };

// ── this device ────────────────────────────────────────────────────────────
function gateways() {
  return new Promise((resolve) => {
    const out = [];
    if (process.platform === 'linux') {
      try {
        for (const line of fs.readFileSync('/proc/net/route', 'utf8').split('\n').slice(1)) {
          const f = line.trim().split(/\s+/);
          if (f[1] === '00000000' && f[2] && f[2] !== '00000000') out.push({ ip: Buffer.from(f[2], 'hex').reverse().join('.'), ifname: f[0] });
        }
      } catch {}
      return resolve(out);
    }
    run('netstat', ['-rn']).then((txt) => {
      for (const line of txt.split('\n')) {
        const m = line.match(/^\s*(?:default|0\.0\.0\.0)\s+(?:0\.0\.0\.0\s+)?(\d+\.\d+\.\d+\.\d+)(?:\s+\S+)*?\s+(\w+\d)?\s*$/) || line.match(/^\s*(?:default|0\.0\.0\.0)\s+(?:0\.0\.0\.0\s+)?(\d+\.\d+\.\d+\.\d+)/);
        if (m && !out.find((g) => g.ip === m[1])) out.push({ ip: m[1], ifname: m[2] || '' });
      }
      resolve(out);
    });
  });
}

function ipv6() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) if ((a.family === 'IPv6' || a.family === 6) && !a.internal && !/^fe80/i.test(a.address)) out.push({ ifname, address: a.address, temporary: /^f[cd]/i.test(a.address) ? 'ula' : 'global' });
  }
  return out;
}

async function wifi() {
  const p = process.platform;
  if (p === 'linux') {
    const nm = await run('nmcli', ['-t', '-f', 'active,ssid,signal,chan,freq,security', 'dev', 'wifi']);
    const on = nm.split('\n').find((l) => /^yes:/.test(l));
    if (on) { const f = on.split(':'); return { ssid: f[1], signal: Number(f[2]) || null, signalUnit: '%', channel: f[3], band: /^5|^6/.test(f[4]) ? (/^6/.test(f[4]) ? '6 GHz' : '5 GHz') : '2.4 GHz', security: f.slice(5).join(':') }; }
    const ssid = (await run('iwgetid', ['-r'])).trim();
    if (!ssid) return null;
    const link = await run('iw', ['dev', 'wlan0', 'link']);
    const sig = (link.match(/signal:\s*(-?\d+)/) || [])[1]; const freq = (link.match(/freq:\s*(\d+)/) || [])[1];
    return { ssid, signal: sig ? Number(sig) : null, signalUnit: 'dBm', band: freq ? (freq >= 5925 ? '6 GHz' : freq >= 5000 ? '5 GHz' : '2.4 GHz') : '' };
  }
  if (p === 'darwin') {
    const sum = await run('ipconfig', ['getsummary', 'en0']);
    let ssid = (sum.match(/\n\s*SSID\s*:\s*(.+)/) || [])[1];
    if (!ssid) ssid = ((await run('networksetup', ['-getairportnetwork', 'en0'])).match(/Network:\s*(.+)/) || [])[1];
    if (!ssid || /redacted/i.test(ssid)) return ssid ? { ssid: '', note: 'macOS hides the Wi-Fi name unless Location Services is allowed for Terminal / Node' } : null;
    return { ssid: ssid.trim() };
  }
  if (p === 'win32') {
    const t = await run('netsh', ['wlan', 'show', 'interfaces']);
    const g = (k) => ((t.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'mi')) || [])[1] || '').trim();
    if (!g('SSID')) return null;
    return { ssid: g('SSID'), signal: Number(g('Signal').replace('%', '')) || null, signalUnit: '%', channel: g('Channel'), band: g('Band') || g('Radio type'), security: g('Authentication') };
  }
  return null;
}

// What the OS says about its own DHCP lease (server, lease time, domain).
async function leaseInfo(ifname) {
  const p = process.platform;
  if (p === 'darwin') {
    const t = await run('ipconfig', ['getpacket', ifname || 'en0']);
    if (!t) return null;
    const g = (k) => (t.match(new RegExp(`${k}\\s*\\(\\w+\\):\\s*(.+)`)) || [])[1];
    return { server: g('server_identifier'), leaseSeconds: Number(g('lease_time')) || Number(parseInt(g('lease_time'), 16)) || null, domain: g('domain_name') };
  }
  if (p === 'linux') {
    const nm = await run('nmcli', ['-t', '-f', 'DHCP4', 'dev', 'show', ifname || '']);
    const g = (k) => (nm.match(new RegExp(`${k} = ([^\\n]+)`)) || [])[1];
    if (g('dhcp_server_identifier')) return { server: g('dhcp_server_identifier'), leaseSeconds: Number(g('dhcp_lease_time')) || null, domain: g('domain_name') };
    const dc = await run('dhcpcd', ['-U', ifname || 'eth0']);
    const d = (k) => ((dc.match(new RegExp(`^${k}='?([^'\\n]+)`, 'm')) || [])[1]);
    if (d('dhcp_server_identifier')) return { server: d('dhcp_server_identifier'), leaseSeconds: Number(d('dhcp_lease_time')) || null, domain: d('domain_name') };
    return null;
  }
  if (p === 'win32') {
    const t = await run('ipconfig', ['/all']);
    const s = (t.match(/DHCP Server[ .]*:\s*([\d.]+)/) || [])[1];
    return s ? { server: s } : null;
  }
  return null;
}

// Ask the whole LAN for a DHCP offer and list every server that answers (two = a rogue router / ISP box).
// Needs UDP 68: works on the Pi service (CAP_NET_BIND_SERVICE) and as admin; skipped quietly otherwise.
function dhcpDiscover(mac, ms = 3500) {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const offers = new Map(); let done = false;
    const finish = (err) => { if (done) return; done = true; try { s.close(); } catch {} resolve(err ? { error: err } : [...offers.values()]); };
    s.on('error', (e) => finish(e.code === 'EACCES' || e.code === 'EADDRINUSE' ? 'needs admin or port 68 is in use (OS DHCP client), so only the OS lease is shown' : e.message));
    s.on('message', (m, r) => {
      if (m[0] !== 2 || m.length < 240) return;
      const o = { from: r.address, offered: [...m.slice(16, 20)].join('.') };
      for (let i = 240; i < m.length;) {
        const code = m[i]; if (code === 255) break; if (code === 0) { i++; continue; }
        const len = m[i + 1]; const v = m.slice(i + 2, i + 2 + len);
        if (code === 54 && len === 4) o.server = [...v].join('.');
        if (code === 3 && len >= 4) o.router = [...v.slice(0, 4)].join('.');
        if (code === 1 && len === 4) o.mask = [...v].join('.');
        if (code === 6) { o.dns = []; for (let k = 0; k + 4 <= len; k += 4) o.dns.push([...v.slice(k, k + 4)].join('.')); }
        if (code === 51 && len === 4) o.leaseSeconds = v.readUInt32BE(0);
        if (code === 15) o.domain = v.toString();
        i += 2 + len;
      }
      offers.set(o.server || r.address, o);
    });
    s.bind(68, () => {
      try { s.setBroadcast(true); } catch {}
      const pkt = Buffer.alloc(300);
      pkt[0] = 1; pkt[1] = 1; pkt[2] = 6; require('crypto').randomBytes(4).copy(pkt, 4); pkt.writeUInt16BE(0x8000, 10);
      Buffer.from(String(mac || '02:00:00:00:00:01').replace(/[^0-9a-f]/gi, '').padEnd(12, '0').slice(0, 12), 'hex').copy(pkt, 28);
      Buffer.from([99, 130, 83, 99, 53, 1, 1, 55, 5, 1, 3, 6, 15, 51, 255]).copy(pkt, 236);
      s.send(pkt, 67, '255.255.255.255', () => {});
      setTimeout(() => finish(), ms);
    });
  });
}

// ── DNS ────────────────────────────────────────────────────────────────────
async function testDns(server) {
  const r = new dns.promises.Resolver({ timeout: 1500, tries: 1 }); r.setServers([server]);
  const t0 = Date.now();
  try { await r.resolve4('www.google.com'); return { server, ok: true, ms: Date.now() - t0 }; } catch (e) { return { server, ok: false, error: e.code || e.message }; }
}

// ── WAN ────────────────────────────────────────────────────────────────────
async function publicIp() {
  const r = await net.httpGet('https://ipinfo.io/json', { timeoutMs: 3500, headers: { Accept: 'application/json' } });
  try { const j = JSON.parse(r.body); if (j.ip) return { ip: j.ip, isp: String(j.org || '').replace(/^AS\d+\s*/, ''), asn: (String(j.org || '').match(/^AS\d+/) || [])[0] || '', city: j.city, region: j.region, country: j.country, hostname: j.hostname, source: 'ipinfo.io' }; } catch {}
  const c = await net.httpGet('https://1.1.1.1/cdn-cgi/trace', { timeoutMs: 3000 });
  const ip = c && (c.body.match(/^ip=(.+)$/m) || [])[1];
  return ip ? { ip, source: 'cloudflare' } : null;
}
async function publicIp6() {
  const r = await within(net.httpGet('https://api6.ipify.org?format=json', { timeoutMs: 3000 }), 3500);
  try { return JSON.parse(r.body).ip || null; } catch { return null; }
}

// Router's own WAN address over UPnP IGD: private / 100.64 there = double NAT or carrier NAT.
function routerWan(ms = 2500) {
  return new Promise((resolve) => {
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const locs = new Set(); let done = false;
    const finish = async () => {
      if (done) return; done = true; try { s.close(); } catch {}
      for (const loc of locs) {
        const d = await net.httpGet(loc, { timeoutMs: 2000 }); if (!d || !d.body) continue;
        const svc = [...d.body.matchAll(/<service>([\s\S]*?)<\/service>/g)].map((m) => m[1]).find((x) => /WAN(IP|PPP)Connection/.test(x));
        if (!svc) continue;
        const type = (svc.match(/<serviceType>([^<]+)/) || [])[1]; const ctl = (svc.match(/<controlURL>([^<]+)/) || [])[1];
        const model = ((d.body.match(/<modelName>([^<]+)/) || [])[1] || '') + ' ' + ((d.body.match(/<modelNumber>([^<]+)/) || [])[1] || '');
        const url = new URL(ctl, loc).toString();
        const body = `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetExternalIPAddress xmlns:u="${type}"/></s:Body></s:Envelope>`;
        const ip = await soap(url, type, body);
        if (ip) return resolve({ wanIp: ip, router: new URL(loc).hostname, model: model.trim() });
      }
      resolve(null);
    };
    s.on('error', () => finish());
    s.on('message', (m) => { const l = (String(m).match(/^location:\s*(\S+)/im) || [])[1]; if (l) locs.add(l); });
    s.bind(() => {
      const q = 'M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:InternetGatewayDevice:1\r\n\r\n';
      s.send(q, 1900, '239.255.255.250', () => {});
      setTimeout(finish, ms);
    });
  });
}
function soap(url, type, body) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = require('http').request(u, { method: 'POST', timeout: 2500, headers: { 'Content-Type': 'text/xml; charset="utf-8"', SOAPAction: `"${type}#GetExternalIPAddress"`, 'Content-Length': Buffer.byteLength(body) } }, (res) => {
      let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve((b.match(/<NewExternalIPAddress>([^<]*)/) || [])[1] || null));
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null)); req.end(body);
  });
}

// ── internet ───────────────────────────────────────────────────────────────
async function tcpMs(host, port) { const t0 = Date.now(); const r = await net.tcp(host, port, 2500); return r === 'open' ? Date.now() - t0 : null; }
async function internet() {
  const [cf, google, portal, v6] = await Promise.all([
    tcpMs('1.1.1.1', 443), tcpMs('8.8.8.8', 443),
    net.httpGet('http://connectivitycheck.gstatic.com/generate_204', { timeoutMs: 3000 }),
    tcpMs('2606:4700:4700::1111', 443),
  ]);
  const t0 = Date.now(); let nameOk = false;
  try { await within(dns.promises.lookup('www.bbc.co.uk'), 2500).then((r) => { nameOk = !!r; }); } catch {}
  const nameMs = nameOk ? Date.now() - t0 : null;
  const captive = portal ? portal.status !== 204 : null;
  return { online: cf != null || google != null, latencyMs: [cf, google].filter((x) => x != null).sort((a, b) => a - b)[0] ?? null, cloudflareMs: cf, googleMs: google, dnsWorks: nameOk, dnsMs: nameMs, captivePortal: captive, ipv6: v6 != null, ipv6Ms: v6 };
}

// ── speed test (on demand; Cloudflare's public endpoints) ─────────────────
async function speedtest({ downBytes = 25e6, upBytes = 8e6 } = {}) {
  const https = require('https');
  const down = () => new Promise((resolve) => {
    const t0 = Date.now(); let n = 0; let first = 0;
    const req = https.get(`https://speed.cloudflare.com/__down?bytes=${downBytes}`, { timeout: 20000 }, (res) => {
      res.on('data', (d) => { if (!first) first = Date.now(); n += d.length; }); res.on('end', () => { const s = (Date.now() - (first || t0)) / 1000; resolve({ mbps: +(n * 8 / 1e6 / s).toFixed(1), bytes: n, seconds: +s.toFixed(1) }); });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null));
  });
  const up = () => new Promise((resolve) => {
    const body = Buffer.alloc(upBytes, 48); const t0 = Date.now();
    const req = https.request('https://speed.cloudflare.com/__up', { method: 'POST', timeout: 25000, headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': body.length } }, (res) => { res.resume(); res.on('end', () => { const s = (Date.now() - t0) / 1000; resolve({ mbps: +(upBytes * 8 / 1e6 / s).toFixed(1), bytes: upBytes, seconds: +s.toFixed(1) }); }); });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(null)); req.end(body);
  });
  const pings = []; for (let i = 0; i < 5; i++) { const m = await tcpMs('speed.cloudflare.com', 443); if (m != null) pings.push(m); }
  const d = await down(); const u = await up();
  const sorted = pings.slice().sort((a, b) => a - b);
  const jitter = pings.length > 1 ? +(pings.slice(1).reduce((a, x, i) => a + Math.abs(x - pings[i]), 0) / (pings.length - 1)).toFixed(1) : null;
  return { at: new Date().toISOString(), downMbps: d && d.mbps, upMbps: u && u.mbps, latencyMs: sorted[0] ?? null, jitterMs: jitter, server: 'speed.cloudflare.com' };
}

// ── everything ─────────────────────────────────────────────────────────────
async function netinfo({ dhcp = true } = {}) {
  const t0 = Date.now();
  const ifs = net.localSubnets();
  const gws = await gateways();
  const primary = ifs.find((i) => gws.some((g) => g.ifname === i.ifname)) || ifs[0] || null;
  const gw = gws.find((g) => primary && g.ifname === primary.ifname) || gws[0] || null;
  const servers = [...new Set(dns.getServers().map((s) => s.replace(/^\[|\](:\d+)?$/g, '').replace(/:53$/, '')))].filter(Boolean);
  const [wf, lease, offers, inet, pub, pub6, rw, dnsTests, gwPing, arp] = await Promise.all([
    within(wifi(), 4000), within(leaseInfo(primary && primary.ifname), 4000),
    dhcp ? within(dhcpDiscover(primary && primary.mac), 4500, { error: 'timed out' }) : null,
    within(internet(), 6000), within(publicIp(), 5000), publicIp6(), within(routerWan(), 6000),
    Promise.all(servers.slice(0, 6).map((s) => within(testDns(s), 2500, { server: s, ok: false, error: 'timeout' }))),
    gw ? net.ping(gw.ip) : null, net.arpTable(),
  ]);
  const gwMac = gw ? normMac(arp.get(gw.ip) || '') : '';
  const dhcpServers = Array.isArray(offers) ? offers : [];
  const out = {
    at: new Date().toISOString(), seconds: +((Date.now() - t0) / 1000).toFixed(1), hostname: os.hostname(), platform: process.platform,
    self: primary && { ifname: primary.ifname, ip: primary.address, cidr: primary.cidr, prefix: primary.netmaskBits, mask: maskOf(primary.netmaskBits), mac: primary.mac, vendor: vendor(primary.mac) },
    interfaces: ifs, ipv6: ipv6(), wifi: wf,
    gateway: gw && { ip: gw.ip, mac: gwMac, vendor: vendor(gwMac), pingMs: gwPing, onSubnet: !!primary && sameNet(gw.ip, primary.cidr) },
    dns: { servers: dnsTests, domain: (lease && lease.domain) || searchDomain() },
    dhcp: { lease, servers: dhcpServers, scanError: offers && offers.error },
    internet: inet, wan: pub ? { ...pub, ipv6: pub6 } : (pub6 ? { ipv6: pub6 } : null), router: rw,
  };
  out.flags = flags(out);
  return out;
}

const maskOf = (bits) => net.intToIp(bits ? (~0 << (32 - bits)) >>> 0 : 0);
function sameNet(ip, cidr) { const [b, bits] = cidr.split('/'); const m = bits === '0' ? 0 : (~0 << (32 - Number(bits))) >>> 0; return ((net.ipToInt(ip) & m) >>> 0) === ((net.ipToInt(b) & m) >>> 0); }
function searchDomain() { try { return (fs.readFileSync('/etc/resolv.conf', 'utf8').match(/^(?:search|domain)\s+(\S+)/m) || [])[1] || ''; } catch { return ''; } }

// Plain-English warnings, worst first. level: bad | warn | info
function flags(n) {
  const f = [];
  if (!n.self) f.push({ level: 'bad', title: 'Not on a network', text: 'This scanner has no IPv4 address. Check the cable or Wi-Fi.' });
  if (n.self && !n.gateway) f.push({ level: 'bad', title: 'No gateway', text: 'There is no default route, so nothing can reach the internet. Check the router / DHCP settings.' });
  if (n.gateway && !n.gateway.onSubnet) f.push({ level: 'bad', title: 'Gateway outside the subnet', text: `The gateway ${n.gateway.ip} is not inside ${n.self && n.self.cidr}. The mask or gateway is set wrong.` });
  if (n.gateway && n.gateway.pingMs == null) f.push({ level: 'info', title: 'Gateway does not answer ping', text: 'Some routers block ping. Only a problem if the internet is also down.' });
  if (n.internet && !n.internet.online) f.push({ level: 'bad', title: 'No internet', text: 'Could not reach Cloudflare or Google. Check the router WAN / ISP line.' });
  if (n.internet && n.internet.online && !n.internet.dnsWorks) f.push({ level: 'bad', title: 'Internet up but names fail', text: 'Addresses reach the internet but DNS look-ups fail. Check the DNS servers below.' });
  if (n.internet && n.internet.captivePortal) f.push({ level: 'warn', title: 'Captive portal / filtering', text: 'A web check was intercepted: hotel-style login page, guest network or web filter in the way.' });
  if (n.internet && n.internet.latencyMs > 80) f.push({ level: 'warn', title: 'Slow internet response', text: `${n.internet.latencyMs} ms to the nearest big server. Expect lag on streaming and remote access.` });
  for (const d of (n.dns && n.dns.servers) || []) if (!d.ok) f.push({ level: 'warn', title: `DNS ${d.server} not answering`, text: 'Devices given this DNS server will be slow or fail to load anything. Fix it in the router DHCP settings.' });
  const ds = (n.dhcp && n.dhcp.servers) || [];
  if (ds.length > 1) f.push({ level: 'bad', title: `${ds.length} DHCP servers answering`, text: `${ds.map((d) => d.server || d.from).join(' and ')} are both handing out addresses. Turn DHCP off on one (often the ISP box or a second router). Devices will get random settings until then.` });
  if (n.router && n.router.wanIp && (PRIVATE(n.router.wanIp) || CGNAT(n.router.wanIp))) f.push({ level: 'warn', title: CGNAT(n.router.wanIp) ? 'Carrier-grade NAT' : 'Double NAT', text: CGNAT(n.router.wanIp) ? `The router's WAN address ${n.router.wanIp} is a shared ISP address. Port forwarding and some remote access will not work; ask the ISP for a public IP.` : `The router's WAN address ${n.router.wanIp} is private, so there is another router in front (usually the ISP box). Put the ISP box in modem / bridge mode or DMZ the router.` });
  if (n.wan && n.router && n.router.wanIp && !PRIVATE(n.router.wanIp) && !CGNAT(n.router.wanIp) && n.wan.ip && n.wan.ip !== n.router.wanIp) f.push({ level: 'info', title: 'Traffic leaves by a different IP', text: `The router says ${n.router.wanIp} but the internet sees ${n.wan.ip}: a VPN, load balancer or second line is in use.` });
  if (n.wifi && n.wifi.signalUnit === 'dBm' && n.wifi.signal < -70) f.push({ level: 'warn', title: 'Weak Wi-Fi here', text: `${n.wifi.signal} dBm. Results may miss devices; move closer or plug in.` });
  if (n.wifi && n.wifi.signalUnit === '%' && n.wifi.signal < 40) f.push({ level: 'warn', title: 'Weak Wi-Fi here', text: `${n.wifi.signal}% signal. Results may miss devices; move closer or plug in.` });
  if (n.self && n.self.ip.startsWith('169.254.')) f.push({ level: 'bad', title: 'Self-assigned address', text: 'No DHCP server answered this device.' });
  return f;
}

module.exports = { netinfo, speedtest, flags, dhcpDiscover, routerWan };
