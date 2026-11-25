'use strict';
// Long-term site log for the Network Scanner agent (v1.8.0). Bryn: "we also need long term logging for troubleshooting" · "we dont need
// it running non stop for every project, only usually on site or occasionally long term for fixing something on a trouble site" · "but we
// do need max features for ultimate troubleshooting across the suite".
// Nothing runs until a log session is armed (sonor-sitelog.js: Site visit = 12 h, Trouble watch = 1–30 days, survives a reboot).
// While armed, in the agent on the site Pi (or a laptop left on site), with or without a page open:
//   every 60 s  wifi    one minute line per place (this agent + every node with wifi-scan): channel levels + grades, networks heard,
//                       best 1/6/11; source lines when a strong network appears, goes or changes channel; alerts on 6 dB jumps (sp.log)
//               rf      per RF probe: noise floor (median of 5 s reads), peak, bursts; alert when the floor rises 6 dB
//               traffic packets, broadcast / multicast per second, top protocols, top talkers, every new fault as an alert;
//                       keeps a capture running (keepCapture) and a rolling pcap ring for Wireshark (pcapRing)
//   every 2 min artnet  nodes seen, nodes gone / new, new faults
//   every 5 min zigbee  energy sweep per Zigbee probe, alerts on channels over -70 dBm
//   always      source lines when a node / probe goes offline or comes back, and battery level
const fs = require('fs');
const path = require('path');
const W = require('../public/data/sonor-wireless.js');

const DEFAULTS = { wifi: true, rf: true, zigbee: true, artnet: true, traffic: true, keepCapture: true, pcapRing: true, pcapFiles: 40 };
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

function start({ dataDir, actions, probeGet, log }) {
  const cfgFile = path.join(dataDir, 'logger.json');
  let cfg = { ...DEFAULTS }; try { Object.assign(cfg, JSON.parse(fs.readFileSync(cfgFile, 'utf8'))); } catch { /* defaults */ }
  const st = { bss: {}, armed: false, started: { cap: false, ring: false }, base: {}, online: new Map(), artnetIps: null, artnetFaults: new Set(), trafficFaults: new Set(), lastTraffic: null, rf: {}, counts: {}, lastAt: {}, busy: {} };
  const count = (tool) => { st.counts[tool] = (st.counts[tool] || 0) + 1; st.lastAt[tool] = new Date().toISOString(); };
  const once = async (name, fn) => { if (st.busy[name]) return; st.busy[name] = true; try { await fn(); } catch (e) { log.write('source', { tool: name, src: 'agent', state: 'error', text: e.message }); } st.busy[name] = false; };
  const label = (n) => n.spot || n.name || n.ip;
  // rolling baseline per place + channel (median of the last 60 readings); alert when it jumps 6 dB over (sp.log)
  function rise(key, v, minLvl) { const b = st.base[key] = st.base[key] || []; const m = median(b); b.push(v); if (b.length > 60) b.shift(); return b.length > 5 && m != null && v >= minLvl && v >= m + 6 ? m : null; }

  async function nodes() { const [, r] = await actions.nodes({}); const list = (r && r.nodes) || [];
    for (const n of list) { const was = st.online.get(n.ip); const now = n.online !== false; if (was !== undefined && was !== now) log.write('source', { tool: 'nodes', src: label(n), ip: n.ip, kind_of: n.kind, state: now ? 'online' : 'offline', battery: n.battery }); st.online.set(n.ip, now); }
    return list.filter((n) => n.online !== false); }
  const caps = (n, c) => (n.caps || []).includes(c);

  async function minute() {
    const list = await nodes().catch(() => []);
    if (cfg.wifi) await once('wifi', async () => { const ips = list.filter((n) => caps(n, 'wifi-scan') || caps(n, 'wifi-scan-5')).map((n) => n.ip); const [, r] = await actions.wifiMon({ ips, self: true });
      for (const s of r.sources || []) { const n = list.find((x) => x.ip === s.ip); const src = s.kind === 'agent' ? 'agent' : n ? label(n) : s.ip; if (s.error) continue;
        const ld = W.wifiChannelLoad(s.aps); const b5 = Object.fromEntries(ld.b5.filter((c) => c.lvl).map((c) => [c.ch, c.lvl]));
        log.write('minute', { tool: 'wifi', src, ip: s.ip || null, n: (s.aps || []).length, b24: ld.b24.map((c) => c.lvl), g24: ld.b24.map((c) => c.grade), b5, best24: W.sitePick([ld]).b24[0].ch }); count('wifi');
        const seen = st.bss[src] = st.bss[src] || {}; const now = {};   // strong networks (≥ −75 dBm) appearing, going or changing channel
        for (const a of s.aps || []) { if (a.rssi < -75 || !a.bssid) continue; now[a.bssid] = a; const o = seen[a.bssid];
          if (!o) { if (Object.keys(seen).length) log.write('source', { tool: 'wifi', src, state: 'network appeared', ssid: a.ssid, bssid: a.bssid, ch: a.ch, rssi: a.rssi }); }
          else if (Number(o.ch) !== Number(a.ch)) log.alert({ tool: 'wifi', src, level: 'info', ssid: a.ssid, bssid: a.bssid, ch: a.ch, was: o.ch, text: `${src}: ${a.ssid || 'hidden network'} moved from channel ${o.ch} to ${a.ch}` }); }
        for (const [b, o] of Object.entries(seen)) if (!now[b] && (o.gone = (o.gone || 0) + 1) === 3) log.write('source', { tool: 'wifi', src, state: 'network gone', ssid: o.ssid, bssid: b, ch: o.ch });
        for (const [b, a] of Object.entries(now)) seen[b] = a; for (const [b, o] of Object.entries(seen)) if (!now[b] && o.gone >= 3) delete seen[b];
        for (const c of [...ld.b24, ...ld.b5]) { const m = rise(`wifi|${src}|${c.ch}`, c.lvl, W.LOAD_LEVELS.busy); if (m != null) log.alert({ tool: 'wifi', src, ch: c.ch, lvl: c.lvl, base: m, rule: 'sp.log', text: `${src}: Wi-Fi channel ${c.ch} jumped from ${m} to ${c.lvl} (loudest ${c.top} dBm)` }); } } });
    if (cfg.rf) for (const n of list.filter((x) => x.kind === 'rf' || caps(x, 'rf433-rssi'))) { const s = st.rf[n.ip]; if (!s || !s.reads.length) continue; const floor = median(s.reads.map((x) => x.floor ?? x.rssi)); const peak = Math.max(...s.reads.map((x) => x.peak ?? x.rssi));
      const bursts = s.bursts1 != null && s.bursts0 != null ? Math.max(0, s.bursts1 - s.bursts0) : null; log.write('minute', { tool: 'rf', src: label(n), ip: n.ip, mhz: s.mhz, floor, peak, bursts }); count('rf');
      const m = rise(`rf|${n.ip}`, floor, -100); if (m != null) log.alert({ tool: 'rf', src: label(n), mhz: s.mhz, floor, base: m, rule: 'sp.log', text: `${label(n)}: ${s.mhz} MHz noise floor rose from ${m} to ${floor} dBm` });
      st.rf[n.ip] = { reads: [], mhz: s.mhz, bursts0: s.bursts1, bursts1: s.bursts1 }; }
    if (cfg.traffic) await once('traffic', async () => { const C = require('./capture'); const r = C.read({ since: Number.MAX_SAFE_INTEGER });
      if (!r.running && cfg.keepCapture) { const x = C.start({ preset: 'all' }); st.started.cap = !x.error; log.write('source', { tool: 'traffic', src: 'agent', state: x.error ? 'capture could not start' : 'capture started for the log', text: x.error || '' }); return; }
      if (!r.running || !r.stats) { st.lastTraffic = null; return; } const s = r.stats; const p = st.lastTraffic; st.lastTraffic = { pkts: s.pkts, bcast: s.bcast, mcast: s.mcast, bytes: s.bytes, byWhat: s.byWhat };
      if (p && s.pkts >= p.pkts) { const top = Object.entries(s.byWhat || {}).map(([w, v]) => [w, v.pkts - ((p.byWhat || {})[w] ? p.byWhat[w].pkts : 0)]).filter(([, d]) => d > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
        log.write('minute', { tool: 'traffic', src: 'agent', pkts: s.pkts - p.pkts, bytes: s.bytes - p.bytes, bcastPs: +((s.bcast - p.bcast) / 60).toFixed(1), mcastPs: +((s.mcast - p.mcast) / 60).toFixed(1), top: Object.fromEntries(top), talkers: (r.stats.talkers || []).slice(0, 8).map((t) => ({ ip: t.addr, pkts: t.pkts, what: t.what })), ring: C.ringRunning() }); count('traffic'); }
      const F = require('../public/data/traffic-faults.js').faults(s); for (const f of F) { const k = f.id + '|' + f.level; if (!st.trafficFaults.has(k) && f.level !== 'info') log.alert({ tool: 'traffic', src: 'agent', level: f.level === 'bad' ? 'bad' : 'warn', rule: f.id, text: f.text }); }
      st.trafficFaults = new Set(F.map((f) => f.id + '|' + f.level)); });
  }
  async function rfRead() { if (!log.on || !cfg.rf) return; for (const [ip, on] of st.online) { if (!on) continue; const s = st.rf[ip] = st.rf[ip] || { reads: [] }; if (s.skip) continue;
      try { const [, r] = await probeGet('rf', ip, {}); if (r.rssi == null) { s.skip = true; continue; } s.reads.push(r); s.mhz = r.mhz; if (s.bursts0 == null) s.bursts0 = r.bursts; s.bursts1 = r.bursts; } catch { /* the minute line notes nothing */ } } }
  async function artnet() { if (!log.on || !cfg.artnet) return; await once('artnet', async () => { const [, r] = await actions.artnet({ op: 'poll' }); if (r.error) return; const nodes = r.nodes || [];
      const ips = new Set(nodes.map((n) => n.ip)); if (st.artnetIps) { for (const n of nodes) if (!st.artnetIps.has(n.ip)) log.write('source', { tool: 'artnet', src: n.shortName || n.ip, ip: n.ip, state: 'appeared' }); for (const ip of st.artnetIps) if (!ips.has(ip)) log.alert({ tool: 'artnet', src: ip, ip, text: `Art-Net node ${ip} stopped answering ArtPoll` }); }
      st.artnetIps = ips; log.write('minute', { tool: 'artnet', src: 'agent', nodes: nodes.length, dmx: (r.dmx || []).length, list: nodes.slice(0, 40).map((n) => ({ ip: n.ip, name: n.shortName || n.longName || '', u: (n.ports || []).map((p) => p.universe).filter((u) => u != null) })) }); count('artnet');
      let F = []; try { F = require('../public/data/artnet-faults.js').flags({ nodes, dmx: r.dmx || [], sacn: [], localCidrs: r.locals || [] }); } catch { /* no faults */ }
      for (const f of F) if (!st.artnetFaults.has(f.id) && f.level !== 'info') log.alert({ tool: 'artnet', src: 'agent', level: f.level === 'bad' ? 'bad' : 'warn', rule: f.id, text: f.text || f.title || f.id }); st.artnetFaults = new Set(F.map((f) => f.id)); }); }
  async function zigbee() { if (!log.on || !cfg.zigbee) return; await once('zigbee', async () => { const [, nr] = await actions.nodes({}); for (const n of ((nr && nr.nodes) || []).filter((x) => x.online !== false && (x.kind === 'zigbee' || caps(x, 'zb-energy')))) {
      try { const [, r] = await probeGet('zb', n.ip, { op: 'energy' }); const e = (r.energy || []).map((c) => [c.ch, c.dbm, c.median]); log.write('minute', { tool: 'zigbee', src: label(n), ip: n.ip, energy: e }); count('zigbee');
        for (const [ch, dbm] of e) if (dbm > W.ZB_ENERGY.bad) log.alert({ tool: 'zigbee', src: label(n), ch, dbm, rule: 'zbm.grade.energy', text: `${label(n)}: Zigbee channel ${ch} bursts at ${dbm} dBm (bad above ${W.ZB_ENERGY.bad})` }); } catch { /* offline: the source line says so */ } } }); }

  const save = () => { try { fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 1)); } catch { /* read-only: keep in memory */ } };
  // arm / disarm with the log session: start the capture + pcap ring we own, stop them when the session ends
  function sync() { const on = log.on; if (on === st.armed) return on; st.armed = on; const C = require('./capture');
    if (on) { if (cfg.traffic && cfg.pcapRing) { const r = C.ringStart({ dir: path.join(dataDir, 'pcap', 'ring'), files: cfg.pcapFiles }); st.started.ring = !r.error; log.write('source', { tool: 'traffic', src: 'agent', state: r.error ? 'pcap ring could not start' : 'pcap ring started', text: r.error || '', dir: 'pcap/ring' }); }
      minute().catch(() => {}); artnet().catch(() => {}); }
    else { if (st.started.ring) { C.ringStop(); st.started.ring = false; } if (st.started.cap) { C.stop(); st.started.cap = false; } st.lastTraffic = null; }
    return on; }
  const timers = [];
  const every = (ms, fn) => timers.push(setInterval(() => { if (sync()) fn().catch(() => {}); }, ms));
  every(60000, minute); every(5000, rfRead); every(120000, artnet); every(300000, zigbee);
  setTimeout(sync, 10000);   // a watch that survived a reboot picks up again

  return {
    get: () => ({ cfg, session: log.status(), counts: st.counts, lastAt: st.lastAt, ring: require('./capture').ringRunning() }),
    set: (c) => { c = c || {}; for (const k of ['wifi', 'rf', 'zigbee', 'artnet', 'traffic', 'keepCapture', 'pcapRing']) if (k in c) cfg[k] = !!c[k];
      if ('pcapFiles' in c) cfg.pcapFiles = Math.max(4, Math.min(400, Number(c.pcapFiles) || 40)); save(); log.write('source', { tool: 'log', src: 'agent', state: 'tools changed', cfg }); st.armed = !log.on; sync(); return cfg; },
    sync,
    stop: () => timers.forEach(clearInterval),
  };
}
module.exports = { start, DEFAULTS };
