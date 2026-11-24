// Art-Net / sACN codec + fault rules (lib/artnet.js)
const assert = require('assert'); const A = require('../lib/artnet');
const p = A.buildPoll(); assert.strictEqual(p.length, 14); assert.strictEqual(p.toString('latin1', 0, 7), 'Art-Net'); assert.strictEqual(p.readUInt16LE(8), 0x2000); assert.strictEqual(p[12], 0x02);
function reply({ ip = [2, 0, 0, 10], net = 0, sub = 0, sw = [0, 1], bind = 1, mac = [0, 0x50, 0xc2, 1, 2, 3], name = 'Node A' } = {}) {
  const b = Buffer.alloc(239); Buffer.from('Art-Net\0', 'latin1').copy(b); b.writeUInt16LE(0x2100, 8); ip.forEach((o, i) => { b[10 + i] = o; }); b.writeUInt16LE(6454, 14); b[16] = 1; b[17] = 4;
  b[18] = net; b[19] = sub; b.writeUInt16BE(0x0431, 20); b[23] = 0xc2; b.writeUInt16LE(0x454e, 24); b.write(name, 26, 'latin1'); b.write(name + ' long', 44, 'latin1'); b.write('#0001 [0042] Power On', 108, 'latin1');
  b.writeUInt16BE(sw.length, 172); sw.forEach((u, i) => { b[174 + i] = 0x80; b[190 + i] = u; b[182 + i] = i === 0 ? 0x80 : 0; }); mac.forEach((o, i) => { b[201 + i] = o; }); b[211] = bind; b[212] = 0x0e; return b;
}
const r = A.parsePollReply(reply()); assert.strictEqual(r.ip, '2.0.0.10'); assert.strictEqual(r.shortName, 'Node A'); assert.strictEqual(r.maker, 'ENTTEC'); assert.strictEqual(r.ports.length, 2);
assert.strictEqual(r.ports[1].outUniverse, 1); assert.ok(r.ports[0].outData); assert.ok(r.dhcp); assert.ok(r.rdm); assert.strictEqual(r.firmware, '1.4');
const r2 = A.parsePollReply(reply({ sw: [2, 3], bind: 2 })); const g = A.group([r, r2]); assert.strictEqual(g.length, 1); assert.strictEqual(g[0].ports.length, 4);
assert.strictEqual(A.parsePollReply(reply().slice(0, 200)), null);
// sACN discovery
const d = Buffer.alloc(124); d.writeUInt16BE(0x0010, 0); d.write('ASC-E1.17', 4, 'latin1'); d.writeUInt32BE(8, 18); d.writeUInt32BE(2, 40); d.write('Console', 44, 'latin1'); d.writeUInt32BE(1, 114); d.writeUInt16BE(1, 120); d.writeUInt16BE(2, 122);
const s = A.parseSacn(d.length < 126 ? Buffer.concat([d, Buffer.alloc(2)]) : d); assert.strictEqual(s.type, 'discovery'); assert.deepStrictEqual(s.universes.slice(0, 2), [1, 2]);
// faults
const f = A.flags({ nodes: g, dmx: [{ src: '192.168.1.5', universe: 1, packets: 40, hz: 40 }], sacn: [{ source: 'Console', ip: '192.168.1.6', universes: [2], priority: 100 }], localCidrs: ['192.168.1.0/24'] });
const ids = f.map((x) => x.id); assert.ok(ids.includes('an.addr.2x')); assert.ok(ids.includes('an.dmx.broadcast')); assert.ok(ids.includes('an.merge'));
assert.strictEqual(A.buildAddress(0x04).length, 107); assert.strictEqual(A.buildAddress(0x04)[106], 0x04);
console.log('ok  artnet: poll, poll reply (bind index grouping), sACN discovery, ArtAddress locate, faults');
