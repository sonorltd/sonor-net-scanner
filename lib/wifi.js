'use strict';
// Wi-Fi tools: survey the networks in the air, read the live signal of this device's own connection, and turn a survey
// into a channel plan (how busy each channel is, which one to use, what is set up badly).
// Pi / Linux: nmcli (NetworkManager). Mac: system_profiler (no BSSIDs: macOS hides them). Windows: netsh.
// Android: the app sets hooks (WifiManager scan results) with setPlatform(), like lib/netinfo.js.
const { execFile } = require('child_process');
const { vendor } = require('./oui');

const hooks = {};
function setPlatform(h) { Object.assign(hooks, h || {}); }
const run = (cmd, args, ms = 12000) => new Promise((res) => { try { execFile(cmd, args, { timeout: ms, maxBuffer: 8e6 }, (e, out) => res(e ? '' : String(out))); } catch { res(''); } });

const pctToDbm = (p) => (p == null || isNaN(p) ? null : Math.round(Number(p) / 2 - 100));
const dbmToPct = (d) => (d == null ? null : Math.max(0, Math.min(100, 2 * (Number(d) + 100))));
const bandOf = (f) => (!f ? '' : f >= 5925 ? '6 GHz' : f >= 4900 ? '5 GHz' : '2.4 GHz');
const chanToFreq = (c, band) => { c = Number(c); if (!c) return null; if (band === '6 GHz') return 5950 + 5 * c; if (c <= 14) return c === 14 ? 2484 : 2407 + 5 * c; return 5000 + 5 * c; };
const freqToChan = (f) => (!f ? null : f === 2484 ? 14 : f < 3000 ? (f - 2407) / 5 : f >= 5955 ? (f - 5950) / 5 : (f - 5000) / 5);
// what a signal means on site
function quality(dbm) {
  if (dbm == null) return { label: 'unknown', level: 'info' };
  if (dbm >= -55) return { label: 'excellent', level: 'ok' };
  if (dbm >= -65) return { label: 'good', level: 'ok' };
  if (dbm >= -72) return { label: 'fair: fine for browsing, marginal for 4K / video calls', level: 'warn' };
  if (dbm >= -80) return { label: 'weak: expect drop-outs, needs an access point nearer', level: 'bad' };
  return { label: 'unusable', level: 'bad' };
}
function secOf(s) {
  s = String(s || '').toUpperCase();
  if (!s || s === '--' || /^(NONE|OPEN)$/.test(s) || s === '[ESS]') return 'Open';
  if (/WPA3|SAE/.test(s) && /WPA2|PSK/.test(s.replace(/SAE/g, ''))) return 'WPA2/WPA3';
  if (/WPA3|SAE|OWE/.test(s)) return /OWE/.test(s) ? 'OWE (enhanced open)' : 'WPA3';
  if (/EAP|802\.1X|ENTERPRISE/.test(s)) return 'WPA2-Enterprise';
  if (/WPA2|RSN/.test(s)) return /TKIP/.test(s) && !/CCMP|AES/.test(s) ? 'WPA2 (TKIP)' : 'WPA2';
  if (/WPA/.test(s)) return 'WPA (old)';
  if (/WEP/.test(s)) return 'WEP (broken)';
  return s.slice(0, 24);
}
function norm(n) {
  const freq = n.freq || chanToFreq(n.channel, n.band);
  const band = n.band || bandOf(freq);
  const channel = n.channel != null && n.channel !== '' ? Number(n.channel) : freqToChan(freq);
  const signal = n.signal != null ? Number(n.signal) : pctToDbm(n.signalPct);
  const bssid = String(n.bssid || '').toUpperCase();
  return { ssid: n.ssid || '', hidden: !n.ssid, bssid, vendor: bssid ? vendor(bssid) : '', channel, band, freq, width: n.width || null,
    signal, signalPct: n.signalPct != null ? Number(n.signalPct) : dbmToPct(signal), security: secOf(n.security), inUse: !!n.inUse, rate: n.rate || '' };
}

// ── survey ────────────────────────────────────────────────────────────────
async function surveyLinux() {
  // -e no escapes colons in BSSIDs as \: ; split on unescaped colons
  const t = await run('nmcli', ['-t', '-f', 'IN-USE,BSSID,SSID,CHAN,FREQ,SIGNAL,SECURITY,RATE,BANDWIDTH', 'dev', 'wifi', 'list', '--rescan', 'yes']);
  const out = [];
  for (const line of t.split('\n')) {
    if (!line.trim()) continue;
    const f = line.split(/(?<!\\):/).map((x) => x.replace(/\\:/g, ':'));
    if (f.length < 8) continue;
    out.push({ inUse: f[0] === '*', bssid: f[1], ssid: f[2], channel: f[3], freq: parseInt(f[4], 10) || null, signalPct: Number(f[5]), security: f[6], rate: f[7], width: f[8] ? parseInt(f[8], 10) || null : null });
  }
  return out;
}
async function surveyMac() {
  const t = await run('system_profiler', ['SPAirPortDataType', '-json'], 20000);
  let j; try { j = JSON.parse(t); } catch { return []; }
  const out = [];
  for (const card of ((j.SPAirPortDataType || [])[0] || {}).spairport_airport_interfaces || []) {
    const add = (n, inUse) => {
      const ch = String(n.spairport_network_channel || ''); const m = ch.match(/^(\d+)\s*\(([\d.]+)\s*GHz(?:,\s*(\d+)MHz)?/i);
      const sig = String(n.spairport_signal_noise || '').match(/(-?\d+)\s*dBm/);
      out.push({ inUse, ssid: n._name, channel: m ? m[1] : ch, band: m ? (m[2] === '2' || m[2] === '2.4' ? '2.4 GHz' : m[2] === '6' ? '6 GHz' : '5 GHz') : '', width: m && m[3] ? Number(m[3]) : null,
        signal: sig ? Number(sig[1]) : null, security: n.spairport_security_mode || '' });
    };
    if (card.spairport_current_network_information) add(card.spairport_current_network_information, true);
    for (const n of card.spairport_airport_other_local_wireless_networks || []) add(n, false);
  }
  return out;
}
async function surveyWin() {
  const t = await run('netsh', ['wlan', 'show', 'networks', 'mode=bssid']);
  const out = []; let ssid = ''; let sec = ''; let cur = null;
  for (const raw of t.split(/\r?\n/)) {
    const l = raw.trim(); let m;
    if ((m = l.match(/^SSID \d+ : ?(.*)$/))) { ssid = m[1]; sec = ''; cur = null; }
    else if ((m = l.match(/^Authentication\s*: (.*)$/))) sec = m[1];
    else if ((m = l.match(/^BSSID \d+\s*: (.*)$/))) { cur = { ssid, security: sec, bssid: m[1] }; out.push(cur); }
    else if (cur && (m = l.match(/^Signal\s*: (\d+)%/))) cur.signalPct = Number(m[1]);
    else if (cur && (m = l.match(/^Channel\s*: (\d+)/))) cur.channel = m[1];
    else if (cur && (m = l.match(/^Band\s*: ([\d.]+) GHz/))) cur.band = m[1] === '2.4' ? '2.4 GHz' : m[1] + ' GHz';
  }
  return out;
}
async function survey() {
  const t0 = Date.now();
  let raw = [];
  if (hooks.survey) raw = await hooks.survey();
  else if (process.platform === 'linux') raw = await surveyLinux();
  else if (process.platform === 'darwin') raw = await surveyMac();
  else if (process.platform === 'win32') raw = await surveyWin();
  const networks = raw.map(norm).filter((n) => n.channel || n.freq).sort((a, b) => (b.signal ?? -200) - (a.signal ?? -200));
  const note = !raw.length ? (process.platform === 'linux' ? 'No Wi-Fi results: is there a Wi-Fi adapter and is NetworkManager running? (On the rig, the hotspot radio can still scan.)'
    : process.platform === 'darwin' ? 'No results: macOS needs Location Services allowed for Terminal / Node to list Wi-Fi networks.' : 'No Wi-Fi results from this device.') : (process.platform === 'darwin' && !hooks.survey ? 'macOS hides access point MAC addresses, so each network shows once.' : '');
  return { at: new Date().toISOString(), seconds: +((Date.now() - t0) / 1000).toFixed(1), networks, note, analysis: analyse(networks) };
}

// ── this device's live link (for the signal meter / walk) ─────────────────
async function link() {
  if (hooks.link) return hooks.link();
  const p = process.platform;
  if (p === 'linux') {
    const t = await run('nmcli', ['-t', '-f', 'IN-USE,BSSID,SSID,CHAN,FREQ,SIGNAL,RATE', 'dev', 'wifi', 'list', '--rescan', 'no'], 4000);
    const on = t.split('\n').find((l) => l.startsWith('*'));
    if (on) { const f = on.split(/(?<!\\):/).map((x) => x.replace(/\\:/g, ':')); const n = norm({ bssid: f[1], ssid: f[2], channel: f[3], freq: parseInt(f[4], 10) || null, signalPct: Number(f[5]), rate: f[6] }); return { ...n, quality: quality(n.signal) }; }
    const l = await run('iw', ['dev', 'wlan0', 'link'], 3000);
    const sig = (l.match(/signal:\s*(-?\d+)/) || [])[1]; if (!sig) return null;
    const n = norm({ ssid: (l.match(/SSID:\s*(.+)/) || [])[1], bssid: (l.match(/Connected to ([0-9a-f:]{17})/i) || [])[1], freq: Number((l.match(/freq:\s*(\d+)/) || [])[1]) || null, signal: Number(sig), rate: (l.match(/tx bitrate:\s*([\d.]+ \S+)/) || [])[1] });
    return { ...n, quality: quality(n.signal) };
  }
  if (p === 'darwin') { const s = await surveyMac(); const c = s.find((x) => x.inUse); if (!c) return null; const n = norm(c); return { ...n, quality: quality(n.signal) }; }
  if (p === 'win32') {
    const t = await run('netsh', ['wlan', 'show', 'interfaces'], 4000);
    const g = (k) => ((t.match(new RegExp(`^\\s*${k}\\s*:\\s*(.+)$`, 'mi')) || [])[1] || '').trim();
    if (!g('SSID')) return null;
    const n = norm({ ssid: g('SSID'), bssid: g('BSSID') || g('AP BSSID'), channel: g('Channel'), band: (g('Band').match(/[\d.]+/) || [''])[0] ? (g('Band').startsWith('2') ? '2.4 GHz' : g('Band').replace(/\s*GHz.*/, '') + ' GHz') : '', signalPct: parseInt(g('Signal'), 10), rate: g('Receive rate \\(Mbps\\)') });
    return { ...n, quality: quality(n.signal) };
  }
  return null;
}

// ── channel plan ──────────────────────────────────────────────────────────
// 2.4 GHz: a 20 MHz channel spreads ±2 channels (1, 6, 11 never overlap). Load on c = Σ over networks of weight(signal) × overlap.
const weight = (dbm) => Math.max(0.05, Math.min(1, ((dbm ?? -90) + 95) / 45)); // -50 dBm = 1, -90 = 0.1
const DFS = new Set([52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 144]);
const FIVE = [36, 40, 44, 48, 52, 56, 60, 64, 100, 104, 108, 112, 116, 120, 124, 128, 132, 136, 140, 149, 153, 157, 161, 165];
function span5(n) { // 20 MHz channels a 5 GHz network covers, from its width and primary channel
  const w = n.width || 20; const c = n.channel; if (w <= 20) return [c];
  const blk = w === 40 ? 2 : w === 80 ? 4 : 8; const base = c >= 149 ? 149 : 36; const idx = Math.floor((c - base) / 4 / blk) * blk;
  return Array.from({ length: blk }, (_, i) => base + (idx + i) * 4);
}
function analyse(networks) {
  const two = networks.filter((n) => n.band === '2.4 GHz' && n.channel >= 1 && n.channel <= 14);
  const five = networks.filter((n) => n.band === '5 GHz');
  const load24 = {}; for (let c = 1; c <= 13; c++) load24[c] = 0;
  for (const n of two) for (let c = 1; c <= 13; c++) { const d = Math.abs(c - n.channel); if (d <= 4) load24[c] += weight(n.signal) * (d <= 2 ? 1 : 0.35); }
  const load5 = {}; for (const c of FIVE) load5[c] = 0;
  for (const n of five) for (const c of span5(n)) if (c in load5) load5[c] += weight(n.signal);
  const best24 = [1, 6, 11].map((c) => ({ channel: c, load: +load24[c].toFixed(2) })).sort((a, b) => a.load - b.load);
  const best5 = FIVE.filter((c) => !DFS.has(c)).map((c) => ({ channel: c, load: +load5[c].toFixed(2) })).sort((a, b) => a.load - b.load || a.channel - b.channel);
  const best5dfs = FIVE.filter((c) => DFS.has(c)).map((c) => ({ channel: c, load: +load5[c].toFixed(2) })).sort((a, b) => a.load - b.load || a.channel - b.channel);
  const flags = [];
  const add = (level, title, text) => flags.push({ level, title, text });
  const odd = two.filter((n) => ![1, 6, 11].includes(n.channel) && n.signal > -75);
  if (odd.length) add('warn', `${odd.length} network${odd.length > 1 ? 's' : ''} on 2.4 GHz channels other than 1, 6 or 11`, `${[...new Set(odd.map((n) => `${n.ssid || 'hidden'} (ch ${n.channel})`))].slice(0, 5).join(', ')}. Channels in between overlap two clean channels at once. Ours should be on 1, 6 or 11.`);
  const wide24 = two.filter((n) => (n.width || 20) >= 40 && n.signal > -75);
  if (wide24.length) add('warn', '40 MHz on 2.4 GHz', `${[...new Set(wide24.map((n) => n.ssid || 'hidden'))].slice(0, 4).join(', ')} use 40 MHz on 2.4 GHz, which takes most of the band. Set 2.4 GHz to 20 MHz.`);
  const open = networks.filter((n) => n.security === 'Open' && n.ssid);
  if (open.length) add('info', `${new Set(open.map((n) => n.ssid)).size} open network${open.length > 1 ? 's' : ''}`, `${[...new Set(open.map((n) => n.ssid))].slice(0, 5).join(', ')}: no password. Fine for a guest portal, never for the client's own kit.`);
  const weak = networks.filter((n) => /WEP|TKIP|WPA \(old\)/.test(n.security));
  if (weak.length) add('bad', 'Old, breakable Wi-Fi security', `${[...new Set(weak.map((n) => `${n.ssid || 'hidden'} (${n.security})`))].slice(0, 4).join(', ')}. Change to WPA2 (AES) or WPA2/WPA3.`);
  const bySsid = {}; for (const n of networks) if (n.ssid) (bySsid[n.ssid] = bySsid[n.ssid] || []).push(n);
  for (const [s, list] of Object.entries(bySsid)) { const secs = new Set(list.map((n) => n.security)); if (secs.size > 1) add('warn', `"${s}" has mixed security`, `Access points broadcasting "${s}" use ${[...secs].join(' and ')}. Devices roam badly between them: set every AP the same.`); }
  const busy = best24[0] && best24[0].load > 2.5;
  if (busy) add('info', '2.4 GHz is crowded here', `Even the quietest clean channel (${best24[0].channel}) has ${best24[0].load} units of load. Put what you can on 5 GHz and keep 2.4 GHz for IoT.`);
  const counts = { total: networks.length, ssids: Object.keys(bySsid).length, hidden: networks.filter((n) => n.hidden).length, ghz24: two.length, ghz5: five.length, ghz6: networks.filter((n) => n.band === '6 GHz').length };
  return { counts, load24, load5, best24, best5, best5dfs, recommend: { ghz24: best24[0] ? best24[0].channel : null, ghz5: best5[0] ? best5[0].channel : null, ghz5dfs: best5dfs[0] ? best5dfs[0].channel : null }, flags };
}

module.exports = { survey, link, analyse, quality, setPlatform, pctToDbm, dbmToPct, norm, _parse: { surveyLinux, surveyWin } };
