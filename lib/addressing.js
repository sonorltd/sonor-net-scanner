'use strict';
// Fixed IP or DHCP? Said by the device where it tells us (Hikvision SADP, Dahua), otherwise inferred from
// well-known factory default addresses and self-assigned 169.254 addresses. The page adds the DHCP-range rule
// (the engineer types the router's pool) because only the router knows its pool.

// Factory default static addresses (out of the box / when no DHCP answers).
const FACTORY = [
  { ip: '192.168.1.64', match: /hikvision|hikvision/i, who: 'Hikvision factory default (static 192.168.1.64)' },
  { ip: '192.168.1.108', match: /dahua|lorex|amcrest/i, who: 'Dahua factory default (static 192.168.1.108)' },
  { ip: '192.168.1.70', match: /global ?cach/i, who: 'Global Caché fallback address (no DHCP answer)' },
  { ip: '192.168.1.20', match: /ubiquiti/i, who: 'UniFi fallback address (no DHCP answer)' },
  { ip: '192.168.0.90', match: /axis/i, who: 'Axis factory default (static 192.168.0.90)' },
  { ip: '192.168.0.100', match: /dahua|hikvision|axis|hanwha/i, who: 'Camera factory default range' },
];

function addressing(d, { sadp, dahua } = {}) {
  const rep = sadp || dahua;
  if (rep && typeof rep.dhcp === 'boolean') return { mode: rep.dhcp ? 'dhcp' : 'static', source: 'device', note: `${sadp ? 'SADP' : 'Dahua discovery'} says DHCP ${rep.dhcp ? 'on' : 'off'}${rep.mask ? ` · mask ${rep.mask}` : ''}${rep.gateway ? ` · gateway ${rep.gateway}` : ''}` };
  if (/^169\.254\./.test(d.ip)) return { mode: 'selfassigned', source: 'address', note: 'Self-assigned 169.254 address: it asked for DHCP and nobody answered' };
  const f = FACTORY.find((x) => x.ip === d.ip && x.match.test(`${d.make} ${d.vendor}`));
  if (f) return { mode: 'static', source: 'factory', note: f.who };
  if (d.isGateway) return { mode: 'static', source: 'role', note: 'Router / gateway address (fixed)' };
  return { mode: 'unknown', source: '', note: '' };
}

// IP conflicts: one address claimed by two different MACs across the sources we heard.
function conflicts(d, claims) {
  const macs = [...new Set(claims.filter((c) => c.mac).map((c) => c.mac))];
  if (macs.length < 2) return null;
  return { macs, sources: claims.filter((c) => c.mac).map((c) => `${c.via}: ${c.mac}`), note: `${macs.length} different MAC addresses answered for ${d.ip}` };
}

module.exports = { addressing, conflicts, FACTORY };
