// Traffic tab: tshark / tcpdump line parsing, AV labels, stats, faults (lib/capture.js + public/data/traffic-faults.js)
const assert = require('assert'); const C = require('../lib/capture'); const TF = require('../public/data/traffic-faults.js');
const td = (l) => C.fromTcpdump(l);
let p = td('1700000000.000001 aa:bb:cc:dd:ee:01 > ff:ff:ff:ff:ff:ff, ethertype IPv4 (0x0800), length 342: 192.168.1.1.67 > 255.255.255.255.68: BOOTP/DHCP, Reply, length 300');
assert.strictEqual(p.what, 'DHCP'); assert.strictEqual(p.dhcpServer, '192.168.1.1');
p = td('1700000000.000003 aa:bb:cc:dd:ee:03 > ff:ff:ff:ff:ff:ff, ethertype IPv4 (0x0800), length 572: 192.168.1.95.6454 > 192.168.1.255.6454: UDP, length 530'); assert.strictEqual(p.what, 'Art-Net');
p = td('1700000000.000004 aa:bb:cc:dd:ee:04 > 01:00:5e:7f:ff:fa, ethertype IPv4 (0x0800), length 400: 192.168.1.10.1902 > 239.255.255.250.1902: UDP, length 358'); assert.strictEqual(p.what, 'Control4 SDDP');
p = td('1700000000.000005 aa:bb:cc:dd:ee:05 > ff:ff:ff:ff:ff:ff, ethertype ARP (0x0806), length 60: Reply 192.168.1.10 is-at aa:bb:cc:dd:ee:05, length 46'); assert.strictEqual(p.what, 'ARP'); assert.strictEqual(p.src, '192.168.1.10');
const line = (o) => C.FIELDS.map((f) => o[f] ?? '').join('\t');
p = C.fromTshark(line({ 'frame.time_epoch': '1700000000.5', 'eth.src': 'aa:aa:aa:aa:aa:01', 'eth.dst': '01:00:5e:7f:00:04', 'ip.src': '192.168.1.96', 'ip.dst': '239.255.0.4', 'udp.srcport': '5568', 'udp.dstport': '5568', '_ws.col.Protocol': 'E1.31', 'frame.len': '638', '_ws.col.Info': 'sACN' }));
assert.strictEqual(p.what, 'sACN'); assert.ok(p.udp); assert.strictEqual(p.t, 1700000000500);
p = C.fromTshark(line({ 'frame.time_epoch': '1700000001', 'ip.src': '192.168.1.41', 'ip.dst': '224.0.1.129', 'udp.srcport': '319', 'udp.dstport': '319', '_ws.col.Protocol': 'PTPv2', 'frame.len': '86' })); assert.strictEqual(p.what, 'PTP (Dante/AES67)');
// stats + faults: two DHCP servers, an IP conflict, a broadcast storm
const s = C._newStats(); const mine = new Set(['192.168.1.115']); const t0 = 1700000100000;
for (let i = 0; i < 12000; i++) C._account(s, { t: t0 + Math.floor(i / 1200) * 1000 + (i % 1000), smac: 'aa:00:00:00:00:01', dmac: 'ff:ff:ff:ff:ff:ff', src: '192.168.1.95', dst: '192.168.1.255', udp: true, sport: 6454, dport: 6454, proto: 'UDP', len: 572, what: 'Art-Net' }, mine);
for (const sv of ['192.168.1.1', '192.168.1.254']) C._account(s, { t: t0 + 9500, smac: 'aa', dmac: 'ff:ff:ff:ff:ff:ff', src: sv, dst: '255.255.255.255', udp: true, sport: 67, dport: 68, proto: 'DHCP', len: 342, what: 'DHCP', dhcpType: 2, dhcpServer: sv }, mine);
for (const m of ['aa:bb:cc:00:00:60', 'aa:bb:cc:00:00:61']) C._account(s, { t: t0 + 9600, smac: m, dmac: 'ff:ff:ff:ff:ff:ff', src: '192.168.1.60', proto: 'ARP', arpOp: 2, len: 60, what: 'ARP' }, mine);
const ids = TF.faults({ ...s, secs: 30 }).map((f) => f.id); for (const id of ['flt.bcast', 'flt.dhcp.rogue', 'flt.arp.dup', 'vis.normal']) assert.ok(ids.includes(id), id);
assert.ok(Object.keys(C.PRESETS).includes('lighting'));
console.log('ok  traffic: tshark + tcpdump parsing, AV labels, stats, faults (storm, rogue DHCP, IP conflict, port mode)');
