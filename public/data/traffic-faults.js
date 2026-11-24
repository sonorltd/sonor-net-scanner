/* traffic-faults.js — what the Traffic tab flags from a live capture (UMD: window.TrafficFaults or require).
 * Input: the capture stats from lib/capture.js ({ pkts, secs, bcast, mcast, ucastOthers, perSec[], dhcpServers{}, arp{}, igmpQuery,
 * igmpReport, stp, retrans, tcp, byWhat{} }). Output: [{ id, level: bad|warn|info, text }].
 * Ids and thresholds follow research net-scanner/research/traffic-rules.json (flt.*, vis.*). */
(function (root, f) { if (typeof module === 'object' && module.exports) module.exports = f(); else root.TrafficFaults = f(); })(typeof self !== 'undefined' ? self : this, function () {
  // from research traffic-rules.json (flt.*): broadcast 100/1000 pps over 10 s, no IGMP querier after 260 s, retransmits 1% / 5%, STP > 1 TC per 10 min
  const LIMITS = { bcastWarn: 100, bcastBad: 1000, sustainS: 10, mcastWarn: 1500, retransWarn: 0.01, retransBad: 0.05, retransMin: 200, igmpAfterS: 260, stpPer10Min: 1 };
  function faults(s) {
    const out = []; const add = (id, level, text) => out.push({ id, level, text }); if (!s || !s.pkts) return out;
    const per = (s.perSec || []).slice(-LIMITS.sustainS); const peakB = per.length >= Math.min(LIMITS.sustainS, s.secs || 0) ? Math.min(...per.map((x) => x.bcast)) : 0; const peakM = Math.max(0, ...per.map((x) => x.mcast));   // broadcast must be sustained, not one burst
    if (peakB >= LIMITS.bcastBad) add('flt.bcast', 'bad', `Broadcast storm: over ${peakB} broadcast packets a second for ${LIMITS.sustainS} s. Look for a loop (a cable plugged in twice, a switch without STP) or a device stuck sending.`);
    else if (peakB >= LIMITS.bcastWarn) add('flt.bcast', 'warn', `High broadcast: over ${peakB} a second, sustained. Usually Art-Net broadcast, a busy discovery protocol or a loop starting.`);
    if (peakM >= LIMITS.mcastWarn) add('flt.mcast.flood', 'warn', `High multicast: ${peakM} packets a second reach this port. If it is sACN, Dante or NDI the switch is flooding it: turn on IGMP snooping with one querier.`);
    const servers = Object.keys(s.dhcpServers || {}); if (servers.length > 1) add('flt.dhcp.rogue', 'bad', `${servers.length} DHCP servers answering: ${servers.join(', ')}. Only the router (or one server) should hand out addresses; a second one is usually a misconfigured router, AP or NVR.`);
    for (const [ip, macs] of Object.entries(s.arp || {})) { const m = Object.keys(macs); if (m.length > 1 && ip !== '0.0.0.0') add('flt.arp.dup', 'bad', `IP conflict: ${ip} is claimed by ${m.length} devices (${m.join(', ')}). One of them has a static address inside the DHCP range or a duplicate.`); }
    const mc = (s.byWhat && Object.entries(s.byWhat).filter(([w]) => /sACN|Dante|PTP|NDI/.test(w)).reduce((a, [, v]) => a + v.pkts, 0)) || 0;
    if (mc > 50 && !s.igmpQuery && s.secs >= LIMITS.igmpAfterS) add('flt.igmp.querier', 'warn', `Multicast audio/lighting is on this network but no IGMP querier has been heard in ${s.secs} s. With snooping on and no querier, streams stop after a few minutes: make one switch (or the router) the querier.`);
    const qs = Object.keys(s.igmpQueriers || {}); if (qs.length > 1) add('flt.igmp.querier', 'warn', `${qs.length} IGMP queriers (${qs.join(', ')}): there should be exactly one per VLAN, or snooping tables flap.`);
    if (s.stp > Math.max(LIMITS.stpPer10Min, Math.floor((s.secs || 0) / 600) * LIMITS.stpPer10Min)) add('flt.stp.tc', 'warn', `${s.stp} spanning-tree topology change${s.stp > 1 ? 's' : ''} seen: a port is flapping or someone is plugging in a loop. Dante and video drop out while the network reconverges.`);
    if (s.tcp >= LIMITS.retransMin && s.retrans / s.tcp >= LIMITS.retransWarn) add('flt.tcp.retrans', s.retrans / s.tcp >= LIMITS.retransBad ? 'bad' : 'warn', `${Math.round((s.retrans / s.tcp) * 1000) / 10}% of TCP packets are retransmissions: a bad cable, duplex mismatch or a congested Wi-Fi link on the path.`);
    if (s.secs >= 20 && !s.ucastOthers) add('vis.normal', 'info', 'This port sees its own traffic plus broadcast and multicast only (a normal switch port). To watch traffic between two other devices, plug the agent into a mirror (SPAN) port, or run Wireshark on a laptop on that port.');
    else if (s.ucastOthers > 50) add('vis.detect_mirror', 'info', 'This port sees other devices\' unicast traffic: it is a mirror port, a hub, or an unmanaged switch flooding (which can mean its MAC table is full).');
    return out;
  }
  return { faults, LIMITS };
});
