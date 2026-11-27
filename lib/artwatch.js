'use strict';
// Art-Net flash watch (v1.9.0). Bryn 2026-11-27, 2 Parkside (LEDs flash about once an hour, the controller logs see nothing):
// "we need some form of logging that can be left there … log all network traffic in a wireshark sort of way".
// Runs inside a Trouble watch on the site Pi. Its own capture (full packets, not the 128-byte headers of the ring) of Art-Net
// plus every broadcast / multicast packet, decoded live. Best on a second network port plugged into a switch port that MIRRORS
// the Art-Net node's port: then it sees exactly what the node receives.
//   alerts (sitelog, tool 'artwatch'): a second Art-Net sender on a universe · non-DMX Art-Net that can reset / re-address a node
//     (ArtAddress, ArtIpProg, ArtCommand, firmware…) · many OFF channels lit in one frame · blackout · frame length change ·
//     sequence break · a broadcast / multicast burst · "flash seen" marks pressed by a person
//   packet lines: every ArtDMX frame that changes, as the channels that moved (so any channel can be traced back over days)
//   clips: for every alert, a .pcap of the 2 minutes before to 1 minute after, written from memory (opens in Wireshark)
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const OPS = { 0x2000: 'ArtPoll', 0x2100: 'ArtPollReply', 0x2300: 'ArtDiagData', 0x2400: 'ArtCommand', 0x5000: 'ArtDMX', 0x5100: 'ArtNzs', 0x5200: 'ArtSync',
  0x6000: 'ArtAddress', 0x7000: 'ArtInput', 0x8000: 'ArtTodRequest', 0x8100: 'ArtTodData', 0x8200: 'ArtTodControl', 0x8300: 'ArtRdm',
  0xf200: 'ArtFirmwareMaster', 0xf300: 'ArtFirmwareReply', 0xf800: 'ArtIpProg', 0xf900: 'ArtIpProgReply', 0x9700: 'ArtTimeCode', 0x9900: 'ArtTrigger' };
const RISKY = new Set(['ArtAddress', 'ArtInput', 'ArtIpProg', 'ArtCommand', 'ArtFirmwareMaster', 'ArtTodControl', 'ArtRdm', 'ArtNzs', 'ArtTrigger']);
const BPF = 'udp port 6454 or udp port 5568 or broadcast or multicast';
const ip4 = (b, o) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
const macOf = (b, o) => Array.from(b.subarray(o, o + 6), (x) => x.toString(16).padStart(2, '0')).join(':');
const hhmmss = (t) => new Date(t).toTimeString().slice(0, 8);

// Ethernet frame → { smac, dst, src, bcast, cls, art? }   (null when not IPv4 / ARP)
function decode(fr) {
  if (fr.length < 14) return null;
  let et = fr.readUInt16BE(12), o = 14; while ((et === 0x8100 || et === 0x88a8) && fr.length >= o + 4) { et = fr.readUInt16BE(o + 2); o += 4; }
  const bcast = !!(fr[0] & 1); const smac = macOf(fr, 6);
  if (et === 0x0806) return fr.length >= o + 28 ? { smac, src: ip4(fr, o + 14), dst: ip4(fr, o + 24), bcast, cls: 'ARP' } : null;
  if (et !== 0x0800 || fr.length < o + 20) return null;
  const ihl = (fr[o] & 15) * 4, proto = fr[o + 9]; const d = { smac, src: ip4(fr, o + 12), dst: ip4(fr, o + 16), bcast: bcast || fr[o + 16] >= 224 || fr[o + 19] === 255 };
  if (proto !== 17) { d.cls = proto === 2 ? 'IGMP' : proto === 1 ? 'ICMP' : proto === 6 ? 'TCP' : 'IP'; return d; }
  const u = o + ihl; if (fr.length < u + 8) return null; const sp = fr.readUInt16BE(u), dp = fr.readUInt16BE(u + 2); const pl = fr.subarray(u + 8);
  if (pl.length >= 10 && pl.toString('latin1', 0, 8) === 'Art-Net\0') {
    const op = pl.readUInt16LE(8); d.cls = OPS[op] || `ArtOp-${op.toString(16)}`;
    if (op === 0x5000 && pl.length >= 18) { const n = Math.min(pl.readUInt16BE(16), pl.length - 18); d.art = { seq: pl[12], pa: pl[14] | (pl[15] << 8), dmx: Buffer.from(pl.subarray(18, 18 + n)) }; }
    return d;
  }
  const NAMES = { 5353: 'mDNS', 1900: 'SSDP', 1902: 'SDDP', 67: 'DHCP', 68: 'DHCP', 137: 'NetBIOS', 138: 'NetBIOS', 5355: 'LLMNR', 3702: 'WS-Discovery', 10001: 'UniFi discovery', 5568: 'sACN', 6454: 'udp-6454 (not Art-Net)' };
  d.cls = NAMES[dp] || NAMES[sp] || 'UDP'; return d;
}

// pcap stream reader: push chunks, get (t ms, frame) callbacks. Handles both byte orders and µs / ns timestamps.
function pcapReader(onPacket) {
  let buf = Buffer.alloc(0), le = true, ns = false, hdr = false, link = 1;
  return (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!hdr) { if (buf.length < 24) return; const m = buf.readUInt32LE(0);
      if (m === 0xa1b2c3d4 || m === 0xa1b23c4d) le = true; else if (m === 0xd4c3b2a1 || m === 0x4d3cb2a1) le = false; else throw new Error('not a pcap stream');
      ns = m === 0xa1b23c4d || m === 0x4d3cb2a1; link = le ? buf.readUInt32LE(20) : buf.readUInt32BE(20); hdr = true; buf = buf.subarray(24); }
    let o = 0;
    while (buf.length - o >= 16) {
      const r = (k) => (le ? buf.readUInt32LE(o + k) : buf.readUInt32BE(o + k)); const cap = r(8); if (buf.length - o < 16 + cap) break;
      if (link === 1) onPacket(r(0) * 1000 + (ns ? r(4) / 1e6 : r(4) / 1e3), buf.subarray(o + 16, o + 16 + cap));
      o += 16 + cap;
    }
    buf = buf.subarray(o);
  };
}
function pcapFile(packets) {   // [{ t, fr }] → Buffer (classic pcap, µs, Ethernet)
  const h = Buffer.alloc(24); h.writeUInt32LE(0xa1b2c3d4, 0); h.writeUInt16LE(2, 4); h.writeUInt16LE(4, 6); h.writeUInt32LE(65535, 16); h.writeUInt32LE(1, 20);
  const parts = [h]; for (const p of packets) { const r = Buffer.alloc(16); const s = Math.floor(p.t / 1000); r.writeUInt32LE(s, 0); r.writeUInt32LE(Math.round((p.t - s * 1000) * 1000), 4); r.writeUInt32LE(p.fr.length, 8); r.writeUInt32LE(p.fr.length, 12); parts.push(r, p.fr); }
  return Buffer.concat(parts);
}

// The detector: pure (feed packets, get lines). Used live and by the tests.
//   node   the Art-Net node's IP (optional: without it every universe is watched)
//   emit   (kind, obj) → kind 'packet' | 'alert' | 'source'
function detector({ node = '', emit, offLit = 8, burstMin = 60 } = {}) {
  const streams = new Map(); const senders = new Map(); const sec = { s: 0, n: 0, who: new Map() }; const hist = [];   // per-second broadcast counts (last 600 s)
  let lastBurst = 0; const bursts = []; const st = { pkts: 0, dmx: 0, toNode: 0, fromNode: 0, started: null, last: null };
  function closeSecond() {
    if (!sec.s) return; hist.push(sec.n); if (hist.length > 600) hist.shift();
    if (hist.length >= 30) { const base = hist.slice(0, -1).slice().sort((a, b) => a - b); const med = base[Math.floor(base.length / 2)]; const thr = Math.max(burstMin, med * 5);
      if (sec.n >= thr && sec.s * 1000 - lastBurst > 10000) { lastBurst = sec.s * 1000; const top = [...sec.who.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k} ×${v}`);
        const prev = bursts.filter((b) => sec.s * 1000 - b > 3300e3 && sec.s * 1000 - b < 3900e3); bursts.push(sec.s * 1000); if (bursts.length > 200) bursts.shift();
        emit('alert', { t: sec.s * 1000, level: 'warn', rule: 'aw.burst', n: sec.n, base: med, top, hourly: prev.length > 0, text: `Broadcast / multicast burst: ${sec.n} packets in one second (normal ${med}/s) · ${top.slice(0, 2).join(', ')}${prev.length ? ' · another came about an hour ago' : ''}` }); } }
  }
  function feed(t, fr) {
    const d = decode(fr); if (!d) return null; st.pkts++; st.started = st.started || t; st.last = t;
    if (node && d.dst === node) st.toNode++; if (node && d.src === node) st.fromNode++;
    if (d.bcast) { const s = Math.floor(t / 1000); if (s !== sec.s) { closeSecond(); sec.s = s; sec.n = 0; sec.who = new Map(); } sec.n++; const k = `${d.cls} ${d.src}`; sec.who.set(k, (sec.who.get(k) || 0) + 1); }
    if (d.cls.startsWith('Art') || d.cls.startsWith('ArtOp')) {
      if (!senders.has(d.src)) { senders.set(d.src, { mac: d.smac, first: t, ops: {} }); emit('source', { t, src: d.src, mac: d.smac, state: 'Art-Net sender seen', op: d.cls }); }
      const sd = senders.get(d.src); sd.ops[d.cls] = (sd.ops[d.cls] || 0) + 1; sd.last = t;
      if (RISKY.has(d.cls) || d.cls.startsWith('ArtOp')) emit('alert', { t, level: 'bad', rule: 'aw.op', src: d.src, mac: d.smac, dst: d.dst, op: d.cls, text: `${d.cls} from ${d.src} (${d.smac}) to ${d.dst}: this packet can reset or re-address a node` });
    }
    if (!d.art) return d;
    if (node && d.dst !== node && !d.bcast) return d;   // unicast to another node: not ours
    st.dmx++; const u = d.art.pa; const key = `${d.src}|${u}`; let s = streams.get(key);
    const others = [...streams.values()].filter((x) => x.u === u && x.src !== d.src);
    if (!s) { s = { src: d.src, mac: d.smac, u, first: t, last: t, n: 0, prev: null, seq: 0 }; streams.set(key, s);
      if (others.length) emit('alert', { t, level: 'bad', rule: 'aw.second', src: d.src, mac: d.smac, u, others: others.map((x) => x.src), text: `A second Art-Net sender on universe ${u}: ${d.src} (${d.smac}) as well as ${others.map((x) => x.src).join(', ')}. A node that hears two senders flashes.` }); }
    const p = s.prev, x = d.art.dmx; const gap = t - s.last;
    if (s.n && d.art.seq && s.seq && d.art.seq !== (s.seq % 255) + 1 && d.art.seq !== s.seq) emit('alert', { t, level: 'info', rule: 'aw.seq', src: d.src, u, was: s.seq, now: d.art.seq, text: `Sequence jumped ${s.seq} → ${d.art.seq} from ${d.src} (packets lost or reordered)` });
    if (p && p.length !== x.length) emit('alert', { t, level: 'warn', rule: 'aw.len', src: d.src, u, was: p.length, now: x.length, text: `Frame length changed ${p.length} → ${x.length} channels from ${d.src}` });
    if (!p || !p.equals(x)) {
      const moved = []; let lit = 0, rose = 0, lost = 0, litBefore = 0;
      for (let i = 0; i < x.length; i++) { const a = p && i < p.length ? p[i] : 0, b = x[i]; if (a) litBefore++; if (b) lit++; if (a !== b) { moved.push([i + 1, a, b]); if (!a && b) rose++; if (a && !b) lost++; } }
      emit('packet', { t, src: d.src, u, seq: d.art.seq, gapMs: s.n ? Math.round(gap) : null, lit, moved: moved.length, ch: moved.slice(0, 48) });
      if (p && rose >= offLit) emit('alert', { t, level: 'bad', rule: 'aw.offlit', src: d.src, u, rose, text: `${rose} channels that were OFF came on in one frame from ${d.src}${rose === moved.length ? '' : ` (${moved.length} moved)`}` });
      if (p && litBefore >= 4 && lit === 0) emit('alert', { t, level: 'warn', rule: 'aw.blackout', src: d.src, u, was: litBefore, text: `Blackout frame from ${d.src}: all channels 0 (${litBefore} were on)` });
    }
    s.n++; s.last = t; s.seq = d.art.seq; s.prev = x; return d;
  }
  return { feed, tick: closeSecond, status: () => ({ ...st, senders: [...senders.entries()].map(([ip, v]) => ({ ip, ...v })), streams: [...streams.values()].map(({ prev, ...v }) => ({ ...v, lit: prev ? prev.filter(Boolean).length : 0 })) }) };
}

// The live watch: capture → detector → site log, + clips around every alert.
function start({ iface, node, dir, log, keepSec = 180 }) {
  const which = (b) => { try { return execFileSync('which', [b], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() || null; } catch { return null; } };
  const bin = which('dumpcap') || which('tcpdump'); if (!bin) return { error: 'Needs dumpcap or tcpdump (pi/install.sh installs them)' };
  fs.mkdirSync(dir, { recursive: true });
  const args = bin.endsWith('dumpcap') ? ['-i', iface, '-P', '-q', '-s', '1514', '-f', BPF, '-w', '-'] : ['-i', iface, '-U', '-n', '-s', '1514', '-w', '-', ...BPF.split(' ')];
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const mem = []; const pending = []; const st = { iface, node, bin: path.basename(bin), started: Date.now(), alerts: 0, clips: [], err: '' };
  const write = (kind, o) => { const line = { tool: 'artwatch', src: o.src || 'agent', ...o }; delete line.t;
    if (kind === 'alert') { st.alerts++; log.alert(line); pending.push({ at: o.t || Date.now(), why: o.rule || 'alert', text: o.text }); } else log.write(kind, line); };
  const det = detector({ node, emit: write });
  const read = pcapReader((t, fr) => { const b = Buffer.from(fr); mem.push({ t, fr: b }); det.feed(t, b); });
  proc.stdout.on('data', (c) => { try { read(c); } catch (e) { st.err = e.message; } });
  proc.stderr.on('data', (d) => { const s = String(d); if (/permission|not permitted/i.test(s)) st.err = 'No permission to capture: re-run pi/install.sh'; else if (/No such device|doesn't exist/i.test(s)) st.err = `No interface "${iface}"`; });
  proc.on('exit', (code) => { st.ended = Date.now(); if (code && !st.err) st.err = `${st.bin} stopped (code ${code})`; });
  const timer = setInterval(() => {
    const now = Date.now(); det.tick(); while (mem.length && mem[0].t < now - keepSec * 1000 - 60000) mem.shift();
    for (let i = pending.length - 1; i >= 0; i--) { const e = pending[i]; if (now - e.at < 60000) continue; pending.splice(i, 1);
      const pk = mem.filter((p) => p.t >= e.at - 120000 && p.t <= e.at + 60000); if (!pk.length) continue;
      const d = new Date(e.at); const name = `flash-${d.toISOString().slice(0, 10)}_${hhmmss(e.at).replace(/:/g, '')}-${String(e.why).replace(/\W+/g, '')}.pcap`;
      try { fs.writeFileSync(path.join(dir, name), pcapFile(pk)); st.clips.unshift({ file: name, at: new Date(e.at).toISOString(), why: e.why, text: e.text, pkts: pk.length }); st.clips = st.clips.slice(0, 200);
        log.write('source', { tool: 'artwatch', src: 'agent', state: 'clip saved', file: name, pkts: pk.length }); } catch { /* disk full: the log line is still there */ } }
    try { const files = fs.readdirSync(dir).filter((f) => f.endsWith('.pcap')).sort(); while (files.length > 300) fs.unlinkSync(path.join(dir, files.shift())); } catch { /* ok */ }
  }, 1000);
  return {
    stop: () => { clearInterval(timer); try { proc.kill('SIGINT'); } catch { /* gone */ } },
    mark: (note) => write('alert', { t: Date.now(), level: 'bad', rule: 'aw.mark', text: `Flash seen (marked by a person)${note ? ': ' + note : ''}` }),
    status: () => { const s = det.status(); const vis = !node ? 'no node set' : s.toNode > 0 ? 'mirror: packets to the node are visible' : s.fromNode > 0 ? 'the node is heard, but nothing sent to it: not a mirror port' : 'nothing from or to the node yet';
      return { ...st, running: !st.ended, pkts: s.pkts, dmx: s.dmx, toNode: s.toNode, visibility: vis, senders: s.senders, streams: s.streams, clips: st.clips.slice(0, 30) }; },
  };
}
module.exports = { decode, pcapReader, pcapFile, detector, start, BPF, RISKY };
