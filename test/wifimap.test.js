// node test/wifimap.test.js — the Wi-Fi map's geometry, coverage model and the Takeoffs apply (pure parts of public/wifimap.js)
const assert = require('assert'); const W = require('../public/wifimap.js')._t; const demo = require('../public/data/demo-floors.json');
const gf = demo.floors[0];
assert.strictEqual(W.roomAt(gf, { x: 520, y: 460 }).name, 'Kitchen', 'room from polygon');
assert.strictEqual(W.roomAt(gf, { x: 50, y: 50 }), null, 'outside every room');
assert(W.inside(gf, { x: 520, y: 460 }) && !W.inside(gf, { x: 1000, y: 100 }), 'building outline mask');
assert(W.isAp({ sonorSymbol: { code: 'WAP-CEIL' } }) && W.isAp({ sonorSymbol: { code: '2-AP-OUT' } }) && W.isAp({ sonorSymbol: { code: 'AP-WIFI6' } }));
assert(!W.isAp({ sonorSymbol: { code: 'ACOUSTIC-BASSTRAP-CORNER', glyph: 'BC' } }), 'TRAP- is not an AP');
const m = { p0: -38, n: 3.3 };
const near = W.predict(gf.aps, { x: 522, y: 470 }, gf.scalePxPerM, m), far = W.predict(gf.aps, { x: 940, y: 720 }, gf.scalePxPerM, m);
assert(near > -45 && far < near, `prediction falls with distance (${near.toFixed(1)} → ${far.toFixed(1)})`);
const byUid = Object.fromEntries(gf.aps.map((a) => [a.uid, a]));
const links = { 'AA:BB:CC:00:00:01': gf.aps[1].uid };
const rs = [{ wx: 522, wy: 500, signal: -50, bssid: 'aa:bb:cc:00:00:01' }, { wx: 560, wy: 520, signal: -55, bssid: 'AA:BB:CC:00:00:01' }];
const cal = W.calibrate(rs, byUid, links, gf.scalePxPerM); assert.strictEqual(cal.from, 2); assert(cal.p0 > -45 && cal.p0 < -30, 'calibrated p0 ' + cal.p0);
assert.strictEqual(W.idw(rs, { x: 522, y: 500 }, 100), -50); assert.strictEqual(W.idw(rs, { x: 100, y: 100 }, 100), null, 'too far from any reading');
assert(W.macNear('7A:45:58:12:34:5F', '78:45:58:12:34:56') && !W.macNear('7A:45:58:99:34:5F', '78:45:58:12:34:56'), 'BSSID ↔ AP MAC');
// apply: add in the Playroom, move the kitchen AP, remove the outdoor AP, one stale
const content = { scalePxPerM: 30, areas: gf.areas, symbols: [
  { x: 522.16, y: 461.23, sonorSymbol: { uid: 'kit', code: 'WAP-CEIL', autoId: { short: 'WAP', roomCode: 'KIT', n: 1, id: 'KIT-WAP-01' } } },
  { x: 631, y: 354, sonorSymbol: { uid: 'out', code: '2-AP-OUT', autoId: { short: 'AP', roomCode: 'EXT', n: 1 } } },
  { x: 10, y: 10, sonorSymbol: { uid: 'spk', code: 'SPK-CEIL' } }] };
const tpl = { 'WAP-CEIL': { code: 'WAP-CEIL', glyph: 'WAP', service: 'network', block_code: 'CL-SON-09-WAP-CEIL', autoId: { short: 'WAP' } } };
const r = W.applyToContent(content, { ...gf, code: 'GF' }, [
  { op: 'add', uid: 'new1', code: 'WAP-CEIL', x: 575, y: 700 }, { op: 'move', uid: 'kit', x: 530, y: 470 }, { op: 'remove', uid: 'out' }, { op: 'remove', uid: 'gone' }], tpl);
assert.strictEqual(r.done.length, 3); assert.strictEqual(r.skipped.length, 1);
const added = r.content.symbols.find((s) => s.sonorSymbol.uid === 'new1');
assert.strictEqual(added.sonorSymbol.autoId.id, 'PLAY-WAP-01'); assert.strictEqual(added.sonorSymbol.room, 'Playroom'); assert.strictEqual(added.sonorSymbol.block_code, 'CL-SON-09-WAP-CEIL');
assert.strictEqual(r.content.symbols.find((s) => s.sonorSymbol.uid === 'kit').x, 530); assert(!r.content.symbols.some((s) => s.sonorSymbol.uid === 'out'));
assert(r.content.symbols.some((s) => s.sonorSymbol.uid === 'spk'), 'other symbols untouched'); assert.strictEqual(content.symbols.length, 3, 'input not mutated');
const second = W.applyToContent(content, gf, [{ op: 'add', uid: 'a2', code: 'WAP-CEIL', x: 500, y: 450 }], tpl);
assert.strictEqual(second.content.symbols.at(-1).sonorSymbol.autoId.id, 'KIT-WAP-02', 'numbered after the existing kitchen AP');
console.log('ok  wifi map: rooms, outline mask, AP codes, prediction + calibration, IDW, BSSID match, Takeoffs apply');
assert.strictEqual(W.walls(gf, { x: 520, y: 450 }, { x: 530, y: 470 }), 0, 'same room: no walls');
assert(W.walls(gf, { x: 520, y: 450 }, { x: 880, y: 460 }) >= 4, 'kitchen → living crosses rooms');
assert(W.predict([gf.aps[1]], { x: 880, y: 460 }, gf.scalePxPerM, m, gf) < W.predict([gf.aps[1]], { x: 880, y: 460 }, gf.scalePxPerM, m), 'walls cost signal');
console.log('ok  wall loss');
