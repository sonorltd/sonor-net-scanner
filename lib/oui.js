'use strict';
// MAC address → manufacturer, from the IEEE registry (data/oui.tsv, built from the
// BSD-licensed `oui-data` package). Looks up MA-S (36-bit), MA-M (28-bit) then MA-L (24-bit).
const fs = require('fs');
const path = require('path');

let table = null;
function load() {
  if (table) return table;
  table = new Map();
  try {
    const txt = fs.readFileSync(path.join(__dirname, '..', 'data', 'oui.tsv'), 'utf8');
    for (const line of txt.split('\n')) {
      const t = line.indexOf('\t');
      if (t > 0) table.set(line.slice(0, t), line.slice(t + 1));
    }
  } catch { /* no table: vendors show as unknown */ }
  return table;
}

function normMac(mac) {
  const hex = String(mac || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (hex.length !== 12) return '';
  return hex.match(/../g).join(':');
}

// Locally administered (bit 1 of the first octet): phones and laptops with "private Wi-Fi address" on.
function isRandom(mac) {
  const m = normMac(mac);
  return !!m && (parseInt(m.slice(0, 2), 16) & 2) === 2;
}

function vendor(mac) {
  const hex = normMac(mac).replace(/:/g, '');
  if (!hex) return '';
  const t = load();
  return t.get(hex.slice(0, 9)) || t.get(hex.slice(0, 7)) || t.get(hex.slice(0, 6)) || (isRandom(mac) ? 'Private (randomised) address' : '');
}

module.exports = { vendor, normMac, isRandom };
