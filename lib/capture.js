// Live traffic capture for the Traffic tab (v1.7.0): a Wireshark-style view of what the site agent's network port sees.
// Engine: tshark (fields output, best) or tcpdump (text, fallback), started on demand and stopped when the tab closes.
// Header-only: snaplen 128 bytes, auto-stop after 30 min, nothing is uploaded; a .pcap is written only when the engineer presses Record.
// What a port sees: on a normal switch port, the agent's own traffic plus broadcast and multicast (discovery, DHCP, Art-Net,
// sACN, PTP…). Traffic between two other devices needs a mirror (SPAN) port; `visibility` says which it looks like.
'use strict';
const { spawn, execFileSync } = require('child_process');
const fs = require('fs'); const path = require('path'); const os = require('os');

// AV labels: port / protocol → what an AV engineer calls it (thresholds and presets get the research thread's rules)
const LABELS = [
  ['Art-Net', (p) => p.udp && (p.sport === 6454 || p.dport === 6454)],
  // Shure also uses UDP 5568: only call it sACN when tshark says E1.31 (tcpdump can't tell, so it says sACN?)
  ['sACN', (p) => p.udp && (p.sport === 5568 || p.dport === 5568) && /E1\.31|ACN/i.test(p.proto)],
  ['sACN?', (p) => p.udp && (p.sport === 5568 || p.dport === 5568) && /^(UDP|)$/i.test(p.proto)],
  ['Shure', (p) => p.udp && (p.sport === 5568 || p.dport === 5568)],
  ['Control4 SDDP', (p) => p.udp && (p.sport === 1902 || p.dport === 1902)],
  ['Control4', (p) => !p.udp && [5020, 5021, 5809, 5810, 5115, 8750].includes(p.dport || p.sport) ],
  ['mDNS', (p) => p.udp && (p.sport === 5353 || p.dport === 5353)],
  ['SSDP', (p) => p.udp && (p.sport === 1900 || p.dport === 1900)],
  ['DHCP', (p) => p.udp && [67, 68].includes(p.sport) && [67, 68].includes(p.dport)],
  ['DNS', (p) => p.sport === 53 || p.dport === 53],
  ['PTP (Dante/AES67)', (p) => p.udp && [319, 320].includes(p.dport)],
  ['Dante', (p) => p.udp && ((p.dport >= 14336 && p.dport <= 14600) || [4321, 4440, 4444, 4455, 8700, 8800].includes(p.dport))],
  ['NDI', (p) => !p.udp && p.dport >= 5960 && p.dport <= 5990],
  ['AirPlay', (p) => [7000, 7100, 49152].includes(p.dport) && !p.udp],
  ['Sonos', (p) => [1400, 1443, 3400, 3401, 3500].includes(p.dport) || [1400, 1443].includes(p.sport)],
  ['Crestron', (p) => [41794, 41795, 41796, 41797].includes(p.dport) || [41794, 41796].includes(p.sport)],
  ['Savant', (p) => [11263, 11264].includes(p.dport)],
  ['UniFi discovery', (p) => p.udp && p.dport === 10001],
  ['SNMP', (p) => p.udp && [161, 162].includes(p.dport)],
  ['NTP', (p) => p.udp && p.dport === 123],
  ['RTSP', (p) => p.dport === 554 || p.sport === 554],
  ['HTTPS', (p) => !p.udp && (p.dport === 443 || p.sport === 443)],
  ['HTTP', (p) => !p.udp && [80, 8080].includes(p.dport || p.sport)],
];
const PRESETS = {   // one-tap filters on the tab (BPF for the capture, label list for the view)
  all: { label: 'Everything', bpf: '' },
  lighting: { label: 'Art-Net + sACN', bpf: 'udp port 6454 or udp port 5568', labels: ['Art-Net', 'sACN'] },
  control: { label: 'Control4 / Crestron / Savant', bpf: 'udp port 1902 or tcp port 5020 or tcp port 5021 or port 41794 or port 41796 or port 11263', labels: ['Control4 SDDP', 'Control4', 'Crestron', 'Savant'] },
  discovery: { label: 'Discovery (mDNS, SSDP, SDDP)', bpf: 'udp port 5353 or udp port 1900 or udp port 1902', labels: ['mDNS', 'SSDP', 'Control4 SDDP'] },
  dhcp: { label: 'DHCP + ARP', bpf: 'udp port 67 or udp port 68 or arp', labels: ['DHCP', 'ARP'] },
  audio: { label: 'Dante / AES67 / PTP', bpf: 'udp port 319 or udp port 320 or udp portrange 14336-14600 or udp port 4321', labels: ['PTP (Dante/AES67)', 'Dante'] },
  sonos: { label: 'Sonos / AirPlay', bpf: 'port 1400 or port 1443 or port 3400 or port 7000 or udp port 5353', labels: ['Sonos', 'AirPlay', 'mDNS'] },
  bcast: { label: 'Broadcast + multicast only', bpf: 'broadcast or multicast' },
};
const FIELDS = ['frame.time_epoch', 'eth.src', 'eth.dst', 'ip.src', 'ip.dst', 'ipv6.src', 'ipv6.dst', 'udp.srcport', 'udp.dstport', 'tcp.srcport', 'tcp.dstport',
  '_ws.col.Protocol', 'frame.len', 'arp.src.proto_ipv4', 'arp.dst.proto_ipv4', 'arp.opcode', 'tcp.analysis.retransmission', 'dhcp.option.dhcp', 'dhcp.option.dhcp_server_id', '_ws.col.Info'];

const which = (b) => { try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', [b], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split(/\r?\n/)[0].trim() || null; } catch { return null; } };
const isBcastMac = (m) => /^ff:ff:ff:ff:ff:ff$/i.test(m || '');
const isMcastMac = (m) => /^(01:00:5e|33:33|01:80:c2|01:00:0c)/i.test(m || '');

function label(p) {
  if (p.proto === 'ARP') return 'ARP'; if (/^IGMP/i.test(p.proto)) return 'IGMP'; if (/STP/i.test(p.proto)) return 'STP'; if (/^LLDP|^CDP/i.test(p.proto)) return p.proto.toUpperCase();
  for (const [l, f] of LABELS) if (f(p)) return l; return p.proto || (p.udp ? 'UDP' : 'TCP');
}
// tshark -T fields line → packet
function fromTshark(line) {
  const f = line.split('\t'); if (f.length < FIELDS.length - 1) return null; const g = (k) => f[FIELDS.indexOf(k)] || '';
  const udpS = Number(g('udp.srcport')) || 0, udpD = Number(g('udp.dstport')) || 0;
  const p = { t: Number(g('frame.time_epoch')) * 1000, smac: g('eth.src'), dmac: g('eth.dst'), src: g('ip.src') || g('ipv6.src') || g('arp.src.proto_ipv4'), dst: g('ip.dst') || g('ipv6.dst') || g('arp.dst.proto_ipv4'),
    udp: !!(udpS || udpD), sport: udpS || Number(g('tcp.srcport')) || 0, dport: udpD || Number(g('tcp.dstport')) || 0, proto: g('_ws.col.Protocol'), len: Number(g('frame.len')) || 0, info: g('_ws.col.Info').slice(0, 160),
    retrans: !!g('tcp.analysis.retransmission'), arpOp: Number(g('arp.opcode')) || 0, dhcpType: Number(g('dhcp.option.dhcp')) || 0, dhcpServer: g('dhcp.option.dhcp_server_id') };
  p.what = label(p); return p;
}
// tcpdump -l -n -e -tt line → packet (fallback when tshark is missing)
function fromTcpdump(line) {
  const m = line.match(/^(\d+\.\d+)\s+([0-9a-f:]{17}) > ([0-9a-f:]{17}), ethertype (\S+) \(0x[0-9a-f]+\), length (\d+): (.*)$/i); if (!m) return null;
  const [, ts, smac, dmac, et, len, rest] = m; const p = { t: Number(ts) * 1000, smac, dmac, src: '', dst: '', udp: false, sport: 0, dport: 0, proto: et, len: Number(len), info: rest.slice(0, 160), retrans: false, arpOp: 0, dhcpType: 0, dhcpServer: '' };
  if (et === 'ARP') { p.proto = 'ARP'; const a = rest.match(/Request who-has (\S+) tell (\S+?),/); const b = rest.match(/Reply (\S+) is-at/); if (a) { p.arpOp = 1; p.dst = a[1]; p.src = a[2]; } if (b) { p.arpOp = 2; p.src = b[1]; } }
  else { const ip = rest.match(/^([0-9a-f:.]+?)(?:\.(\d+))? > ([0-9a-f:.]+?)(?:\.(\d+))?: (.*)$/i);
    if (ip) { p.src = ip[1]; p.dst = ip[3]; p.sport = Number(ip[2]) || 0; p.dport = Number(ip[4]) || 0; const tail = ip[5];
      p.udp = /^UDP|^BOOTP|^NBT|\[\|?\w*\]|^\d+ [A-Z]+\?|^\d+\*?[-+]? /.test(tail) || /UDP/.test(tail) || [53, 67, 68, 123, 161, 319, 320, 1900, 1902, 5353, 5568, 6454, 10001].includes(p.dport) || [67, 68, 5353, 1900, 1902, 5568, 6454].includes(p.sport);
      p.proto = /^igmp/i.test(tail) ? 'IGMP' : p.udp ? 'UDP' : 'TCP';
      if (/BOOTP\/DHCP, Reply/.test(tail)) { p.dhcpType = 2; p.dhcpServer = p.src; } if (/BOOTP\/DHCP, Request/.test(tail)) p.dhcpType = 1; }
    else if (/^igmp|IGMP/.test(rest)) p.proto = 'IGMP'; else if (/STP|802\.1d/i.test(rest)) p.proto = 'STP'; }
  p.what = label(p); return p;
}

// ── one capture at a time, kept in a ring ──
const RING = 4000;
let cap = null;   // { proc, engine, iface, preset, started, ring[], seq, stats }
function engines() { return { tshark: which('tshark'), tcpdump: which('tcpdump'), dumpcap: which('dumpcap') }; }
function newStats() { return { pkts: 0, bytes: 0, bcast: 0, mcast: 0, ucastOthers: 0, ucastMine: 0, byWhat: {}, talkers: {}, perSec: [], dhcpServers: {}, arp: {}, igmpQuery: 0, igmpReport: 0, igmpQueriers: {}, stp: 0, retrans: 0, tcp: 0 }; }
function account(s, p, mine) {
  s.pkts++; s.bytes += p.len; const b = isBcastMac(p.dmac), m = !b && isMcastMac(p.dmac);
  if (b) s.bcast++; else if (m) s.mcast++; else if (mine.has(p.src) || mine.has(p.dst) || mine.has((p.smac || '').toLowerCase()) || mine.has((p.dmac || '').toLowerCase())) s.ucastMine++; else s.ucastOthers++;
  const w = s.byWhat[p.what] = s.byWhat[p.what] || { pkts: 0, bytes: 0 }; w.pkts++; w.bytes += p.len;
  const k = p.src || p.smac; if (k) { const t = s.talkers[k] = s.talkers[k] || { pkts: 0, bytes: 0, mac: p.smac, what: {} }; t.pkts++; t.bytes += p.len; t.what[p.what] = (t.what[p.what] || 0) + 1; }
  const sec = Math.floor(p.t / 1000); let last = s.perSec[s.perSec.length - 1]; if (!last || last.s !== sec) { last = { s: sec, all: 0, bcast: 0, mcast: 0 }; s.perSec.push(last); if (s.perSec.length > 120) s.perSec.shift(); } last.all++; if (b) last.bcast++; if (m) last.mcast++;
  if (p.what === 'DHCP' && (p.dhcpType === 2 || p.dhcpType === 5 || (p.sport === 67 && p.dhcpType !== 1))) { const sv = p.dhcpServer || p.src; if (sv && sv !== '0.0.0.0') { const d = s.dhcpServers[sv] = s.dhcpServers[sv] || { offers: 0, mac: p.smac }; d.offers++; } }
  if (p.proto === 'ARP' && p.src && p.smac && (p.arpOp === 2 || p.arpOp === 1)) { const a = s.arp[p.src] = s.arp[p.src] || {}; a[p.smac.toLowerCase()] = p.t; }
  if (p.what === 'IGMP') { if (/query/i.test(p.info)) { s.igmpQuery++; if (p.src) s.igmpQueriers[p.src] = (s.igmpQueriers[p.src] || 0) + 1; } else s.igmpReport++; }
  if (p.what === 'STP' && /topology change|TC|TCN/i.test(p.info)) s.stp++;
  if (!p.udp && p.proto !== 'ARP') { s.tcp++; if (p.retrans) s.retrans++; }
}
function start({ iface, preset = 'all', bpf } = {}) {
  stop(); const e = engines(); const locals = require('./net').localSubnets();
  const ifc = iface || (locals[0] && locals[0].ifname) || 'any'; const filt = bpf != null ? String(bpf) : (PRESETS[preset] || PRESETS.all).bpf;
  const mine = new Set([...locals.map((l) => l.address), ...locals.map((l) => (l.mac || '').toLowerCase())].filter(Boolean));
  let proc, engine;
  if (e.tshark) { engine = 'tshark'; proc = spawn(e.tshark, ['-l', '-n', '-i', ifc, '-s', '128', '-a', 'duration:1800', '-T', 'fields', '-E', 'separator=/t', '-E', 'occurrence=f', '-E', 'quote=n', ...FIELDS.flatMap((x) => ['-e', x]), ...(filt ? ['-f', filt] : [])], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  else if (e.tcpdump) { engine = 'tcpdump'; proc = spawn(e.tcpdump, ['-l', '-n', '-e', '-tt', '-s', '128', '-i', ifc, ...(filt ? filt.split(' ') : [])], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  else return { error: 'No capture tool here: on the Pi run sudo bash pi/install.sh again (it adds tshark); on a Mac install Wireshark; on Windows install Wireshark with Npcap.' };
  if (engine === 'tcpdump') setTimeout(() => { if (cap && cap.proc === proc) stop(); }, 30 * 60000);   // auto-stop after 30 min (research priv.*)
  const c = cap = { proc, engine, iface: ifc, preset, bpf: filt, started: Date.now(), ring: [], seq: 0, stats: newStats(), err: '', mine };
  let buf = ''; proc.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1);
    const p = engine === 'tshark' ? fromTshark(line) : fromTcpdump(line); if (!p) continue; p.n = ++c.seq; c.ring.push(p); if (c.ring.length > RING) c.ring.shift(); account(c.stats, p, mine); } });
  proc.stderr.on('data', (d) => { const t = String(d); if (/permission|Operation not permitted|don't have permission|You don't/i.test(t)) c.err = 'The agent may not capture: on the Pi re-run pi/install.sh (it lets the service capture); on a laptop start the agent with sudo / as administrator.'; else if (/No such device|doesn't exist|There is no device/i.test(t)) c.err = `No interface "${ifc}"`; });
  proc.on('exit', (code) => { if (cap === c) { c.ended = Date.now(); if (code && !c.err) c.err = `${engine} stopped (code ${code})`; } });
  return status();
}
function stop() { if (cap && cap.proc && !cap.ended) try { cap.proc.kill('SIGTERM'); } catch {} if (cap) cap.ended = cap.ended || Date.now(); }
function status() { if (!cap) return { running: false, engines: engines() }; const { proc, ring, stats, mine, ...c } = cap; return { ...c, running: !cap.ended, engines: engines() }; }
// what the page asks every second: new packets since n, plus the stats and faults
function read({ since = 0, max = 300 } = {}) {
  if (!cap) return { running: false, engines: engines(), packets: [], stats: null };
  const pk = cap.ring.filter((p) => p.n > since).slice(-max); const s = cap.stats; const secs = Math.max(1, ((cap.ended || Date.now()) - cap.started) / 1000);
  const talkers = Object.entries(s.talkers).sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 15).map(([k, v]) => ({ addr: k, ...v, what: Object.entries(v.what).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([w]) => w) }));
  return { ...status(), packets: pk, last: cap.seq, stats: { pkts: s.pkts, bytes: s.bytes, secs: Math.round(secs), bcast: s.bcast, mcast: s.mcast, ucastMine: s.ucastMine, ucastOthers: s.ucastOthers, byWhat: s.byWhat, talkers, perSec: s.perSec.slice(-60), dhcpServers: s.dhcpServers, arp: s.arp, igmpQuery: s.igmpQuery, igmpReport: s.igmpReport, igmpQueriers: s.igmpQueriers, stp: s.stp, retrans: s.retrans, tcp: s.tcp },
    faults: require('../public/data/traffic-faults.js').faults({ ...s, secs }) };
}
// Record N seconds to a .pcap (headers only: snaplen 256, like the live view; full payloads = Wireshark on a laptop)
// Record N seconds to a .pcap (dumpcap, else tshark -w, else tcpdump -w) in scans/pcap/, for opening in Wireshark
function record({ seconds = 60, dir, iface, bpf } = {}) {
  const e = engines(); const ifc = iface || (cap && cap.iface) || (require('./net').localSubnets()[0] || {}).ifname || 'any'; const filt = bpf != null ? bpf : (cap ? cap.bpf : '');
  const secs = Math.max(5, Math.min(600, Number(seconds) || 60)); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.pcap`);
  const bin = e.dumpcap || e.tshark || e.tcpdump; if (!bin) return Promise.resolve({ error: 'No capture tool installed' });
  const args = bin === e.tcpdump ? ['-n', '-i', ifc, '-s', '128', '-w', file, ...(filt ? filt.split(' ') : [])] : ['-i', ifc, '-s', '128', '-a', `duration:${secs}`, ...(bin === e.dumpcap ? ['-P', '-q'] : ['-F', 'pcap', '-q']), '-w', file, ...(filt ? ['-f', filt] : [])];
  return new Promise((resolve) => { const p = spawn(bin, args, { stdio: 'ignore' }); const kill = bin === e.tcpdump ? setTimeout(() => p.kill('SIGINT'), secs * 1000) : null;
    p.on('exit', () => { clearTimeout(kill); try { const st = fs.statSync(file); resolve({ file: path.basename(file), bytes: st.size, seconds: secs }); } catch { resolve({ error: 'Nothing was recorded (capture permission?)' }); } }); });
}
// Rolling pcap ring for a log session (v1.8.0, "max features for ultimate troubleshooting"): dumpcap writes 5-minute / 50 MB files and
// keeps the newest `files` (default 40, about 2 GB at most), so the last hours of headers are always there to open in Wireshark.
let ringProc = null;
function ringStart({ dir, iface, files = 40, snap = 128 } = {}) {
  if (ringProc) return { running: true, dir };
  const e = engines(); const bin = e.dumpcap || e.tshark; if (!bin) return { error: 'The pcap ring needs dumpcap or tshark (pi/install.sh installs it)' };
  const ifc = iface || (require('./net').localSubnets()[0] || {}).ifname || 'any'; fs.mkdirSync(dir, { recursive: true });
  const args = ['-i', ifc, '-s', String(snap), '-b', 'duration:300', '-b', 'filesize:51200', '-b', `files:${Math.max(4, Math.min(400, Number(files) || 40))}`, ...(bin === e.dumpcap ? ['-P', '-q'] : ['-F', 'pcap', '-q']), '-w', path.join(dir, 'ring.pcap')];
  ringProc = spawn(bin, args, { stdio: 'ignore' }); ringProc.on('exit', () => { ringProc = null; }); return { running: true, dir, iface: ifc };
}
function ringStop() { if (ringProc) { try { ringProc.kill('SIGINT'); } catch { /* gone */ } ringProc = null; } return { running: false }; }
const ringRunning = () => !!ringProc;
module.exports = { LABELS, PRESETS, FIELDS, label, fromTshark, fromTcpdump, start, stop, status, read, record, ringStart, ringStop, ringRunning, engines, _account: account, _newStats: newStats };
void os;
