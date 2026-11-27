// Art-Net flash watch (lib/artwatch.js): decode, pcap round trip, and every alert the 2 Parkside hunt needs.
const assert = require('assert'); const A = require('../lib/artwatch');
const mac = (s) => Buffer.from(s.split(':').map((x) => parseInt(x, 16)));
function udp({ smac = 'aa:00:00:00:00:73', dmac = 'aa:00:00:00:00:47', src, dst, sp, dp, payload }) {
  const ip = Buffer.alloc(20); ip[0] = 0x45; ip[9] = 17; src.split('.').forEach((v, i) => { ip[12 + i] = +v; }); dst.split('.').forEach((v, i) => { ip[16 + i] = +v; });
  const u = Buffer.alloc(8); u.writeUInt16BE(sp, 0); u.writeUInt16BE(dp, 2); u.writeUInt16BE(8 + payload.length, 4);
  return Buffer.concat([mac(dmac), mac(smac), Buffer.from([8, 0]), ip, u, payload]);
}
function artDmx(seq, levels, pa = 0) { const h = Buffer.alloc(18); h.write('Art-Net\0', 0, 'latin1'); h.writeUInt16LE(0x5000, 8); h[11] = 14; h[12] = seq; h[14] = pa & 255; h[15] = pa >> 8; h.writeUInt16BE(levels.length, 16); return Buffer.concat([h, Buffer.from(levels)]); }
function artOp(op) { const h = Buffer.alloc(107); h.write('Art-Net\0', 0, 'latin1'); h.writeUInt16LE(op, 8); return h; }
const frame = (seq, lv, o = {}) => udp({ src: '192.168.1.73', dst: '192.168.1.47', sp: 6454, dp: 6454, payload: artDmx(seq, lv), ...o });
const mdns = (n) => udp({ smac: 'aa:00:00:00:00:73', dmac: '01:00:5e:00:00:fb', src: '192.168.1.73', dst: '224.0.0.251', sp: 5353, dp: 5353, payload: Buffer.alloc(300 + n) });

const lv = (on) => { const a = new Array(512).fill(0); for (const i of on) a[i] = 200; return a; };
const pk = []; const T0 = Date.UTC(2026, 10, 27, 14, 0, 0); let seq = 1;
pk.push({ t: T0, fr: frame(seq++, lv([0, 1, 2])) });
for (let s = 0; s < 7200; s += 1) pk.push({ t: T0 + s * 1000 + 500, fr: mdns(s % 7) });              // 1 mDNS packet a second as background
for (const at of [T0 + 2400e3, T0 + 6000e3]) for (let i = 0; i < 120; i++) pk.push({ t: at + i * 5, fr: mdns(i) });   // hourly burst at :40
pk.push({ t: T0 + 2401e3, fr: frame(seq++, lv([0, 1, 2, ...Array.from({ length: 30 }, (_, i) => 100 + i)])) });   // 30 OFF channels light
pk.push({ t: T0 + 2402e3, fr: frame(seq++, lv([0, 1, 2])) });
pk.push({ t: T0 + 3000e3, fr: frame(1, lv([5]), { src: '192.168.1.99', smac: 'aa:00:00:00:00:99' }) });             // a second sender
pk.push({ t: T0 + 3100e3, fr: udp({ src: '192.168.1.99', smac: 'aa:00:00:00:00:99', dst: '192.168.1.255', dmac: 'ff:ff:ff:ff:ff:ff', sp: 6454, dp: 6454, payload: artOp(0x6000) }) });   // ArtAddress
pk.sort((a, b) => a.t - b.t);

// pcap round trip through the stream reader, in awkward chunk sizes
const file = A.pcapFile(pk); const back = []; const rd = A.pcapReader((t, fr) => back.push({ t, fr: Buffer.from(fr) }));
for (let o = 0; o < file.length; o += 777) rd(file.subarray(o, o + 777));
assert.strictEqual(back.length, pk.length); assert.strictEqual(Math.round(back[5].t), Math.round(pk[5].t)); assert.ok(back[5].fr.equals(pk[5].fr));

const d = A.decode(pk[0].fr); assert.strictEqual(d.cls, 'ArtDMX'); assert.strictEqual(d.art.dmx.length, 512); assert.strictEqual(d.dst, '192.168.1.47');
assert.strictEqual(A.decode(mdns(1)).cls, 'mDNS'); assert.ok(A.decode(mdns(1)).bcast);

const out = []; const det = A.detector({ node: '192.168.1.47', emit: (k, o) => out.push({ k, ...o }) });
let last = 0; for (const p of back) { if (Math.floor(p.t / 1000) !== last) last = Math.floor(p.t / 1000); det.feed(p.t, p.fr); } det.tick();
const rules = out.filter((x) => x.k === 'alert').map((x) => x.rule);
for (const r of ['aw.offlit', 'aw.second', 'aw.op', 'aw.burst']) assert.ok(rules.includes(r), 'missing ' + r + ' in ' + rules.join(','));
const bursts = out.filter((x) => x.rule === 'aw.burst'); assert.strictEqual(bursts.length, 2, 'two bursts, not ' + bursts.length); assert.ok(bursts[1].hourly, 'second burst flagged as about an hour after the first');
const lit = out.find((x) => x.rule === 'aw.offlit'); assert.strictEqual(lit.rose, 30);
const moves = out.filter((x) => x.k === 'packet'); assert.ok(moves.length >= 3 && moves[1].ch.length > 0);
assert.ok(!rules.includes('aw.blackout'));
const st = det.status(); assert.strictEqual(st.senders.length, 2);
console.log(`ok  artwatch: pcap round trip, decode, alerts (${[...new Set(rules)].join(', ')}), hourly burst flagged`);
