// findingRows (public/index.html): what an Upload reports to the shared site_findings table. Run: node test/findings.test.js
const fs = require('fs'), path = require('path'), assert = require('assert');
const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const src = html.slice(html.indexOf('function findingRows('), html.indexOf('async function reportFindings('));
const findingRows = new Function(src + '; return findingRows;')();
const devices = [
  { ip: '192.168.1.10', mac: 'ac-b9-2f-37-a2-2c', make: 'Hikvision', model: 'DS-7608', serial: 'S1', firmware: '4.1', service: '06_cctv' },
  { ip: '192.168.1.11', mac: 'AC:B9:2F:37:A2:2C', make: 'dup' },                       // same MAC twice → one row
  { ip: '192.168.1.20', name: 'EA-5', service: '05_control' },                        // no MAC → ip key
  { ip: '192.168.1.50', mac: '11:22:33:44:55:66', service: 'client' },                // personal device → left out
  { ip: '192.168.1.2', mac: '66:55:44:33:22:11', isSelf: true },                      // the scanner itself → left out
  { ip: '192.168.1.30', mac: 'not-a-mac' },
];
const notes = { 'AC-B9-2F-37-A2-2C': { name: 'Rack NVR', note: 'top shelf' } };
const rows = findingRows('pid-1', devices, '2026-11-26T10:00:00Z', notes, 'scan:x');
assert.strictEqual(rows.length, 3);
assert.deepStrictEqual(rows.map((r) => r.key), ['mac:AC:B9:2F:37:A2:2C', 'ip:192.168.1.20', 'ip:192.168.1.30']);
assert.strictEqual(rows[0].name, 'Rack NVR'); assert.strictEqual(rows[0].detail.notes, 'top shelf'); assert.strictEqual(rows[0].detail.named_by_engineer, true);
assert.strictEqual(rows[0].mac, 'AC:B9:2F:37:A2:2C'); assert.strictEqual(rows[0].serial, 'S1');
assert.strictEqual(rows[1].name, 'EA-5'); assert.strictEqual(rows[2].name, '192.168.1.30'); assert.strictEqual(rows[2].mac, null);
const cols = Object.keys(rows[0]).join(); assert(rows.every((r) => Object.keys(r).join() === cols), 'a bulk upsert needs the same columns in every row');
for (const banned of ['state', 'placement_uid', 'reviewed_at', 'reviewed_by']) assert(rows.every((r) => !(banned in r)), 'site apps never send ' + banned);
assert(rows.every((r) => r.source_app === 'scanner' && r.project_id === 'pid-1' && r.name));
console.log('findings.test.js: 12 checks passed');
