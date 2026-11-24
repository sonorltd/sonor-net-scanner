/* artnet-faults.js — Art-Net / sACN fault rules for the Network Scanner's Art-Net tab (UMD: window.ArtnetFaults or require).
 * Rule ids follow the research file net-scanner/research/artnet-dmx-rules.json (st.faults). Pure: give it what the
 * agent found ({ nodes, dmx, sacn, localCidrs }) and it returns [{ id, level: bad|warn|info, text }]. */
(function (root, f) { if (typeof module === 'object' && module.exports) module.exports = f(); else root.ArtnetFaults = f(); })(typeof self !== 'undefined' ? self : this, function () {
function flags({ nodes = [], dmx = [], sacn: sa = [], localCidrs = [] } = {}) {
  const f = []; const add = (id, level, text) => f.push({ id, level, text });
  const inLocal = (ip) => localCidrs.some((c) => { const [b, bits] = c.split('/'); const m = bits == 0 ? 0 : (~0 << (32 - bits)) >>> 0; const n = (x) => x.split('.').reduce((a, o) => (a << 8) + Number(o), 0) >>> 0; return (n(ip) & m) === (n(b) & m); });
  const two = nodes.filter((n) => /^(2|10)\./.test(n.ip) && !inLocal(n.ip));
  if (two.length) add('an.addr.2x', 'warn', `${two.length} node${two.length > 1 ? 's use' : ' uses'} classic Art-Net addressing (${two.map((n) => n.ip).join(', ')}), outside this network: the console must be on the same 2.x / 10.x range, or set the node to DHCP / a static address on the site LAN.`);
  const bc = dmx.filter((d) => d.broadcast !== false); if (bc.length) add('an.dmx.broadcast', 'warn', `Art-Net DMX is being broadcast (${[...new Set(bc.map((d) => d.src))].join(', ')} on universe ${[...new Set(bc.map((d) => d.universe))].join(', ')}): every device and Wi-Fi AP gets it. Set the console to unicast to the nodes, or put lighting on its own VLAN.`);
  // who sends each universe (Art-Net numbering, from 0; sACN = Art-Net + 1: an.universe.numbering)
  const byU = new Map(); const put = (u, who) => { const a = byU.get(u) || []; a.push(who); byU.set(u, a); };
  for (const d of dmx) put(d.universe, { what: 'Art-Net ' + d.src, hz: d.hz, seqErr: d.seqErr });
  for (const s of sa) for (const u of s.universes) { const dd = (s.data || {})[u] || {}; put(u - 1, { what: `sACN ${s.source || s.ip}`, sacn: true, priority: dd.priority ?? s.priority, hz: dd.hz, seqErr: dd.seqErr }); }
  for (const [u, who] of byU) {
    if (who.length > 2) add('an.merge', 'bad', `Universe ${u} (sACN ${u + 1}) has ${who.length} sources: ${who.map((w) => w.what).join(', ')}. A node merges two at most: expect flicker.`);
    else if (who.length === 2) { const sp = who.filter((w) => w.sacn); add(sp.length === 2 && sp[0].priority === sp[1].priority ? 'sa.priority' : 'an.merge', 'warn', `Universe ${u} (sACN ${u + 1}) has two sources: ${who.map((w) => w.what + (w.priority != null ? ' p' + w.priority : '')).join(' and ')}. ${sp.length === 2 && sp[0].priority === sp[1].priority ? 'Same sACN priority, so receivers HTP-merge them by accident: set one higher.' : 'Nodes merge them (HTP/LTP): make sure that is intended.'}`); }
    for (const w of who) { if (w.hz != null && w.hz > 0 && w.hz < 1) add('an.dmx.rate', 'info', `${w.what} sends universe ${u} at ${w.hz} Hz: idle refresh only, or a stalled console.`); if (w.seqErr > 3) add('sa.seq', 'warn', `${w.what} universe ${u}: ${w.seqErr} packets out of order while listening, so the network is dropping or reordering (Wi-Fi hop, flooded switch?).`); }
  }
  // off by one: a node outputs N, nothing sends N, but something sends N±1
  for (const n of nodes) for (const p of n.ports) if (p.output && !byU.has(p.outUniverse) && (byU.has(p.outUniverse - 1) || byU.has(p.outUniverse + 1)))
    add('an.universe.numbering', 'warn', `${n.shortName || n.ip} port ${p.n} listens on universe ${p.outUniverse} (sACN ${p.outUniverse + 1}), nobody sends that, but universe ${byU.has(p.outUniverse - 1) ? p.outUniverse - 1 : p.outUniverse + 1} is live: the classic off-by-one (Art-Net counts from 0, sACN from 1).`);
  if (sa.length && nodes.some((n) => n.ports.some((p) => p.output && p.outSacn && !p.outData))) add('sa.igmp', 'info', 'An sACN node shows no data while sACN is on the network: check IGMP snooping has exactly one querier on this VLAN (outputs that stop after a few minutes are the giveaway).');
  const dup = new Map(); for (const n of nodes) for (const p of n.ports) if (p.output) { const k = p.outUniverse; dup.set(k, [...(dup.get(k) || []), n.shortName || n.ip]); }
  const noData = nodes.flatMap((n) => n.ports.filter((p) => p.output && !p.outData).map((p) => `${n.shortName || n.ip} port ${p.n} (universe ${p.outUniverse})`));
  if (noData.length && (dmx.length || sa.length)) add('an.port.nodata', 'info', `Outputs receiving no DMX: ${noData.slice(0, 6).join('; ')}${noData.length > 6 ? '…' : ''}. Check the universe matches what the console sends.`);
  const merging = nodes.flatMap((n) => n.ports.filter((p) => p.outMerging).map((p) => `${n.shortName || n.ip} port ${p.n}`)); if (merging.length) add('an.port.merge', 'warn', `Merging two sources now: ${merging.join(', ')}.`);
  if (!nodes.length && !sa.length) add('an.none', 'info', 'No Art-Net nodes answered and no sACN source announced itself. Check the nodes are on this network (or VLAN) and powered; some sACN-only gateways stay silent until a console sends.');
  void dup; return f;
}

  return { flags };
});
