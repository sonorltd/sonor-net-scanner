'use strict';
// Wi-Fi survey parsing + channel plan, with a fake nmcli on PATH (no Wi-Fi adapter needed).
const assert = require('assert'); const path = require('path');
if (process.platform !== 'linux') { console.log('wifi test: linux only, skipped'); process.exit(0); }
process.env.PATH = path.join(__dirname, 'fakebin') + path.delimiter + process.env.PATH;
const W = require('../lib/wifi');
(async () => {
  const s = await W.survey();
  assert.strictEqual(s.networks.length, 7);
  const mine = s.networks.find((n) => n.inUse); assert.strictEqual(mine.ssid, 'Sonor-Demo'); assert.strictEqual(mine.band, '5 GHz'); assert.strictEqual(mine.channel, 44); assert.strictEqual(mine.signal, -59); assert.strictEqual(mine.bssid, 'AA:BB:CC:00:00:01');
  assert.ok(s.networks.find((n) => n.hidden), 'hidden network kept');
  assert.strictEqual(s.networks.find((n) => n.ssid === 'Cafe Free').security, 'Open');
  const A = s.analysis; const t = A.flags.map((f) => f.title).join(' | ');
  assert.ok(/other than 1, 6 or 11/.test(t), t); assert.ok(/40 MHz on 2.4/.test(t), t); assert.ok(/mixed security/.test(t), t); assert.ok(/open network/.test(t), t);
  assert.ok([1, 6, 11].includes(A.recommend.ghz24)); assert.notStrictEqual(A.recommend.ghz5, 44);
  const l = await W.link(); assert.strictEqual(l.ssid, 'Sonor-Demo'); assert.strictEqual(l.quality.level, 'ok');
  console.log('wifi ok:', s.networks.length, 'networks · recommend 2.4 GHz ch', A.recommend.ghz24, '· 5 GHz ch', A.recommend.ghz5, '· flags:', t);
})().catch((e) => { console.error(e); process.exit(1); });
