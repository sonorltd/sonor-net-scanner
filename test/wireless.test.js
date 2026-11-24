// Shared wireless module (data/sonor-wireless.js): the numbers every app relies on.
const assert = require('assert');
const W = require('../public/data/sonor-wireless.js');
const load = (ch, w = 20, s = -50) => W.zigbeeLoad([{ band: '2.4 GHz', signal: s, channel: ch, width: w }]).filter((z) => z.dbm != null).map((z) => z.ch);
assert.deepStrictEqual(load(1), [11, 12, 13, 14]);          // research: Wi-Fi 1 covers Zigbee 11–14
assert.deepStrictEqual(load(6), [16, 17, 18, 19]);
assert.deepStrictEqual(load(11), [21, 22, 23, 24]);          // "Wi-Fi 11 hits 21–24"
assert.ok(load(12).includes(25) && load(13).includes(25));    // 12/13 spoil 25
assert.strictEqual(W.zbFreq(25), 2475);
assert.deepStrictEqual(W.ZB_C4, [15, 20, 25]);
assert.strictEqual(W.zbMaker({ ext: '00:0F:FF:00:12:9A:4C:01' }).sys, 'c4');
assert.strictEqual(W.zbMaker({ ext: '00:17:88:01:0B:44:2F:90' }).sys, 'hue');
assert.strictEqual(W.zbMaker({ ext: 'CC:CC:CC:FF:FE:7A:31:52' }), null);
assert.deepStrictEqual(W.zbVerdict(-70)[0], 'Solid'); assert.deepStrictEqual(W.zbVerdict(-80)[0], 'Marginal'); assert.deepStrictEqual(W.zbVerdict(-90)[0], 'Fail');
assert.strictEqual(W.rfVerdict(25, -60)[0], 'Solid'); assert.strictEqual(W.rfVerdict(12, -90)[0], 'Marginal'); assert.strictEqual(W.rfVerdict(5, -70)[0], 'Fail');
assert.strictEqual(W.rfFreqFor([{ make: 'Somfy', kind: 'TaHoma' }]), 433.42);
assert.strictEqual(W.rfFreqFor([{ make: 'Bond', kind: 'Bond Bridge' }]), 433.92);
assert.strictEqual(W.rfFreqFor([{ make: 'Sonos' }]), null);
assert.deepStrictEqual(W.probePath('zb', { op: 'listen', ch: 20, reset: 1 }), { path: 'listen?ch=20&reset=1', timeout: 2000 });
assert.strictEqual(W.probePath('rf', { mhz: 433.92 }).path, 'freq?mhz=433.92');
assert.ok(W.isProbe({ kind: 'Sonor Zigbee probe' }, 'zb') && !W.isProbe({ kind: 'Sonor Zigbee probe' }, 'rf'));
assert.ok(W.guideFor({ make: 'Heatmiser', kind: 'neoHub' }).zb && !W.guideFor({ make: 'Somfy', kind: 'TaHoma' }).zb);
console.log('ok  shared wireless module: Zigbee overlap, makers, grades, RF frequency, probe paths, hub guides');
