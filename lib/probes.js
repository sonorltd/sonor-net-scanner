'use strict';
// Per-host probing: open ports, banners and device-specific info pages (model / firmware / serial).
const { tcp, banner, httpGet, pool } = require('./net');
const { normMac } = require('./oui');

// Ports worth checking on an AV / smart-home LAN. Label shown in the page.
const PORTS = {
  21: 'FTP', 22: 'SSH', 23: 'Telnet', 53: 'DNS', 80: 'HTTP', 139: 'NetBIOS', 443: 'HTTPS', 445: 'SMB', 515: 'LPD', 554: 'RTSP',
  631: 'IPP', 1400: 'Sonos', 1443: 'Sonos TLS', 1515: 'Samsung MDC', 1883: 'MQTT', 2001: 'Crestron CIP?', 3001: 'LG webOS',
  3389: 'RDP', 3689: 'DAAP', 4998: 'Global Caché', 4999: 'GC serial', 5000: 'UPnP/NAS', 5020: 'C4 Director', 5021: 'C4 Director TLS',
  5353: 'mDNS', 5900: 'VNC', 6466: 'Android TV remote', 7000: 'AirPlay', 8000: 'Hikvision/HTTP', 8001: 'Samsung TV', 8002: 'Samsung TV TLS',
  8008: 'Chromecast', 8009: 'Cast TLS', 8060: 'Roku', 8080: 'HTTP alt', 8102: 'Pioneer/Onkyo', 8443: 'HTTPS alt', 8750: 'C4 Navigator',
  9090: 'Web alt', 9100: 'Printer', 10001: 'Ubiquiti', 20060: 'Sony?', 23053: 'Lutron Telnet?', 32400: 'Plex', 37777: 'Dahua',
  41794: 'Crestron CIP', 41795: 'Crestron CTP', 49152: 'UPnP', 50001: 'Yamaha?', 52235: 'Samsung UPnP', 55000: 'Panasonic TV',
  60128: 'Onkyo eISCP', 62078: 'iPhone sync',
};
const PORT_LIST = Object.keys(PORTS).map(Number).filter((p) => p !== 5353 && p !== 10001); // UDP ones are discovered elsewhere

// Liveness: any answer (even "refused") on these means the host is there. The attempt also fills the ARP table.
const ALIVE_PORTS = [80, 443, 22, 445, 7000, 62078, 1400, 8080, 554];

async function scanPorts(ip, ports = PORT_LIST, timeoutMs = 700) {
  const open = [];
  await pool(ports, 24, async (p) => { if ((await tcp(ip, p, timeoutMs)) === 'open') open.push(p); });
  return open.sort((a, b) => a - b);
}

const json = (r) => { try { return r && r.status === 200 ? JSON.parse(r.body) : null; } catch { return null; } };
const tag = (xml, t) => ((String(xml || '').match(new RegExp(`<(?:\\w+:)?${t}>([^<]*)</(?:\\w+:)?${t}>`, 'i')) || [])[1] || '').trim();

// Device-specific "who are you" endpoints, run only when the matching port is open.
const FINGERPRINTS = [
  { port: 1400, name: 'sonos', run: async (ip) => {
    const r = await httpGet(`http://${ip}:1400/xml/device_description.xml`);
    if (!r || r.status !== 200) return null;
    const b = r.body;
    return { make: 'Sonos', model: tag(b, 'modelName') || tag(b, 'displayName'), modelCode: tag(b, 'modelNumber'), firmware: tag(b, 'displayVersion') || tag(b, 'softwareVersion'),
      serial: tag(b, 'serialNum'), name: tag(b, 'roomName'), mac: normMac(tag(b, 'MACAddress')), hardware: tag(b, 'hardwareVersion') };
  } },
  { port: 8008, name: 'cast', run: async (ip) => {
    const j = json(await httpGet(`http://${ip}:8008/setup/eureka_info?params=name,build_info,device_info,net`));
    if (!j) return null;
    return { make: (j.device_info && j.device_info.manufacturer) || 'Google Cast', model: (j.device_info && j.device_info.model_name) || 'Chromecast built-in',
      firmware: (j.build_info && (j.build_info.cast_build_revision || j.build_info.system_build_number)) || j.cast_build_revision, name: j.name,
      mac: normMac(j.device_info && j.device_info.mac_address) };
  } },
  { port: 8060, name: 'roku', run: async (ip) => {
    const r = await httpGet(`http://${ip}:8060/query/device-info`);
    if (!r || r.status !== 200) return null;
    const b = r.body;
    return { make: tag(b, 'vendor-name') || 'Roku', model: [tag(b, 'model-name'), tag(b, 'model-number')].filter(Boolean).join(' '), firmware: tag(b, 'software-version'),
      serial: tag(b, 'serial-number'), name: tag(b, 'user-device-name') || tag(b, 'friendly-device-name'), mac: normMac(tag(b, 'ethernet-mac') || tag(b, 'wifi-mac')) };
  } },
  { port: 8001, name: 'samsung', run: async (ip) => {
    const j = json(await httpGet(`http://${ip}:8001/api/v2/`));
    if (!j || !j.device) return null;
    const d = j.device;
    return { make: 'Samsung', model: d.modelName || d.model, firmware: d.firmwareVersion && d.firmwareVersion !== 'Unknown' ? d.firmwareVersion : '', name: d.name,
      mac: normMac(d.wifiMac), kind: 'TV', extra: { os: d.OS, resolution: d.resolution, power: d.PowerState } };
  } },
  { port: 80, name: 'yamaha', run: async (ip) => {
    const j = json(await httpGet(`http://${ip}/YamahaExtendedControl/v1/system/getDeviceInfo`, { timeoutMs: 1500 }));
    if (!j || j.response_code !== 0) return null;
    const n = json(await httpGet(`http://${ip}/YamahaExtendedControl/v1/system/getNameText`, { timeoutMs: 1500 }));
    return { make: 'Yamaha', model: j.model_name, firmware: j.system_version != null ? String(j.system_version) : '', serial: j.serial_number || j.system_id,
      name: n && n.zone_list && n.zone_list[0] && n.zone_list[0].text, kind: 'AV receiver' };
  } },
  { port: 8080, name: 'denon', run: async (ip) => {
    const r = await httpGet(`http://${ip}:8080/goform/Deviceinfo.xml`, { timeoutMs: 1500 });
    if (!r || r.status !== 200 || !/ModelName/i.test(r.body)) return null;
    const b = r.body;
    return { make: /marantz/i.test(b) ? 'Marantz' : 'Denon', model: tag(b, 'ModelName'), firmware: tag(b, 'UpgradeVersion') || tag(b, 'ApiVersion'), mac: normMac(tag(b, 'MacAddress')), kind: 'AV receiver' };
  } },
  { port: 4998, name: 'globalcache', run: async (ip) => {
    const v = await banner(ip, 4998, { send: 'getversion\r', timeoutMs: 1200 });
    const d = await banner(ip, 4998, { send: 'getdevices\r', timeoutMs: 1200 });
    if (!v && !d) return null;
    const mods = String(d || '').split(/\r?\n/).filter((l) => /^device,/.test(l)).map((l) => l.split(',').slice(1).join(' ')).join(' · ');
    return { make: 'Global Caché', model: /IR/.test(mods) ? 'iTach / GC IR' : 'Global Caché', firmware: String(v || '').trim(), kind: 'IR / serial gateway', extra: { modules: mods } };
  } },
  { port: 22, name: 'ssh', run: async (ip) => {
    const b = await banner(ip, 22, { timeoutMs: 1200, max: 128 });
    return b && b.startsWith('SSH-') ? { sshBanner: b.split(/\r?\n/)[0].trim() } : null;
  } },
  { port: 23, name: 'telnet', run: async (ip) => {
    const b = await banner(ip, 23, { timeoutMs: 1500, max: 256 });
    if (!b) return null;
    const clean = b.replace(/[^\x20-\x7e\n]/g, '').trim().split('\n').slice(0, 2).join(' / ');
    const out = { telnetBanner: clean.slice(0, 120) };
    if (/QNET|GNET|login:\s*$/i.test(clean) && /lutron|QNET|GNET/i.test(clean)) Object.assign(out, { make: 'Lutron', kind: 'Lighting processor' });
    return out;
  } },
];

// Web page title + Server header, for HTTP/HTTPS ports.
async function webInfo(ip, port) {
  const proto = [443, 8443, 1443, 8002].includes(port) ? 'https' : 'http';
  const r = await httpGet(`${proto}://${ip}:${port}/`, { timeoutMs: 2000, max: 60000 });
  if (!r) return null;
  const title = ((r.body || '').match(/<title[^>]*>([^<]{1,120})/i) || [])[1];
  const auth = r.headers && r.headers['www-authenticate'];
  return { port, status: r.status, server: (r.headers && r.headers.server) || '', title: title ? title.trim() : '', realm: auth ? ((auth.match(/realm="([^"]*)"/) || [])[1] || '') : '',
    location: (r.headers && r.headers.location) || '' };
}

async function fingerprint(ip, openPorts) {
  const out = { web: [], details: {} };
  const tasks = [];
  for (const f of FINGERPRINTS) if (openPorts.includes(f.port)) tasks.push(f.run(ip).then((r) => { if (r) out.details[f.name] = r; }).catch(() => {}));
  for (const p of openPorts.filter((x) => [80, 443, 8080, 8443, 8000, 9090, 5000].includes(x)).slice(0, 3)) tasks.push(webInfo(ip, p).then((w) => { if (w) out.web.push(w); }).catch(() => {}));
  await Promise.all(tasks);
  return out;
}

module.exports = { PORTS, PORT_LIST, ALIVE_PORTS, scanPorts, fingerprint, webInfo };
