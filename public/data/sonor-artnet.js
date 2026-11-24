/* sonor-artnet.js — Art-Net 4 + sACN (E1.31) + RDM (E1.20) packet codec (v1.0.0, 2026-11-24)
 * Master: ~/Code/Sonor/sonor-artnet.js (owned by the Art-Net Tester, APP - Android Apps/artnet). Copied into each app's
 * data/ folder (Art-Net Tester web/data, Network Scanner public/data). Pure functions, no I/O: works in Node and the browser.
 *
 *   const A = SonorArtNet  (browser global)  |  require('./sonor-artnet.js')  (Node)
 *   A.PORT 6454 · A.SACN_PORT 5568
 *   A.buildPoll()                         → Uint8Array ArtPoll (asks every node to reply)
 *   A.parse(bytes)                        → { op: 'pollreply'|'dmx'|'poll'|'toddata'|'rdm'|'address'|..., ... } or null
 *   A.parsePollReply(bytes)               → node { ip, mac, shortName, longName, report, fw, oem, esta, maker, ports:[…], … }
 *   A.buildDmx(portAddress, data, seq)    → ArtDmx (portAddress 0–32767, data up to 512)
 *   A.buildAddress({...})                 → ArtAddress (rename, re-address, merge mode, Art-Net / sACN, locate LED)
 *   A.buildTodRequest(portAddress) · A.buildTodControl(portAddress, flush) · A.buildRdm(portAddress, rdmBytes)
 *   A.rdm.build({ dest, src, tn, cc, pid, data }) · A.rdm.parse(bytes) · A.rdm.decode(pid, data)
 *   A.sacn.build({ universe, data, seq, priority, cid, source }) · A.sacn.parse(bytes) · A.sacn.group(universe)
 *   A.fmtUniverse(portAddress) → "0:0:1 (U1)" · A.splitPA(pa) → { net, sub, uni }
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SonorArtNet = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const VERSION = '1.0.0';
  const PORT = 6454, SACN_PORT = 5568, PROT = 14;
  const ID = [0x41, 0x72, 0x74, 0x2d, 0x4e, 0x65, 0x74, 0x00]; // "Art-Net\0"
  const OP = { poll: 0x2000, pollreply: 0x2100, diag: 0x2300, cmd: 0x2400, dmx: 0x5000, nzs: 0x5100, sync: 0x5200, address: 0x6000, input: 0x7000,
    todrequest: 0x8000, toddata: 0x8100, todcontrol: 0x8200, rdm: 0x8300, rdmsub: 0x8400, ipprog: 0xf800, ipprogreply: 0xf900 };
  const OPNAME = Object.fromEntries(Object.entries(OP).map(([k, v]) => [v, k]));
  // ArtAddress commands (Art-Net 4 table 3), port 0..3 added to the base
  const AC = { none: 0x00, cancelMerge: 0x01, ledNormal: 0x02, ledMute: 0x03, ledLocate: 0x04, resetRx: 0x05, failHold: 0x08, failZero: 0x09, failFull: 0x0a, failScene: 0x0b, failRecord: 0x0c,
    mergeLtp: 0x10, directionTx: 0x20, directionRx: 0x30, mergeHtp: 0x50, artNetSel: 0x60, acnSel: 0x70, clearOp: 0x90, styleDelta: 0xa0, styleConst: 0xb0, rdmEnable: 0xc0, rdmDisable: 0xd0 };
  const PROTOCOLS = ['DMX512', 'MIDI', 'Avab', 'Colortran CMX', 'ADB 62.5', 'Art-Net', 'DALI'];
  const STYLES = ['Node', 'Controller', 'Media server', 'Route', 'Backup', 'Config', 'Visualiser'];
  // Common ESTA manufacturer codes seen on UK installs (full list: tsp.esta.org). Unknown → shown as hex.
  const ESTA = { 0x0000: 'ESTA', 0x454e: 'ENTTEC', 0x4144: 'Artistic Licence', 0x414c: 'Artistic Licence', 0x434d: 'City Theatrical', 0x4d41: 'Martin',
    0x4c41: 'Lumen Radio', 0x4c55: 'LumenRadio', 0x4453: 'DMXking', 0x6a6b: 'DMXking (ENTTEC-compat)', 0x6d6c: 'MA Lighting', 0x0001: 'PLASA', 0x2b6f: 'Pathway Connectivity',
    0x4e4c: 'Nicolaudie', 0x534c: 'Swisson', 0x5753: 'Obsidian / Elation', 0x454c: 'Elation', 0x4348: 'Chauvet', 0x524f: 'Robe', 0x4747: 'GrandMA', 0x7a7a: 'Sonor (prototype)',
    0x2a6e: 'Philips Color Kinetics', 0x4c52: 'Lutron', 0x4954: 'Eaton / Cooper', 0x5345: 'Strand', 0x4744: 'Goddard Design', 0x4152: 'Arri', 0x4554: 'ETC', 0x4b53: 'Kissbox', 0x5356: 'Showtec / Highlite', 0x7ff0: 'Prototype' };
  const SACN_ID = [0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00]; // "ASC-E1.17\0\0\0"

  const u8 = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));
  const str = (b, o, n) => { let s = ''; for (let i = o; i < o + n && i < b.length && b[i]; i++) s += String.fromCharCode(b[i]); return s.trim(); };
  const putStr = (b, o, n, s) => { s = String(s || ''); for (let i = 0; i < n - 1 && i < s.length; i++) b[o + i] = s.charCodeAt(i) & 0x7f; };
  const hex = (n, w) => '0x' + n.toString(16).toUpperCase().padStart(w || 4, '0');
  const ipStr = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
  const macStr = (b, o) => Array.from(b.slice(o, o + 6), (x) => x.toString(16).padStart(2, '0')).join(':').toUpperCase();

  function header(op, size) {
    const b = new Uint8Array(size); b.set(ID, 0); b[8] = op & 0xff; b[9] = op >> 8; b[10] = 0; b[11] = PROT; return b;
  }
  function isArtNet(b) { if (!b || b.length < 10) return false; for (let i = 0; i < 8; i++) if (b[i] !== ID[i]) return false; return true; }
  const opOf = (b) => b[8] | (b[9] << 8);

  const splitPA = (pa) => ({ net: (pa >> 8) & 0x7f, sub: (pa >> 4) & 0x0f, uni: pa & 0x0f });
  const joinPA = (net, sub, uni) => ((net & 0x7f) << 8) | ((sub & 0x0f) << 4) | (uni & 0x0f);
  const fmtUniverse = (pa) => { const p = splitPA(pa); return `${p.net}:${p.sub}:${p.uni}`; };

  // ── ArtPoll ─────────────────────────────────────────────────────────────
  // Flags: bit1 = send me a PollReply when your state changes. Art-Net 4 targeted fields left open (all nodes reply).
  function buildPoll(opts) {
    const o = opts || {}; const b = header(OP.poll, 22);
    b[12] = o.flags != null ? o.flags : 0x02; b[13] = o.diagPriority || 0x10;
    if (o.target) { b[12] |= 0x20; b[14] = o.target[1] >> 8; b[15] = o.target[1] & 0xff; b[16] = o.target[0] >> 8; b[17] = o.target[0] & 0xff; }
    return b;
  }

  // ── ArtPollReply (239 bytes) ────────────────────────────────────────────
  function parsePollReply(bytes) {
    const b = u8(bytes); if (!isArtNet(b) || opOf(b) !== OP.pollreply || b.length < 207) return null;
    const net = b[18] & 0x7f, sub = b[19] & 0x0f;
    const numPorts = Math.min(4, (b[172] << 8) | b[173]);
    const esta = b[24] | (b[25] << 8), oem = (b[20] << 8) | b[21];
    const status1 = b[23], status2 = b.length > 212 ? b[212] : 0, status3 = b.length > 217 ? b[217] : 0;
    const ports = [];
    for (let i = 0; i < 4; i++) {
      const t = b[174 + i]; if (i >= numPorts && !t) continue;
      const goA = b[182 + i], goB = b.length > 216 ? b[213 + i] : 0, gi = b[178 + i];
      const canOut = !!(t & 0x80), canIn = !!(t & 0x40);
      if (!canOut && !canIn && i >= numPorts) continue;
      ports.push({
        index: i, protocol: PROTOCOLS[t & 0x3f] || 'Other', output: canOut, input: canIn,
        outUniverse: joinPA(net, sub, b[190 + i]), inUniverse: joinPA(net, sub, b[186 + i]),
        outActive: !!(goA & 0x80), merging: !!(goA & 0x08), mergeMode: goA & 0x02 ? 'LTP' : 'HTP', outSacn: !!(goA & 0x01), shortCircuit: !!(goA & 0x04),
        inActive: !!(gi & 0x80), inErrors: !!(gi & 0x04), inDisabled: !!(gi & 0x08),
        rdm: goB ? !(goB & 0x80) : !!(status1 & 0x02), outStyle: goB & 0x40 ? 'continuous' : 'delta',
      });
    }
    const fwNum = (b[16] << 8) | b[17];
    return {
      op: 'pollreply',
      ip: ipStr(b, 10), port: b[14] | (b[15] << 8), fw: fwNum, fwText: `${b[16]}.${b[17]}`,
      net, sub, oem, oemHex: hex(oem), esta, estaHex: hex(esta), maker: ESTA[esta] || null,
      ubea: b[22], status1, status2, status3,
      indicators: ['unknown', 'locate', 'mute', 'normal'][(status1 >> 6) & 3],
      programmedBy: ['unknown', 'front panel', 'network / web', 'unused'][(status1 >> 4) & 3],
      rdmCapable: !!(status1 & 0x02), bootRom: !!(status1 & 0x04),
      webConfig: !!(status2 & 0x01), dhcp: !!(status2 & 0x02), dhcpCapable: !!(status2 & 0x04), fifteenBit: !!(status2 & 0x08), sacnCapable: !!(status2 & 0x10),
      squawking: !!(status2 & 0x20), rdmViaCommand: !!(status2 & 0x80),
      shortName: str(b, 26, 18), longName: str(b, 44, 64), report: str(b, 108, 64),
      numPorts, ports, acnPriority: b[194], style: STYLES[b[200]] || 'Node',
      mac: macStr(b, 201), bindIp: ipStr(b, 207), bindIndex: b[211] || 1,
      defaultUid: b.length >= 224 ? uidStr(b.slice(218, 224)) : '', refreshRate: b.length >= 228 ? ((b[226] << 8) | b[227]) || 44 : 44,
    };
  }
  // A node record the other way (simulators, tests): same fields as parsePollReply returns.
  function buildPollReply(n) {
    const b = header(OP.pollreply, 239); b[8] = 0x00; b[9] = 0x21; b[10] = 0; b[11] = 0; // PollReply has no ProtVer: IP lives at 10
    const ip = String(n.ip || '0.0.0.0').split('.').map(Number); b.set(ip, 10); b[14] = PORT & 0xff; b[15] = PORT >> 8;
    b[16] = (n.fw || 0) >> 8; b[17] = (n.fw || 0) & 0xff; b[18] = n.net || 0; b[19] = n.sub || 0; b[20] = (n.oem || 0) >> 8; b[21] = (n.oem || 0) & 0xff;
    b[23] = n.status1 != null ? n.status1 : 0xd2; b[24] = (n.esta || 0) & 0xff; b[25] = (n.esta || 0) >> 8;
    putStr(b, 26, 18, n.shortName); putStr(b, 44, 64, n.longName); putStr(b, 108, 64, n.report || '#0001 [0000] Power On Tests successful');
    const ports = n.ports || []; b[173] = ports.length;
    ports.forEach((p, i) => {
      b[174 + i] = (p.output ? 0x80 : 0) | (p.input ? 0x40 : 0); b[182 + i] = (p.outActive ? 0x80 : 0) | (p.merging ? 0x08 : 0) | (p.mergeMode === 'LTP' ? 0x02 : 0) | (p.outSacn ? 0x01 : 0);
      b[190 + i] = (p.outUniverse || 0) & 0x0f; b[186 + i] = (p.inUniverse || 0) & 0x0f; b[213 + i] = p.rdm === false ? 0x80 : 0;
    });
    b[200] = 0; String(n.mac || '00:00:00:00:00:00').split(':').forEach((h, i) => { b[201 + i] = parseInt(h, 16) || 0; }); b.set(ip, 207); b[211] = n.bindIndex || 1;
    b[212] = n.status2 != null ? n.status2 : 0x0f; b[226] = 0; b[227] = 44;
    return b;
  }

  // ── ArtDmx ──────────────────────────────────────────────────────────────
  function buildDmx(pa, data, seq, physical) {
    const d = u8(data || []); let len = Math.max(2, Math.min(512, d.length)); if (len & 1) len++;
    const b = header(OP.dmx, 18 + len); b[12] = seq & 0xff; b[13] = physical || 0; b[14] = pa & 0xff; b[15] = (pa >> 8) & 0x7f; b[16] = len >> 8; b[17] = len & 0xff;
    b.set(d.subarray(0, len), 18); return b;
  }
  function parseDmx(b) {
    const len = Math.min(512, (b[16] << 8) | b[17], b.length - 18);
    return { op: 'dmx', seq: b[12], physical: b[13], universe: b[14] | ((b[15] & 0x7f) << 8), length: len, data: b.slice(18, 18 + len) };
  }

  // ── ArtAddress (107 bytes): rename / re-address / merge / protocol / locate ──
  // o: { bindIndex, shortName, longName, net, sub, swOut:[4], swIn:[4], command, acnPriority }. Undefined fields = no change.
  function buildAddress(o) {
    o = o || {}; const b = header(OP.address, 107);
    b[12] = o.net == null ? 0x7f : 0x80 | (o.net & 0x7f); b[13] = o.bindIndex || 1;
    putStr(b, 14, 18, o.shortName || ''); putStr(b, 32, 64, o.longName || '');
    for (let i = 0; i < 4; i++) {
      b[96 + i] = o.swIn && o.swIn[i] != null ? 0x80 | (o.swIn[i] & 0x0f) : 0x7f;
      b[100 + i] = o.swOut && o.swOut[i] != null ? 0x80 | (o.swOut[i] & 0x0f) : 0x7f;
    }
    b[104] = o.sub == null ? 0x7f : 0x80 | (o.sub & 0x0f); b[105] = o.acnPriority == null ? 0xff : o.acnPriority; b[106] = o.command || 0;
    return b;
  }
  function parseAddress(b) {
    const keep = (v) => (v === 0x7f || !(v & 0x80) ? null : v & 0x7f);
    return { op: 'address', net: keep(b[12]), bindIndex: b[13], shortName: str(b, 14, 18), longName: str(b, 32, 64),
      swIn: [0, 1, 2, 3].map((i) => keep(b[96 + i])), swOut: [0, 1, 2, 3].map((i) => keep(b[100 + i])), sub: keep(b[104]), acnPriority: b[105], command: b[106] };
  }

  // ── RDM over Art-Net (ArtTodRequest / ArtTodData / ArtTodControl / ArtRdm) ──
  function buildTodRequest(pa) { const b = header(OP.todrequest, 25); b[21] = (pa >> 8) & 0x7f; b[22] = 0; b[23] = 1; b[24] = pa & 0xff; return b; }
  function buildTodControl(pa, flush) { const b = header(OP.todcontrol, 24); b[21] = (pa >> 8) & 0x7f; b[22] = flush ? 0x01 : 0; b[23] = pa & 0xff; return b; }
  function parseTodData(b) {
    const count = b[27], uids = [];
    for (let i = 0; i < count && 28 + i * 6 + 6 <= b.length; i++) uids.push(uidStr(b.slice(28 + i * 6, 34 + i * 6)));
    return { op: 'toddata', port: b[13], bindIndex: b[20], universe: ((b[21] & 0x7f) << 8) | b[23], nak: b[22] === 0xff, total: (b[24] << 8) | b[25], block: b[26], uids };
  }
  function buildTodData(pa, uids, block) {
    const b = header(OP.toddata, 28 + uids.length * 6); b[12] = 1; b[13] = 1; b[20] = 1; b[21] = (pa >> 8) & 0x7f; b[23] = pa & 0xff;
    b[24] = uids.length >> 8; b[25] = uids.length & 0xff; b[26] = block || 0; b[27] = uids.length;
    uids.forEach((u, i) => b.set(uidBytes(u), 28 + i * 6)); return b;
  }
  function buildRdm(pa, rdmPacket) { // rdmPacket from rdm.build(), starts at the 0xCC start code; ArtRdm carries it without the start code
    const r = u8(rdmPacket); const body = r[0] === 0xcc ? r.subarray(1) : r;
    const b = header(OP.rdm, 24 + body.length); b[12] = 1; b[21] = (pa >> 8) & 0x7f; b[22] = 0; b[23] = pa & 0xff; b.set(body, 24); return b;
  }
  function parseArtRdm(b) {
    const body = b.slice(24); const pk = new Uint8Array(body.length + 1); pk[0] = 0xcc; pk.set(body, 1);
    return { op: 'rdm', universe: ((b[21] & 0x7f) << 8) | b[23], rdm: rdm.parse(pk) };
  }

  // ── RDM (E1.20) message build / parse ──
  const uidStr = (b) => { const x = Array.from(b, (v) => v.toString(16).padStart(2, '0')).join('').toUpperCase(); return x.slice(0, 4) + ':' + x.slice(4); };
  const uidBytes = (s) => { const h = String(s).replace(/[^0-9a-f]/gi, '').padStart(12, '0'); const o = new Uint8Array(6); for (let i = 0; i < 6; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; };
  const PID = { DISC_UNIQUE_BRANCH: 0x0001, SUPPORTED_PARAMETERS: 0x0050, PARAMETER_DESCRIPTION: 0x0051, DEVICE_INFO: 0x0060, PRODUCT_DETAIL_ID_LIST: 0x0070, DEVICE_MODEL_DESCRIPTION: 0x0080,
    MANUFACTURER_LABEL: 0x0081, DEVICE_LABEL: 0x0082, SOFTWARE_VERSION_LABEL: 0x00c0, DMX_PERSONALITY: 0x00e0, DMX_PERSONALITY_DESCRIPTION: 0x00e1, DMX_START_ADDRESS: 0x00f0,
    SLOT_INFO: 0x0120, SLOT_DESCRIPTION: 0x0121, SENSOR_DEFINITION: 0x0200, SENSOR_VALUE: 0x0201, DEVICE_HOURS: 0x0400, LAMP_HOURS: 0x0401, IDENTIFY_DEVICE: 0x1000, RESET_DEVICE: 0x1001 };
  const PIDNAME = Object.fromEntries(Object.entries(PID).map(([k, v]) => [v, k]));
  const CC = { DISCOVERY: 0x10, DISCOVERY_RESPONSE: 0x11, GET: 0x20, GET_RESPONSE: 0x21, SET: 0x30, SET_RESPONSE: 0x31 };
  const RESP = ['ACK', 'ACK_TIMER', 'NACK', 'ACK_OVERFLOW'];
  const NACK = { 0: 'Unknown PID', 1: 'Format error', 2: 'Hardware fault', 3: 'Proxy reject', 4: 'Write protect', 5: 'Unsupported command class', 6: 'Data out of range', 7: 'Buffer full', 8: 'Packet size unsupported', 9: 'Sub-device out of range', 10: 'Proxy buffer full' };
  const CATEGORY = { 0x0000: 'Not declared', 0x0100: 'Fixture', 0x0101: 'Fixed fixture', 0x0102: 'Moving yoke', 0x0103: 'Moving mirror', 0x0200: 'Fixture accessory', 0x0201: 'Colour accessory',
    0x0300: 'Projector', 0x0400: 'Atmospheric', 0x0500: 'Dimmer', 0x0501: 'Incandescent dimmer', 0x0502: 'Fluorescent dimmer', 0x0503: 'Cold cathode dimmer', 0x0504: 'Non-dim module', 0x0505: 'Low voltage dimmer',
    0x0506: 'Controllable AC dimmer', 0x0509: 'LED dimmer', 0x0600: 'Power', 0x0601: 'Power control', 0x0700: 'Scenic', 0x0800: 'Data', 0x0801: 'Data distribution', 0x0802: 'Data patch', 0x0803: 'Data converter',
    0x0900: 'A/V', 0x0a00: 'Monitor', 0x7000: 'Control', 0x7001: 'Control (fader)', 0x7100: 'Test equipment', 0x7fff: 'Other' };
  const rdm = {
    PID, PIDNAME, CC, uidStr, uidBytes,
    build(o) { // { dest, src, tn, port, cc, pid, sub, data } → Uint8Array starting with 0xCC, checksum appended
      const pd = u8(o.data || []); const len = 24 + pd.length; const b = new Uint8Array(len + 2);
      b[0] = 0xcc; b[1] = 0x01; b[2] = len; b.set(uidBytes(o.dest || 'FFFF:FFFFFFFF'), 3); b.set(uidBytes(o.src || '7FF0:00000001'), 9);
      b[15] = (o.tn || 0) & 0xff; b[16] = o.port != null ? o.port : 1; b[17] = 0; b[18] = (o.sub || 0) >> 8; b[19] = (o.sub || 0) & 0xff;
      b[20] = o.cc || CC.GET; b[21] = o.pid >> 8; b[22] = o.pid & 0xff; b[23] = pd.length; b.set(pd, 24);
      let sum = 0; for (let i = 0; i < len; i++) sum += b[i]; b[len] = (sum >> 8) & 0xff; b[len + 1] = sum & 0xff; return b;
    },
    parse(bytes) {
      const b = u8(bytes); if (b.length < 26 || b[0] !== 0xcc || b[1] !== 0x01) return null;
      const len = b[2]; const pdl = b[23]; let sum = 0; for (let i = 0; i < len && i < b.length; i++) sum += b[i];
      const ck = b.length >= len + 2 ? (b[len] << 8) | b[len + 1] : -1;
      const pid = (b[21] << 8) | b[22]; const data = b.slice(24, 24 + pdl); const rt = b[16];
      const out = { dest: uidStr(b.slice(3, 9)), src: uidStr(b.slice(9, 15)), tn: b[15], responseType: RESP[rt] || rt, messageCount: b[17], sub: (b[18] << 8) | b[19], cc: b[20],
        pid, pidName: PIDNAME[pid] || hex(pid), data, checksumOk: ck === (sum & 0xffff) };
      if (out.responseType === 'NACK' && data.length >= 2) out.nack = NACK[(data[0] << 8) | data[1]] || 'NACK ' + ((data[0] << 8) | data[1]);
      if (out.responseType === 'ACK' && (out.cc === CC.GET_RESPONSE)) out.value = rdm.decode(pid, data);
      return out;
    },
    decode(pid, d) {
      const s = () => String.fromCharCode(...d).replace(/\0+$/, '').trim();
      const w = (o) => (d[o] << 8) | d[o + 1];
      switch (pid) {
        case PID.DEVICE_INFO: return d.length < 19 ? null : { rdmVersion: w(0), modelId: w(2), category: CATEGORY[w(4)] || CATEGORY[w(4) & 0xff00] || hex(w(4)), categoryCode: w(4),
          softwareVersion: ((d[6] << 24) >>> 0) + (d[7] << 16) + (d[8] << 8) + d[9], footprint: w(10), personality: d[12], personalityCount: d[13], startAddress: w(14), subDevices: w(16), sensors: d[18] };
        case PID.DEVICE_LABEL: case PID.MANUFACTURER_LABEL: case PID.DEVICE_MODEL_DESCRIPTION: case PID.SOFTWARE_VERSION_LABEL: return s();
        case PID.DMX_START_ADDRESS: return w(0);
        case PID.IDENTIFY_DEVICE: return !!d[0];
        case PID.DMX_PERSONALITY: return { current: d[0], count: d[1] };
        case PID.DMX_PERSONALITY_DESCRIPTION: return { personality: d[0], footprint: w(1), name: String.fromCharCode(...d.slice(3)).replace(/\0+$/, '').trim() };
        case PID.DEVICE_HOURS: case PID.LAMP_HOURS: return ((d[0] << 24) >>> 0) + (d[1] << 16) + (d[2] << 8) + d[3];
        case PID.SUPPORTED_PARAMETERS: { const l = []; for (let i = 0; i + 1 < d.length; i += 2) l.push(w(i)); return l; }
        default: return Array.from(d);
      }
    },
    u16: (v) => [(v >> 8) & 0xff, v & 0xff],
    text: (t) => Array.from(String(t || '').slice(0, 32), (c) => c.charCodeAt(0) & 0x7f),
  };

  // ── sACN (ANSI E1.31-2018) data packets + universe discovery ──
  const sacn = {
    group: (u) => `239.255.${(u >> 8) & 0xff}.${u & 0xff}`,
    DISCOVERY_UNIVERSE: 64214,
    build(o) { // { universe 1–63999, data ≤512, seq, priority 0–200 (default 100), cid 16 bytes, source name, preview, terminate }
      const d = u8(o.data || []); const n = Math.min(512, d.length); const len = 126 + n; const b = new Uint8Array(len);
      b[1] = 0x10; b.set(SACN_ID, 4); const fl = (o2) => { const l = len - o2; b[o2] = 0x70 | (l >> 8); b[o2 + 1] = l & 0xff; };
      fl(16); b[21] = 0x04; b.set(u8(o.cid || new Uint8Array(16)).subarray(0, 16), 22);
      fl(38); b[43] = 0x02; putStr(b, 44, 64, o.source || 'Sonor Art-Net Tester'); b[108] = o.priority != null ? o.priority : 100;
      b[111] = (o.seq || 0) & 0xff; b[112] = (o.preview ? 0x80 : 0) | (o.terminate ? 0x40 : 0); b[113] = o.universe >> 8; b[114] = o.universe & 0xff;
      fl(115); b[117] = 0x02; b[118] = 0xa1; b[122] = 0x01; b[123] = (n + 1) >> 8; b[124] = (n + 1) & 0xff; b[125] = 0x00; b.set(d.subarray(0, n), 126);
      return b;
    },
    parse(bytes) {
      const b = u8(bytes); if (b.length < 38) return null; for (let i = 0; i < 12; i++) if (b[4 + i] !== SACN_ID[i]) return null;
      const rootV = (b[18] << 24 | b[19] << 16 | b[20] << 8 | b[21]) >>> 0; const cid = Array.from(b.slice(22, 38), (x) => x.toString(16).padStart(2, '0')).join('');
      if (rootV === 0x04 && b.length >= 126) {
        const count = ((b[123] << 8) | b[124]) - 1; const sc = b[125];
        return { op: 'sacn', cid, source: str(b, 44, 64), priority: b[108], sync: (b[109] << 8) | b[110], seq: b[111], preview: !!(b[112] & 0x80), terminated: !!(b[112] & 0x40),
          universe: (b[113] << 8) | b[114], startCode: sc, length: Math.max(0, Math.min(512, count)), data: b.slice(126, 126 + Math.max(0, Math.min(512, count))) };
      }
      if (rootV === 0x08 && b.length >= 120) { // extended: universe discovery list
        const fv = (b[40] << 24 | b[41] << 16 | b[42] << 8 | b[43]) >>> 0; if (fv !== 0x02) return { op: 'sacn-sync', cid };
        const list = []; for (let o = 120; o + 1 < b.length; o += 2) list.push((b[o] << 8) | b[o + 1]);
        return { op: 'sacn-discovery', cid, source: str(b, 44, 64), page: b[118], last: b[119], universes: list };
      }
      return null;
    },
  };

  function parse(bytes) {
    const b = u8(bytes);
    if (!isArtNet(b)) return sacn.parse(b);
    const op = opOf(b);
    switch (op) {
      case OP.pollreply: return parsePollReply(b);
      case OP.dmx: return parseDmx(b);
      case OP.poll: return { op: 'poll', flags: b[12] };
      case OP.address: return parseAddress(b);
      case OP.todrequest: return { op: 'todrequest', universe: ((b[21] & 0x7f) << 8) | b[24] };
      case OP.todcontrol: return { op: 'todcontrol', universe: ((b[21] & 0x7f) << 8) | b[23], flush: b[22] === 1 };
      case OP.toddata: return parseTodData(b);
      case OP.rdm: return parseArtRdm(b);
      case OP.sync: return { op: 'sync' };
      default: return { op: OPNAME[op] || hex(op) };
    }
  }

  // Merge helper for the monitor: HTP of several sources' 512-slot arrays
  function htp(list) { const o = new Uint8Array(512); list.forEach((d) => { for (let i = 0; i < d.length && i < 512; i++) if (d[i] > o[i]) o[i] = d[i]; }); return o; }

  return { VERSION, PORT, SACN_PORT, OP, AC, ESTA, PROTOCOLS, buildPoll, parsePollReply, buildPollReply, buildDmx, parseDmx, buildAddress, parseAddress,
    buildTodRequest, buildTodControl, buildTodData, parseTodData, buildRdm, parse, rdm, sacn, splitPA, joinPA, fmtUniverse, htp, isArtNet };
});
