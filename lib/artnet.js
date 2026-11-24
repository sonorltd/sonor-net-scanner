// Art-Net + sACN discovery for the scanner's Art-Net tab (v1.6.9). Simple discovery and node info only:
// full DMX testing lives in the separate Sonor Art-Net app. The packet codec here is a stop-gap until the shared
// ~/Code/Sonor/sonor-artnet.js (owned by the Art-Net app thread) lands; then parsePollReply / parseSacn come from there.
//
// Art-Net 4: ArtPoll is broadcast to UDP 6454 and every node answers ArtPollReply to port 6454 (one reply per bind index,
// i.e. per group of 4 ports), so the listener must own 6454. ArtDmx seen on the wire while listening tells us who is
// sending which universe, and whether the console is broadcasting (bad on Wi-Fi).
// sACN (E1.31): sources announce their universes every 10 s on universe 64214 (239.255.250.214:5568), so listening 11 s
// finds every sACN source and its universe list without joining 63,999 groups.
'use strict';
const dgram = require('dgram');

const ARTNET_PORT = 6454, SACN_PORT = 5568, SACN_DISCOVERY = '239.255.250.214';
const HDR = Buffer.from('Art-Net\0', 'latin1');
const OP = { poll: 0x2000, pollReply: 0x2100, dmx: 0x5000, sync: 0x5200, tod: 0x8100, rdm: 0x8300 };
const PROTOCOL = ['DMX512', 'MIDI', 'Avab', 'Colortran CMX', 'ADB 62.5', 'Art-Net', 'DALI'];
const STYLE = ['Node', 'Controller', 'Media server', 'Route', 'Backup', 'Config tool', 'Visualiser'];

// A short ESTA manufacturer list for brands seen on Sonor jobs (full list: tsp.esta.org). Codes are 16-bit hex.
const ESTA = { 0x0000: 'ESTA (prototype)', 0x414c: 'Artistic Licence', 0x4144: 'ADJ', 0x454e: 'ENTTEC', 0x4348: 'Chauvet', 0x4d41: 'MA Lighting', 0x5052: 'PR Lighting',
  0x524f: 'Robe', 0x534c: 'Strand', 0x4c55: 'Luminex', 0x4f4c: 'Obsidian / Elation', 0x434d: 'City Theatrical', 0x484d: 'High End', 0x4d50: 'Martin', 0x5041: 'Pathway',
  0x4554: 'ETC', 0x4442: 'DMXking', 0x4153: 'Ayrton', 0x4750: 'GLP', 0x4c42: 'LightBridge', 0x5357: 'Swisson', 0x4f53: 'Ostrich' };

const str = (b, a, n) => b.toString('latin1', a, a + n).replace(/\0[\s\S]*$/, '').trim();
const ip4 = (b, a) => `${b[a]}.${b[a + 1]}.${b[a + 2]}.${b[a + 3]}`;
const mac = (b, a) => [...b.slice(a, a + 6)].map((x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase();
const isArt = (b) => b.length >= 12 && b.compare(HDR, 0, 8, 0, 8) === 0;
const opOf = (b) => b.readUInt16LE(8);

function buildPoll() {   // ArtPoll, Art-Net 4
  const b = Buffer.alloc(14); HDR.copy(b, 0); b.writeUInt16LE(OP.poll, 8); b[10] = 0; b[11] = 14; b[12] = 0x02; b[13] = 0x10; return b;   // flags bit 1: reply on change (an.poll.flags)
}
function parsePollReply(b) {
  if (!isArt(b) || opOf(b) !== OP.pollReply || b.length < 207) return null;
  const net = b[18] & 0x7f, sub = b[19] & 0x0f; const n = Math.min(4, b.readUInt16BE(172)); const ports = [];
  for (let i = 0; i < n; i++) { const t = b[174 + i]; const out = !!(t & 0x80), inp = !!(t & 0x40); if (!out && !inp) continue;
    const swOut = b[190 + i] & 0x0f, swIn = b[186 + i] & 0x0f;
    ports.push({ n: i + 1, protocol: PROTOCOL[t & 0x3f] || 'other', output: out, input: inp,
      outUniverse: out ? (net << 8) | (sub << 4) | swOut : null, inUniverse: inp ? (net << 8) | (sub << 4) | swIn : null,
      outData: out ? !!(b[182 + i] & 0x80) : false, inData: inp ? !!(b[178 + i] & 0x80) : false, outMerging: out ? !!(b[182 + i] & 0x08) : false,
      outSacn: out && b.length > 213 ? !!(b[182 + i] & 0x01) : false });
  }
  const oem = b.readUInt16BE(20), esta = b.readUInt16LE(24), status1 = b[23], status2 = b.length > 212 ? b[212] : 0;
  return { ip: ip4(b, 10), port: b.readUInt16LE(14), firmware: `${b[16]}.${b[17]}`, net, sub, oem: '0x' + oem.toString(16).padStart(4, '0'),
    esta: '0x' + esta.toString(16).padStart(4, '0'), maker: ESTA[esta] || '', shortName: str(b, 26, 18), longName: str(b, 44, 64), report: str(b, 108, 64),
    ports, style: STYLE[b[200]] || 'Node', mac: b.length >= 207 ? mac(b, 201) : '', bindIp: b.length >= 211 ? ip4(b, 207) : '', bindIndex: b.length > 211 ? b[211] : 0,
    rdm: !!(status1 & 0x02), indicator: ['unknown', 'locate', 'mute', 'normal'][(status1 >> 6) & 3], webConfig: !!(status2 & 0x01), dhcp: !!(status2 & 0x02), dhcpCapable: !!(status2 & 0x04), artnet3: !!(status2 & 0x08) };
}
function parseDmx(b) {   // ArtDmx: who is sending which universe
  if (!isArt(b) || opOf(b) !== OP.dmx || b.length < 18) return null;
  return { seq: b[12], universe: b.readUInt16LE(14) & 0x7fff, length: b.readUInt16BE(16) };
}
// sACN: data packets (root vector 4) and universe discovery (root vector 8, framing 2, discovery 1)
function parseSacn(b) {
  if (b.length < 126 || b.toString('latin1', 4, 13) !== 'ASC-E1.17') return null;
  const root = b.readUInt32BE(18); const cid = b.slice(22, 38).toString('hex'); const source = str(b, 44, 64);
  if (root === 8 && b.readUInt32BE(40) === 2 && b.length >= 120) { const u = []; for (let a = 120; a + 1 < b.length; a += 2) u.push(b.readUInt16BE(a)); return { type: 'discovery', cid, source, page: b[118], last: b[119], universes: u }; }
  if (root === 4) return { type: 'data', cid, source, priority: b[108], seq: b[111], universe: b.readUInt16BE(113), startCode: b[125], slots: Math.max(0, b.readUInt16BE(123) - 1) };
  return null;
}

// ArtAddress (0x6000) with only the command set: locate 0x04 / normal 0x02 (an.address). Unicast to the node.
function buildAddress(command, bindIndex = 0) {
  const b = Buffer.alloc(107); HDR.copy(b, 0); b.writeUInt16LE(0x6000, 8); b[10] = 0; b[11] = 14; b[12] = 0x7f; b[13] = bindIndex;
  for (let i = 96; i < 100; i++) b[i] = 0x7f; for (let i = 100; i < 104; i++) b[i] = 0x7f; b[104] = 0x7f; b[105] = 0x7f; b[106] = command; return b;
}
function locate(ip, on = true, bindIndex = 0) {
  return new Promise((resolve, reject) => { const s = dgram.createSocket('udp4'); s.send(buildAddress(on ? 0x04 : 0x02, bindIndex), ARTNET_PORT, ip, (e) => { try { s.close(); } catch {} e ? reject(e) : resolve({ ok: true }); }); });
}
// Group replies into devices: one per MAC (or IP), ports from every BindIndex (an.reply.multi)
function group(replies) {
  const m = new Map(); for (const r of replies) { const k = r.mac && r.mac !== '00:00:00:00:00:00' ? r.mac : r.ip; const o = m.get(k); if (!o) m.set(k, { ...r, ports: [...r.ports] }); else { const off = o.ports.length; o.ports.push(...r.ports.map((p, i) => ({ ...p, n: off + i + 1 }))); if (r.bindIndex <= 1) Object.assign(o, { ...r, ports: o.ports }); } }
  return [...m.values()];
}
// ArtPoll + listen. Returns { nodes, dmx: [{ src, universe, broadcast, packets }], error? }
function poll({ broadcasts = ['2.255.255.255', '10.255.255.255'], timeoutMs = 3000, locals = [] } = {}) {   // never 255.255.255.255 (an.poll.where)
  return new Promise((resolve) => {
    const nodes = new Map(); const dmx = new Map(); let error = null;
    let s; try { s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { return resolve({ nodes: [], dmx: [], error: e.message }); }
    const t0 = Date.now(); const done = () => { try { s.close(); } catch {} resolve({ nodes: group([...nodes.values()]), dmx: [...dmx.values()].map(({ first, lastAt, last, ...d }) => ({ ...d, hz: Math.round((d.packets / Math.max(0.5, ((lastAt || Date.now()) - t0) / 1000)) * 10) / 10 })), error }); };
    s.on('error', (e) => { error = e.code === 'EADDRINUSE' ? 'UDP 6454 is in use by another Art-Net program on this computer: close it and look again' : e.message; done(); });
    s.on('message', (m, r) => {
      if (!isArt(m)) return; const op = opOf(m);   // ArtDmx reaching this agent was broadcast: the agent is never a subscribed node
      if (op === OP.pollReply) { const n = parsePollReply(m); if (!n || locals.includes(r.address)) return; n.from = r.address; const k = `${n.ip}#${n.bindIndex}`; nodes.set(k, n); }
      else if (op === OP.dmx) { const d = parseDmx(m); if (!d) return; const k = `${r.address}#${d.universe}`; const o = dmx.get(k) || { src: r.address, universe: d.universe, packets: 0, length: d.length, first: Date.now(), seqErr: 0, last: null }; o.packets++; o.lastAt = Date.now();
        if (o.last != null && d.seq && o.last) { const diff = ((d.seq - o.last + 256) % 256); if (diff === 0 || diff > 236) o.seqErr++; } o.last = d.seq; dmx.set(k, o); }
    });
    s.bind(ARTNET_PORT, () => {
      try { s.setBroadcast(true); } catch {}
      const pkt = buildPoll(); for (const b of broadcasts) s.send(pkt, ARTNET_PORT, b, () => {});
      setTimeout(() => { for (const b of broadcasts) s.send(pkt, ARTNET_PORT, b, () => {}); }, 900);   // second poll: a node may miss the first
      setTimeout(done, timeoutMs);
    });
  });
}
// sACN: listen on the discovery universe; returns { sources: [{ cid, source, ip, universes[] }] }
function sacn({ timeoutMs = 11000, iface, universes = [] } = {}) {   // universes: also sniff these (from the nodes' outputs) for priority, Hz and sequence errors
  return new Promise((resolve) => {
    const src = new Map(); let error = null;
    let s; try { s = dgram.createSocket({ type: 'udp4', reuseAddr: true }); } catch (e) { return resolve({ sources: [], error: e.message }); }
    const t0 = Date.now(); const done = () => { try { s.close(); } catch {} const secs = (Date.now() - t0) / 1000; resolve({ sources: [...src.values()].map((o) => ({ ...o, data: Object.fromEntries(Object.entries(o.data).map(([u, d]) => [u, { hz: Math.round((d.packets / secs) * 10) / 10, seqErr: d.seqErr, priority: d.priority, pap: d.pap }])) })), error }); };
    s.on('error', (e) => { error = e.message; done(); });
    s.on('message', (m, r) => { const p = parseSacn(m); if (!p) return; const o = src.get(p.cid) || { cid: p.cid, source: p.source, ip: r.address, universes: [], data: {} };
      if (p.type === 'discovery') o.universes = [...new Set([...o.universes, ...p.universes])].sort((a, b) => a - b);
      else { o.universes = [...new Set([...o.universes, p.universe])].sort((a, b) => a - b); o.priority = p.priority; const d = o.data[p.universe] = o.data[p.universe] || { packets: 0, seqErr: 0, last: null, priority: p.priority, pap: false }; d.packets++; if (p.startCode === 0xdd) d.pap = true;
        if (d.last != null) { const diff = (p.seq - d.last + 256) % 256; if (diff === 0 || diff > 236) d.seqErr++; } d.last = p.seq; }
      src.set(p.cid, o); });
    s.bind(SACN_PORT, () => { for (const u of universes.slice(0, 64)) { try { s.addMembership(`239.255.${(u >> 8) & 255}.${u & 255}`, iface); } catch {} } try { s.addMembership(SACN_DISCOVERY, iface); } catch (e) { error = 'Could not join the sACN discovery group: ' + e.message; } setTimeout(done, timeoutMs); });
  });
}

// Findings: shared with the page (public/data/artnet-faults.js, UMD) so the demo and the Android agent grade the same way
const { flags } = require('../public/data/artnet-faults.js');

module.exports = { buildAddress, locate, group, ARTNET_PORT, SACN_PORT, SACN_DISCOVERY, OP, ESTA, buildPoll, parsePollReply, parseDmx, parseSacn, poll, sacn, flags };
