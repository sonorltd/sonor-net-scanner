'use strict';
// Listen-and-ask discovery: mDNS/Bonjour, SSDP/UPnP, Control4 SDDP, Ubiquiti, ONVIF (WS-Discovery),
// AMX/Global Caché beacons and NetBIOS names. Every function resolves to a Map keyed by IP.
// No dependencies, no root needed. Node 18+.
const dgram = require('dgram');
const { httpGet } = require('./net');
const { normMac } = require('./oui');

function udp(opts = {}) {
  try { return dgram.createSocket({ type: 'udp4', reuseAddr: true, ...opts }); } catch { return null; }
}
const closeQuiet = (s) => { try { s.close(); } catch {} };
const add = (map, ip, fn) => { const e = map.get(ip) || {}; fn(e); map.set(ip, e); };

// ── DNS wire format (enough for mDNS) ───────────────────────────────────────
function encName(name) {
  return Buffer.concat([...name.replace(/\.$/, '').split('.').map((l) => { const b = Buffer.from(l, 'utf8'); return Buffer.concat([Buffer.from([b.length]), b]); }), Buffer.from([0])]);
}
function dnsQuery(names, type = 12, unicast = true) {
  const head = Buffer.from([0, 0, 0, 0, 0, names.length, 0, 0, 0, 0, 0, 0]);
  head.writeUInt16BE(names.length, 4);
  return Buffer.concat([head, ...names.map((n) => Buffer.concat([encName(n), Buffer.from([0, type, unicast ? 0x80 : 0, 1])]))]);
}
function readName(buf, off, depth = 0) {
  const labels = []; let jumped = false; let end = off;
  while (off < buf.length && depth < 20) {
    const len = buf[off];
    if (len === 0) { off++; break; }
    if ((len & 0xc0) === 0xc0) {
      if (!jumped) end = off + 2;
      off = ((len & 0x3f) << 8) | buf[off + 1]; jumped = true; depth++; continue;
    }
    labels.push(buf.slice(off + 1, off + 1 + len).toString('utf8')); off += len + 1;
  }
  return [labels.join('.'), jumped ? end : off];
}
function parseDns(buf) {
  const recs = [];
  try {
    const qd = buf.readUInt16BE(4); const n = buf.readUInt16BE(6) + buf.readUInt16BE(8) + buf.readUInt16BE(10);
    let off = 12;
    for (let i = 0; i < qd; i++) { off = readName(buf, off)[1] + 4; }
    for (let i = 0; i < n && off < buf.length; i++) {
      const [name, o2] = readName(buf, off); off = o2;
      const type = buf.readUInt16BE(off); const len = buf.readUInt16BE(off + 8); off += 10;
      const rd = buf.slice(off, off + len); let data = null;
      if (type === 1 && len === 4) data = [...rd].join('.');
      else if (type === 12) data = readName(buf, off)[0];
      else if (type === 33) data = { port: rd.readUInt16BE(4), target: readName(buf, off + 6)[0] };
      else if (type === 16) {
        data = {}; let p = 0;
        while (p < rd.length) { const l = rd[p]; const s = rd.slice(p + 1, p + 1 + l).toString('utf8'); p += l + 1; if (!s) continue; const eq = s.indexOf('='); if (eq > 0) data[s.slice(0, eq).toLowerCase()] = s.slice(eq + 1); else data[s.toLowerCase()] = true; }
      }
      if (data !== null) recs.push({ name, type, data });
      off += len;
    }
  } catch { /* truncated packet: keep what we have */ }
  return recs;
}

// Service types worth asking for by name (many devices don't answer the enumeration query).
const MDNS_TYPES = [
  '_airplay._tcp', '_raop._tcp', '_companion-link._tcp', '_mediaremotetv._tcp', '_touch-able._tcp', '_hap._tcp', '_homekit._tcp',
  '_sonos._tcp', '_spotify-connect._tcp', '_googlecast._tcp', '_androidtvremote2._tcp', '_amzn-wplay._tcp', '_lutron._tcp', '_leap._tcp',
  '_http._tcp', '_https._tcp', '_ipp._tcp', '_ipps._tcp', '_printer._tcp', '_pdl-datastream._tcp', '_uscan._tcp', '_smb._tcp', '_afpovertcp._tcp',
  '_ssh._tcp', '_device-info._tcp', '_workstation._tcp', '_hue._tcp', '_matter._tcp', '_matterc._udp', '_meshcop._udp', '_rdk-rics._tcp',
  '_plexmediasvr._tcp', '_axis-video._tcp', '_rtsp._tcp', '_shelly._tcp', '_bond._tcp', '_kizbox._tcp', '_kizboxdev._tcp', '_ihsp._tcp', '_sonor-rf._tcp', '_sonor-zb._tcp', '_rdmnet._tcp', '_sonor-node._tcp', '_esphomelib._tcp', '_home-assistant._tcp', '_daap._tcp',
  '_musc._tcp', '_bluos._tcp', '_tidalconnect._tcp', '_heos-audio._tcp', '_nanoleafapi._tcp', '_elg._tcp', '_sleep-proxy._udp',
  '_nvstream._tcp', '_qdiscover._tcp', '_rfb._tcp', '_adisk._tcp', '_ewelink._tcp', '_miio._udp', '_dyson_mqtt._tcp',
];

// Ask the LAN for Bonjour services. Returns Map(ip → { hostname, services:[{type,name,port,txt}] }).
function mdns(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const found = new Map();
    const recs = []; // [rinfoIp, record]
    const socks = [];
    const onMsg = (msg, rinfo) => { if (rinfo.port !== 5353 && rinfo.port === undefined) return; for (const r of parseDns(msg)) recs.push([rinfo.address, r]); };
    // 1) ephemeral port, QU bit → unicast answers straight back
    const a = udp(); if (a) { a.on('error', () => {}); a.on('message', onMsg); socks.push(a); }
    // 2) also listen on 5353 for multicast answers (shared with avahi / mDNSResponder)
    const b = udp();
    if (b) {
      b.on('error', () => {}); b.on('message', onMsg); socks.push(b);
      try { b.bind(5353, () => { try { b.addMembership('224.0.0.251'); } catch {} }); } catch {}
    }
    const typeNames = new Set(MDNS_TYPES.map((t) => t + '.local'));
    const ask = (names) => { if (!a) return; for (let i = 0; i < names.length; i += 12) a.send(dnsQuery(names.slice(i, i + 12)), 5353, '224.0.0.251', () => {}); };
    if (a) {
      a.bind(0, () => {
        ask(['_services._dns-sd._udp.local']);
        ask([...typeNames]);
        // second round: any service types learnt from the enumeration
        setTimeout(() => {
          const extra = recs.filter(([, r]) => r.name === '_services._dns-sd._udp.local' && r.type === 12).map(([, r]) => r.data).filter((t) => !typeNames.has(t));
          if (extra.length) ask([...new Set(extra)]);
          ask([...typeNames]); // repeat: mDNS is lossy
        }, 1200);
      });
    }
    setTimeout(() => {
      socks.forEach(closeQuiet);
      const aRec = new Map(); // host.local → ip
      for (const [, r] of recs) if (r.type === 1) aRec.set(r.name.toLowerCase(), r.data);
      const srv = new Map(); const txt = new Map(); const owner = new Map();
      for (const [ip, r] of recs) {
        if (r.type === 33) { srv.set(r.name, r.data); owner.set(r.name, ip); }
        if (r.type === 16) { txt.set(r.name, { ...(txt.get(r.name) || {}), ...r.data }); if (!owner.has(r.name)) owner.set(r.name, ip); }
        if (r.type === 12 && !r.name.startsWith('_services') && !r.name.endsWith('arpa')) { if (!owner.has(r.data)) owner.set(r.data, ip); }
      }
      const instances = new Set([...srv.keys(), ...txt.keys(), ...recs.filter(([, r]) => r.type === 12 && !r.name.startsWith('_services') && !r.name.endsWith('arpa')).map(([, r]) => r.data)]);
      for (const inst of instances) {
        const m = inst.match(/^(.*?)\.(_[^.]+\._(tcp|udp))\.local$/);
        if (!m) continue;
        const s = srv.get(inst);
        const ip = (s && aRec.get(String(s.target).toLowerCase())) || owner.get(inst);
        if (!ip || ip.startsWith('127.')) continue;
        add(found, ip, (e) => {
          e.services = e.services || [];
          if (s && s.target && !e.hostname) e.hostname = s.target.replace(/\.local$/, '');
          if (!e.services.find((x) => x.type === m[2] && x.name === m[1])) e.services.push({ type: m[2], name: m[1], port: s ? s.port : null, txt: txt.get(inst) || {} });
        });
      }
      for (const [host, ip] of aRec) add(found, ip, (e) => { if (!e.hostname) e.hostname = host.replace(/\.local$/, ''); });
      resolve(found);
    }, timeoutMs);
  });
}

// Reverse name via unicast mDNS straight to the host (Apple, Linux/avahi, many IoT answer).
function mdnsReverse(ip, timeoutMs = 900) {
  return new Promise((resolve) => {
    const s = udp(); if (!s) return resolve(null);
    const done = (v) => { closeQuiet(s); resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    s.on('error', () => { clearTimeout(t); done(null); });
    s.on('message', (msg) => { const r = parseDns(msg).find((x) => x.type === 12); if (r) { clearTimeout(t); done(String(r.data).replace(/\.local\.?$/, '')); } });
    s.bind(0, () => s.send(dnsQuery([ip.split('.').reverse().join('.') + '.in-addr.arpa'], 12, true), 5353, ip, () => {}));
  });
}

// ── SSDP / UPnP ─────────────────────────────────────────────────────────────
function ssdp(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const found = new Map();
    const s = udp(); if (!s) return resolve(found);
    s.on('error', () => { closeQuiet(s); resolve(found); });
    s.on('message', (msg, rinfo) => {
      const text = msg.toString();
      const get = (h) => ((text.match(new RegExp(`^${h}:[ \\t]*(.*)$`, 'im')) || [])[1] || '').trim();
      add(found, rinfo.address, (e) => {
        e.server = e.server || get('SERVER');
        e.locations = e.locations || [];
        const loc = get('LOCATION'); if (loc && !e.locations.includes(loc)) e.locations.push(loc);
        e.st = e.st || []; const st = get('ST'); if (st && !e.st.includes(st)) e.st.push(st);
        e.usn = e.usn || get('USN');
      });
    });
    s.bind(0, () => {
      for (const st of ['ssdp:all', 'upnp:rootdevice', 'urn:dial-multiscreen-org:service:dial:1', 'roku:ecp']) {
        const m = Buffer.from(`M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: ${st}\r\nUSER-AGENT: SonorNetScan/1.0 UPnP/1.1\r\n\r\n`);
        s.send(m, 1900, '239.255.255.250', () => {});
        setTimeout(() => { try { s.send(m, 1900, '239.255.255.250', () => {}); } catch {} }, 900);
      }
    });
    setTimeout(() => { closeQuiet(s); resolve(found); }, timeoutMs);
  });
}

// Fetch a UPnP device description and pull out the useful fields.
async function upnpDescription(location) {
  const r = await httpGet(location, { timeoutMs: 2500 });
  if (!r || r.status !== 200 || !r.body) return null;
  const xml = r.body;
  const tag = (t) => ((xml.match(new RegExp(`<(?:\\w+:)?${t}>([^<]*)</(?:\\w+:)?${t}>`, 'i')) || [])[1] || '').trim();
  const d = {
    friendlyName: tag('friendlyName'), manufacturer: tag('manufacturer'), modelName: tag('modelName'), modelNumber: tag('modelNumber'),
    modelDescription: tag('modelDescription'), serial: tag('serialNumber'), udn: tag('UDN'), deviceType: tag('deviceType'),
    firmware: tag('softwareVersion') || tag('displayVersion') || tag('firmwareVersion') || tag('X_FirmwareVersion') || tag('swVersion') || tag('ProductVersion'),
    roomName: tag('roomName'), presentationURL: tag('presentationURL'), macAddress: normMac(tag('MACAddress') || tag('macAddress')),
    location,
  };
  for (const k of Object.keys(d)) if (!d[k]) delete d[k];
  return d;
}

// ── Control4 SDDP (Simple Device Discovery Protocol, UDP 1902) ─────────────
// Controllers, Control4 hardware and SDDP-certified third-party kit (Araknis, Triad, Episode, Binary,
// WattBox, Luma, many TVs/AVRs) answer with Type / Manufacturer / Model / Driver / Primary-Proxy.
function sddp(localIps = [], timeoutMs = 3500) {
  return new Promise((resolve) => {
    const found = new Map();
    const parse = (msg, rinfo) => {
      const text = msg.toString('latin1');
      if (!/^(SDDP\/1\.0|NOTIFY)/.test(text)) return;
      const h = {};
      for (const line of text.split(/\r?\n/)) { const m = line.match(/^([\w-]+):\s*"?(.*?)"?\s*$/); if (m) h[m[1].toLowerCase()] = m[2]; }
      const ip = ((h.from || '').split(':')[0]) || rinfo.address;
      if (/^NOTIFY\s+OFFLINE/.test(text)) return;
      add(found, ip, (e) => Object.assign(e, {
        host: h.host || e.host, type: h.type || e.type, manufacturer: h.manufacturer || e.manufacturer, model: h.model || e.model,
        driver: h.driver || e.driver, primaryProxy: h['primary-proxy'] || e.primaryProxy, proxies: h.proxies || e.proxies,
      }));
    };
    const socks = [];
    const a = udp(); if (a) { a.on('error', () => {}); a.on('message', parse); socks.push(a); }
    const b = udp(); // NOTIFY ALIVE announcements
    if (b) { b.on('error', () => {}); b.on('message', parse); socks.push(b); try { b.bind(1902, () => { try { b.addMembership('239.255.255.250'); } catch {} }); } catch {} }
    if (a) a.bind(0, () => {
      const from = localIps[0] || '0.0.0.0';
      const m = Buffer.from(`SEARCH * SDDP/1.0\r\nFrom: "${from}:1902"\r\nHost: "sonor-netscan"\r\nType: "*"\r\n\r\n`);
      a.send(m, 1902, '239.255.255.250', () => {});
      setTimeout(() => { try { a.send(m, 1902, '239.255.255.250', () => {}); } catch {} }, 1000);
    });
    setTimeout(() => { socks.forEach(closeQuiet); resolve(found); }, timeoutMs);
  });
}

// ── Ubiquiti discovery (UDP 10001): UniFi APs / switches / gateways, airMAX ─
function ubiquiti(broadcasts = ['255.255.255.255'], timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    const s = udp(); if (!s) return resolve(found);
    s.on('error', () => { closeQuiet(s); resolve(found); });
    s.on('message', (msg, rinfo) => {
      if (msg.length < 4 || msg[0] !== 1 || msg[1] !== 0) return;
      const e = {}; let p = 4;
      while (p + 3 <= msg.length) {
        const t = msg[p]; const l = msg.readUInt16BE(p + 1); const v = msg.slice(p + 3, p + 3 + l); p += 3 + l;
        if (t === 0x01 && l === 6) e.mac = normMac(v.toString('hex'));
        else if (t === 0x02 && l === 10) e.mac = e.mac || normMac(v.slice(0, 6).toString('hex'));
        else if (t === 0x03) e.firmware = v.toString();
        else if (t === 0x0b) e.hostname = v.toString();
        else if (t === 0x0c) e.modelShort = v.toString();
        else if (t === 0x14) e.model = v.toString();
        else if (t === 0x0d) e.essid = v.toString();
      }
      if (!e.model) e.model = e.modelShort;
      found.set(rinfo.address, e);
    });
    s.bind(0, () => {
      try { s.setBroadcast(true); } catch {}
      for (const b of broadcasts) s.send(Buffer.from([1, 0, 0, 0]), 10001, b, () => {});
    });
    setTimeout(() => { closeQuiet(s); resolve(found); }, timeoutMs);
  });
}

// ── Heatmiser neoHub (UDP 19790): broadcast "hubseek", the hub answers hubseek{"ip":…,"device_id":<mac>} (research disc.neohub).
// Finds the hub even when its legacy TCP API (4242) is switched off.
function neohub(broadcasts = ['255.255.255.255'], timeoutMs = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    const s = udp(); if (!s) return resolve(found);
    s.on('error', () => { closeQuiet(s); resolve(found); });
    s.on('message', (msg, rinfo) => {
      const t = msg.toString(); if (!t.startsWith('hubseek') || t.trim() === 'hubseek') return;
      let j = {}; try { j = JSON.parse(t.slice(7)); } catch {}
      found.set(j.ip || rinfo.address, { mac: normMac(String(j.device_id || '').replace(/[^0-9a-f]/gi, '')), raw: t.slice(0, 200) });
    });
    s.bind(0, () => { try { s.setBroadcast(true); } catch {} for (const b of broadcasts) s.send(Buffer.from('hubseek'), 19790, b, () => {}); });
    setTimeout(() => { closeQuiet(s); resolve(found); }, timeoutMs);
  });
}

// ── ONVIF WS-Discovery (UDP 3702): IP cameras and NVRs ─────────────────────
function onvif(timeoutMs = 3000) {
  return new Promise((resolve) => {
    const found = new Map();
    const s = udp(); if (!s) return resolve(found);
    s.on('error', () => { closeQuiet(s); resolve(found); });
    s.on('message', (msg, rinfo) => {
      const x = msg.toString();
      const scopes = ((x.match(/<[^>]*Scopes[^>]*>([^<]*)</) || [])[1] || '').split(/\s+/);
      const sc = (k) => decodeURIComponent((scopes.find((u) => u.includes(`/${k}/`)) || '').split(`/${k}/`)[1] || '');
      found.set(rinfo.address, { name: sc('name'), hardware: sc('hardware'), mac: normMac(sc('MAC') || sc('mac')), xaddrs: ((x.match(/<[^>]*XAddrs>([^<]*)</) || [])[1] || '').trim() });
    });
    s.bind(0, () => {
      const id = 'uuid:' + require('crypto').randomUUID();
      const probe = `<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl"><e:Header><w:MessageID>${id}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To><w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header><e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
      s.send(Buffer.from(probe), 3702, '239.255.255.250', () => {});
    });
    setTimeout(() => { closeQuiet(s); resolve(found); }, timeoutMs);
  });
}

// ── AMX Device Discovery beacons (Global Caché iTach / GC-100, AMX, some Extron) ─
function amxBeacon(timeoutMs = 4000) {
  return new Promise((resolve) => {
    const found = new Map();
    const s = udp(); if (!s) return resolve(found);
    s.on('error', () => { closeQuiet(s); resolve(found); });
    s.on('message', (msg, rinfo) => {
      const t = msg.toString('latin1'); if (!t.startsWith('AMXB')) return;
      const kv = {}; for (const m of t.matchAll(/<-([\w-]+)=([^>]*)>/g)) kv[m[1].toLowerCase()] = m[2];
      found.set(rinfo.address, { make: kv.make, model: kv.model, firmware: kv.revision || kv['pkg_level'], uuid: kv.uuid, config: kv['config-url'] });
    });
    try { s.bind(9131, () => { try { s.addMembership('239.255.250.250'); } catch {} }); } catch { closeQuiet(s); return resolve(found); }
    setTimeout(() => { closeQuiet(s); resolve(found); }, timeoutMs);
  });
}

// ── NetBIOS name (UDP 137): Windows PCs, NAS boxes, some printers ───────────
function netbios(ip, timeoutMs = 900) {
  return new Promise((resolve) => {
    const s = udp(); if (!s) return resolve(null);
    const done = (v) => { closeQuiet(s); resolve(v); };
    const t = setTimeout(() => done(null), timeoutMs);
    s.on('error', () => { clearTimeout(t); done(null); });
    s.on('message', (msg) => {
      clearTimeout(t);
      try {
        let off = 12; off = readName(msg, off)[1] + 10; // answer name + type/class/ttl/rdlength
        const n = msg[off]; off++;
        let name = null; let group = null;
        for (let i = 0; i < n; i++) {
          const nm = msg.slice(off, off + 15).toString('latin1').trim(); const suf = msg[off + 15]; const flags = msg.readUInt16BE(off + 16); off += 18;
          if (suf === 0 && !(flags & 0x8000) && !name) name = nm;
          if (suf === 0 && (flags & 0x8000) && !group) group = nm;
        }
        const mac = normMac(msg.slice(off, off + 6).toString('hex'));
        done({ name, group, mac: mac === '00:00:00:00:00:00' ? '' : mac });
      } catch { done(null); }
    });
    const q = Buffer.concat([Buffer.from([0x13, 0x37, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0x20]), Buffer.from('CK' + 'A'.repeat(30)), Buffer.from([0, 0, 0x21, 0, 1])]);
    s.bind(0, () => s.send(q, 137, ip, () => {}));
  });
}


// ── Hikvision SADP (UDP 37020, 239.255.255.250): cameras, NVRs, door stations, even un-activated or on the
//    wrong subnet. Each answer says model, serial, firmware, MAC, its own IP / mask / gateway and DHCP on/off.
function sadp(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const found = new Map();
    const tag = (x, k) => { const m = x.match(new RegExp(`<${k}>([^<]*)</${k}>`, 'i')); return m ? m[1].trim() : ''; };
    const parse = (msg, rinfo) => {
      const x = msg.toString('utf8');
      if (!/<ProbeMatch>/i.test(x)) return;
      const ip = tag(x, 'IPv4Address') || rinfo.address;
      const dhcp = tag(x, 'DHCP');
      const prev = found.get(ip); const mac = normMac(tag(x, 'MAC'));
      const otherMacs = prev && prev.mac && mac && prev.mac !== mac ? [...new Set([...(prev.otherMacs || []), prev.mac])] : (prev && prev.otherMacs) || undefined;
      found.set(ip, { otherMacs,
        model: tag(x, 'DeviceDescription') || tag(x, 'DeviceType'), deviceType: tag(x, 'DeviceType'), serial: tag(x, 'DeviceSN'),
        mac: normMac(tag(x, 'MAC')), mask: tag(x, 'IPv4SubnetMask'), gateway: tag(x, 'IPv4Gateway'),
        dhcp: dhcp ? /true/i.test(dhcp) : null, firmware: [tag(x, 'SoftwareVersion'), tag(x, 'DSPVersion')].filter(Boolean).join(' · '),
        httpPort: Number(tag(x, 'HttpPort')) || null, commandPort: Number(tag(x, 'CommandPort')) || null,
        activated: tag(x, 'Activated') ? /true/i.test(tag(x, 'Activated')) : null, from: rinfo.address,
      });
    };
    const s = udp(); if (!s) return resolve(found);
    s.on('error', () => {}); s.on('message', parse);
    try {
      s.bind(37020, () => {
        try { s.addMembership('239.255.255.250'); } catch {}
        const probe = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Probe><Uuid>${require('crypto').randomUUID().toUpperCase()}</Uuid><Types>inquiry</Types></Probe>`);
        s.send(probe, 37020, '239.255.255.250', () => {});
        setTimeout(() => { try { s.send(probe, 37020, '239.255.255.250', () => {}); } catch {} }, 1200);
      });
    } catch { closeQuiet(s); return resolve(found); }
    setTimeout(() => { closeQuiet(s); resolve(found); }, timeoutMs);
  });
}

// ── Dahua DHIP discovery (UDP 37810 multicast + 5050 broadcast): Dahua cameras / NVRs and OEMs (Lorex, Amcrest…) ─
function dahua(timeoutMs = 3500) {
  return new Promise((resolve) => {
    const found = new Map();
    const parse = (msg, rinfo) => {
      const i = msg.indexOf('{'); if (i < 0 || msg.indexOf('DHIP') < 0) return;
      let j; try { j = JSON.parse(msg.slice(i).toString('utf8').replace(/\0+$/, '')); } catch { return; }
      const d = j && j.params && j.params.deviceInfo; if (!d) return;
      const v4 = d.IPv4Address || {};
      const ip = v4.IPAddress || rinfo.address;
      const prev = found.get(ip); const mac = normMac(d.Mac || '');
      const otherMacs = prev && prev.mac && mac && prev.mac !== mac ? [...new Set([...(prev.otherMacs || []), prev.mac])] : (prev && prev.otherMacs) || undefined;
      found.set(ip, { otherMacs, model: d.DeviceType || d.DetailType || '', deviceClass: d.DeviceClass || '', serial: d.SerialNo || '', mac: normMac(d.Mac || ''),
        mask: v4.SubnetMask || '', gateway: v4.DefaultGateway || '', dhcp: typeof v4.DhcpEnable === 'boolean' ? v4.DhcpEnable : null,
        firmware: d.Version || '', vendor: d.Vendor || '', httpPort: d.HttpPort || null, from: rinfo.address });
    };
    const json = Buffer.from(JSON.stringify({ method: 'DHDiscover.search', params: { mac: '', uni: 1 } }) + '\n');
    const head = Buffer.alloc(32); head.writeUInt32LE(0x20, 0); head.write('DHIP', 4, 'latin1'); head.writeUInt32LE(json.length, 16); head.writeUInt32LE(json.length, 24);
    const pkt = Buffer.concat([head, json]);
    const socks = [];
    const a = udp(); // listens where Dahua kit answers (the group)
    if (a) { a.on('error', () => {}); a.on('message', parse); socks.push(a); try { a.bind(37810, () => { try { a.addMembership('239.255.255.251'); } catch {} a.send(pkt, 37810, '239.255.255.251', () => {}); }); } catch {} }
    const b = udp(); // broadcast ask; some models answer unicast to the sender
    if (b) { b.on('error', () => {}); b.on('message', parse); socks.push(b); b.bind(0, () => { try { b.setBroadcast(true); } catch {} b.send(pkt, 5050, '255.255.255.255', () => {}); }); }
    setTimeout(() => { socks.forEach(closeQuiet); resolve(found); }, timeoutMs);
  });
}

module.exports = { neohub, sadp, dahua, mdns, mdnsReverse, ssdp, upnpDescription, sddp, ubiquiti, onvif, amxBeacon, netbios, parseDns, dnsQuery, MDNS_TYPES };
