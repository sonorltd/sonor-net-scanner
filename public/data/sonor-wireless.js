/* sonor-wireless.js v1.0.0 (2026-11-24) — the ONE wireless toolkit for every Sonor app (window.SonorWireless, or require()).
 * Wi-Fi ↔ Zigbee channel maths, the mesh systems and their maker codes, RF / Zigbee hub guidance, the probe grades,
 * the RF frequencies and the Sonor probe HTTP paths. Used by Network Scanner (page, Pi agent, Android agent) and meant
 * for Takeoffs' wireless planning layer, Site and Remotes, so a channel, a grade or a hub tip means the same everywhere.
 * Workspace master: ~/Code/Sonor/sonor-wireless.js → sync-everything.sh copies it to every APP - * /data/ (and public/data/
 * for the Scanner and Remotes). Never hand-edit a copy. Rule ids in comments refer to wifi-rf-rules.json (research thread).
 */
(function (root) {
  'use strict';
  // ── Zigbee / Thread (802.15.4) channels 11–26 sit in the 2.4 GHz Wi-Fi band: 2405 + 5 × (k − 11) MHz, 2 MHz wide ──
const ZB = Array.from({ length: 16 }, (_, i) => i + 11);
const zbFreq = (k) => 2405 + 5 * (k - 11);
const wifiFreq24 = (c) => (c === 14 ? 2484 : 2407 + 5 * c);
const rfW = (rssi) => (rssi == null || rssi < -90 ? 0 : Math.pow(10, (rssi + 95) / 10));   // wifi.score.algorithm weight
function zigbeeLoad(nets) {   // per Zigbee channel: Wi-Fi spans covering its centre ±1 MHz (zb.overlap.math, zb.pick.algorithm)
  return ZB.map((k) => { const f = zbFreq(k); let mw = 0, score = 0; const who = [];
    for (const n of nets) { if (n.band !== '2.4 GHz' || n.signal == null) continue; const w = n.width || 20; const cf = n.centerFreq || (wifiFreq24(n.channel) + (w >= 40 ? 10 : 0)); const half = w / 2 + 1;
      if (Math.abs(f - cf) < half + 1) { mw += Math.pow(10, n.signal / 10); score += rfW(n.signal); who.push(n); } }
    return { ch: k, freq: f, dbm: mw ? Math.round(10 * Math.log10(mw)) : null, score, who: who.sort((a, b) => b.signal - a.signal) }; });
}
  const ZB_C4 = [15, 20, 25];   // c4.zigbee.channels
  // Each Zigbee system runs its own mesh on one channel. k = key used in stored settings and uploads.
const ZB_SYS = [
  { k: 'c4', name: 'Control4', pref: [15, 20, 25], from: 'Composer › Network › Zigbee' },
  { k: 'neo', name: 'Heatmiser neo', pref: null, from: 'neoHub' },
  { k: 'hue', name: 'Hue', pref: [11, 15, 20, 25], from: 'Hue app › Settings › Bridge' },
  { k: 'other', name: 'Other (Thread / Matter, Lutron Type X…)', pref: null, from: 'the hub' },
];
const ZB_LEVELS = { solid: -75, marginal: -85 };   // draft, calibrate on the first unit (Zigbee receivers reach about -100 dBm)
const zbVerdict = (rssi) => (rssi == null ? ['—', ''] : rssi >= ZB_LEVELS.solid ? ['Solid', 'ok'] : rssi >= ZB_LEVELS.marginal ? ['Marginal', 'warn'] : ['Fail', 'bad']);
const ZB_OUI = [[/^00:0F:FF/i, 'c4', 'Control4'], [/^00:17:88/i, 'hue', 'Philips Hue'], [/^EC:1B:BD|^00:0B:57|^90:FD:9F/i, 'other', 'Silicon Labs module']];
const zbMaker = (m) => { const o = ZB_OUI.find(([re]) => re.test(m.ext || '')); return o ? { sys: o[1], name: o[2] } : null; };

  // ── Sub-GHz RF + Zigbee hub guidance (zb: true = a Zigbee coordinator, shown on the Zigbee tab) ──
const RF_GUIDE = [
  { test: (d) => /bond/i.test(d.make), band: '300–450 MHz RF (learns the existing remotes) · Wi-Fi to the LAN', tips: ['Central and high, out of racks and metal boxes, in line of sight of as many motors as practical.', 'One Bond covers a typical floor; add a second per floor where the probe shows marginal results.', 'Give it a DHCP reservation; Control4 drives it over the Bond local API.'] },
  { test: (d) => /somfy/i.test(d.make), band: 'RTS 433.42 MHz (one-way) and io-homecontrol 868 MHz (two-way)', tips: ['RTS reaches about 20 m with no more than two internal walls (Somfy quotes 65 ft).', 'RTS is one-way: a missed command looks like a stuck blind, so probe-test every motor from where the transmitter will live; failures need it moved or an extra transmitter.', 'Local API (port 8443) only after Developer Mode is turned on in the Somfy account.'] },
  { test: (d) => /lutron/i.test(d.make), band: 'Clear Connect Type A (UK/EU 868 MHz, US 434 MHz) or Type X (RA3, 2.4 GHz 802.15.4)', tips: ['Every device within 9 m of the processor or a repeater; repeaters within 18 m of each other (Lutron).', 'Never in a metal enclosure or rack.', 'UK systems are 868 MHz: a 433 MHz probe will not measure them; read the frequency on the model label.'] },
  { zb: true, test: (d) => /hue/i.test(d.make) || /hue bridge/i.test(d.kind), band: 'Zigbee 2.4 GHz (channel 11, 15, 20 or 25)', tips: ['Pick the Hue Zigbee channel away from the busiest Wi-Fi (the Zigbee tab shows the clearest channels here).', 'Mains-powered bulbs and plugs repeat: keep some always powered.'] },
  { zb: true, test: (d) => /control4/i.test(d.make) && /controller|director|core|ea-|ca-/i.test(`${d.kind} ${d.model}`), band: 'Zigbee 2.4 GHz mesh (Control4 lighting, keypads, remotes)', tips: ['Zigbee on 15, 20 or 25, picked on the Zigbee tab; never left on the default.', 'Mesh controller never in the rack (secondary controller centrally, or the C4-AK-3M antenna kit) and never on Wi-Fi; every AP at least 5 m away.', 'Max 70 nodes per mesh; 5–9 m between Zigbee devices.'] },
  { zb: true, test: (d) => /heatmiser/i.test(d.make) || /neohub/i.test(d.kind), band: 'Zigbee 2.4 GHz (Heatmiser neo mesh: neoStat, neoAir, neoPlug)', tips: ['Its own Zigbee mesh, separate from Control4 and Hue: check which Zigbee channel the neoHub is on and keep it off the Control4 and Hue channels and away from the busiest Wi-Fi (Zigbee tab).', 'neoHub wired to the LAN, central and out of the rack; mains neoStats repeat, battery neoAir / neoStat-e do not, so plan a mains neoStat or neoPlug between the hub and far battery stats.', 'Control4 drives it over the neoHub local API (port 4242 legacy, 4243 websocket); give it a DHCP reservation.', 'Draft: Heatmiser ranges are not researched yet.'] },
  { test: (d) => /shelly/i.test(d.make), band: 'Wi-Fi 2.4 GHz', tips: ['Shelly relays sit in back boxes: check Wi-Fi at the box with the walk test before plastering.'] },
];
  const guideFor = (d) => RF_GUIDE.find((g) => g.test(d)) || null;
  // rf.probe.grades (heuristic: calibrate on the first unit): graded on the worse of level and margin
const RF_LEVELS = { solid: { dbm: -80, margin: 20 }, marginal: { dbm: -95, margin: 10 } };
const rfVerdict = (m, peak) => { if (m == null) return ['—', '']; const p = peak == null ? 0 : peak; if (p >= RF_LEVELS.solid.dbm && m >= RF_LEVELS.solid.margin) return ['Solid', 'ok']; if (p >= RF_LEVELS.marginal.dbm && m >= RF_LEVELS.marginal.margin) return ['Marginal', 'warn']; return ['Fail', 'bad']; };
  const RF_FREQS = [
    { mhz: 433.42, label: '433.42 MHz · Somfy RTS', match: /somfy/i },
    { mhz: 433.92, label: '433.92 MHz · most 433 remotes, Bond', match: /bond/i },
    { mhz: 315, label: '315 MHz · US fans / blinds', match: null },
    { mhz: 868.3, label: '868.3 MHz · Somfy io (868 module)', match: null },
  ];
  // The RF frequency to start on, from the hubs a scan found (null = leave the engineer's choice)
  const rfFreqFor = (devices) => { const t = (devices || []).map((d) => `${d.make} ${d.kind}`).join(' '); const f = RF_FREQS.find((x) => x.match && x.match.test(t)); return f ? f.mhz : null; };

  // ── Sonor probes on the site Wi-Fi (rf-probe/: ESP32 + CC1101, zb-probe/: ESP32-C6) ──
  const PROBES = {
    rf: { service: '_sonor-rf._tcp', kind: 'Sonor RF probe', hotspot: 'Sonor-RF-Probe' },
    zb: { service: '_sonor-zb._tcp', kind: 'Sonor Zigbee probe', hotspot: 'Sonor-ZB-Probe' },
  };
  // HTTP path + timeout for one probe call; the Pi agent, the Android agent and any page use the same table.
  function probePath(kind, a) {
    a = a || {};
    if (kind === 'rf') return { path: a.mhz ? 'freq?mhz=' + encodeURIComponent(a.mhz) : 'rssi', timeout: 2000 };
    if (kind === 'zb') { const op = a.op || 'listen'; if (op === 'scan') return { path: 'scan', timeout: 9000 }; if (op === 'energy') return { path: 'energy', timeout: 9000 };
      return { path: 'listen?' + (a.ch ? 'ch=' + Number(a.ch) : '') + (a.reset ? '&reset=1' : ''), timeout: 2000 }; }
    throw new Error('unknown probe kind ' + kind);
  }
  const isProbe = (d, kind) => new RegExp(PROBES[kind].kind.replace('Sonor ', ''), 'i').test((d && d.kind) || '');

  // Research rules (wifi-rf-rules.json): load once, then API.rules[id] = { text, sources, strength, rule? }
  async function loadRules(url) { try { const r = await fetch(url || 'data/wifi-rf-rules.json'); const j = await r.json(); const list = Array.isArray(j) ? j : j.rules || []; API.rules = Object.fromEntries(list.map((x) => [x.id, x])); } catch (e) { API.rules = API.rules || {}; } return API.rules; }

  const API = { VERSION: '1.0.0', ZB, ZB_C4, zbFreq, wifiFreq24, rfW, zigbeeLoad, ZB_SYS, ZB_LEVELS, zbVerdict, ZB_OUI, zbMaker,
    RF_GUIDE, guideFor, RF_LEVELS, rfVerdict, RF_FREQS, rfFreqFor, PROBES, probePath, isProbe, loadRules, rules: {} };
  if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.SonorWireless = API;
})(typeof window !== 'undefined' ? window : globalThis);
