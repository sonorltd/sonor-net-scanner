'use strict';
// Writes a realistic demo scan (a typical Sonor house on a flat 192.168.1.0/24) into scans/ so the page
// can be tried without a site network. Every device goes through the real identify() rules.
// Run: node test/demo-scan.js [scansDir]
const fs = require('fs');
const path = require('path');
const { identify } = require('../lib/identify');
const { vendor, isRandom } = require('../lib/oui');
const { PORTS } = require('../lib/probes');
const { addressing, conflicts } = require('../lib/addressing');

const D = [
  ['192.168.1.1', '00:1D:AA:10:20:30', { isGateway: true, ports: [53, 80, 443], web: [{ port: 443, server: 'DrayTek/Vigor2927', title: 'Vigor Login Page' }] }],
  ['192.168.1.2', '44:D9:E7:01:02:03', { ports: [22, 443], ubnt: { model: 'USW-Pro-24-PoE', firmware: '7.1.26', hostname: 'Rack-Switch' } }],
  ['192.168.1.3', '44:D9:E7:01:02:04', { ports: [22], ubnt: { model: 'U6-Pro', firmware: '6.6.77', hostname: 'Hall-AP' } }],
  ['192.168.1.4', '44:D9:E7:01:02:05', { ports: [22], ubnt: { model: 'U6-Pro', firmware: '6.6.77', hostname: 'Kitchen-AP' } }],
  ['192.168.1.10', '00:0F:FF:AA:00:01', { ports: [22, 80, 443, 5020, 5021, 8750], sddp: { type: 'c4:control4_ea3', manufacturer: 'Control4', model: 'EA-3', primaryProxy: 'controller', host: 'c4-ea3-000FFFAA0001', driver: 'controller.c4i' } }],
  ['192.168.1.11', '00:0F:FF:AA:00:02', { ports: [80], sddp: { type: 'c4:control4_t4_8', manufacturer: 'Control4', model: 'T4 8" Touch Screen', host: 'c4-t4-kitchen' } }],
  ['192.168.1.12', '00:0F:FF:AA:00:03', { ports: [], sddp: { type: 'c4:control4_ca1', manufacturer: 'Control4', model: 'CA-1', primaryProxy: 'controller' } }],
  ['192.168.1.15', '00:0C:1E:11:22:33', { ports: [4998, 4999, 80], amx: { make: 'GlobalCache', model: 'iTachIP2IR', firmware: '710-1005-15' } }],
  ['192.168.1.20', '00:0F:E7:44:55:66', { ports: [80, 23], mdns: { services: [{ type: '_lutron._tcp', name: 'Lutron-04a2b3c1', txt: { codever: '23.6.0.110', systype: 'RadioRA 3 processor', serial: '04A2B3C1' } }] } }],
  ['192.168.1.21', 'EC:B5:FA:01:23:45', { ports: [80, 443], mdns: { services: [{ type: '_hue._tcp', name: 'Hue Bridge - 1A2B3C', txt: { modelid: 'BSB002' } }] } }],
  ['192.168.1.30', '74:E6:B8:E4:1C:AE', { ports: [3001, 1900, 9955], upnp: [{ manufacturer: 'LG Electronics', modelName: 'OLED55A26LA', friendlyName: '[LG] webOS TV OLED55A26LA', deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1', firmware: '03.36.10' }] }],
  ['192.168.1.31', 'FC:F1:52:9A:8B:7C', { ports: [80, 443, 20060, 52323], upnp: [{ manufacturer: 'Sony Corporation', modelName: 'KD-75ZD9', friendlyName: 'BRAVIA KD-75ZD9', deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1' }] }],
  ['192.168.1.32', '64:1C:AE:00:11:22', { ports: [8001, 8002, 9197], details: { samsung: { make: 'Samsung', model: 'QE65S95CATXXU', name: 'Samsung S95C', kind: 'TV' } } }],
  ['192.168.1.33', 'F0:B3:EC:33:44:55', { ports: [7000, 49152], mdns: { services: [{ type: '_airplay._tcp', name: 'Lounge Apple TV', port: 7000, txt: { model: 'AppleTV14,1', osvers: '18.1' } }] } }],
  ['192.168.1.34', 'F0:B3:EC:33:44:56', { ports: [7000], mdns: { services: [{ type: '_airplay._tcp', name: 'Cinema Apple TV', port: 7000, txt: { model: 'AppleTV11,1', osvers: '17.6' } }] } }],
  ['192.168.1.35', '00:19:FB:12:34:56', { ports: [80, 443], sddp: { type: 'sky_q', manufacturer: 'Sky', model: 'ES240' }, upnp: [{ manufacturer: 'Sky', modelName: 'Sky Q 2TB', deviceType: 'urn:schemas-nds-com:device:SkyServe:2', serial: '0123456789' }] }],
  ['192.168.1.40', '00:05:CD:AB:CD:EF', { ports: [80, 8080, 23, 60006], details: { denon: { make: 'Denon', model: 'AVC-X6800H', firmware: '3200-6043-6150-1311', kind: 'AV receiver' } } }],
  ['192.168.1.41', 'AC:44:F2:01:02:03', { ports: [80, 50000], details: { yamaha: { make: 'Yamaha', model: 'RX-A8A', firmware: '3.71', serial: 'Y123456', name: 'Cinema', kind: 'AV receiver' } } }],
  ['192.168.1.42', 'E0:DA:DC:01:02:03', { ports: [80, 443], web: [{ port: 80, title: 'JVC Projector', server: '' }] }],
  ['192.168.1.50', '5C:AA:FD:10:20:30', { ports: [1400, 1443], details: { sonos: { make: 'Sonos', model: 'Sonos Arc', firmware: '16.4', name: 'Lounge', serial: '5C-AA-FD-10-20-30:4' } } }],
  ['192.168.1.51', 'B8:E9:37:10:20:31', { ports: [1400, 1443], details: { sonos: { make: 'Sonos', model: 'Sonos Amp', firmware: '16.4', name: 'Kitchen', serial: 'B8-E9-37-10-20-31:1' } } }],
  ['192.168.1.52', '48:A6:B8:11:22:33', { ports: [1400, 1443], details: { sonos: { make: 'Sonos', model: 'Sonos Era 100', firmware: '16.4', name: 'Master Bedroom' } } }],
  ['192.168.1.53', '54:2A:1B:11:22:34', { ports: [1400], details: { sonos: { make: 'Sonos', model: 'Sonos Port', firmware: '15.9', name: 'Garden' } } }],
  ['192.168.1.60', 'BC:BA:C2:01:02:03', { ports: [80, 443, 554, 8000], onvif: { name: 'HIKVISION DS-7608NXI', hardware: 'DS-7608NXI-K2' }, web: [{ port: 80, title: 'NVR', server: 'webs' }] }],
  ['192.168.1.61', 'BC:BA:C2:01:02:04', { ports: [80, 554, 8000], onvif: { name: 'Front Drive', hardware: 'DS-2CD2387G2-LU' } }],
  ['192.168.1.62', '1C:CA:E3:71:02:03', { ports: [80, 554], web: [{ port: 80, title: 'DoorBird', server: '' }] }],
  ['192.168.1.70', '00:1A:22:01:02:03', { ports: [4242], web: [] }],
  ['192.168.1.71', 'D8:BF:C0:AA:BB:CC', { ports: [80] }],
  ['192.168.1.100', 'DA:A1:19:12:34:56', { ports: [62078] }],
  ['192.168.1.101', '3E:22:FB:00:11:22', { ports: [] }],
  ['192.168.1.102', 'A4:83:E7:11:22:33', { ports: [7000], mdns: { services: [{ type: '_airplay._tcp', name: 'Tonys MacBook Pro', txt: { model: 'MacBookPro18,3' } }] } }],
  ['192.168.1.110', '3C:2A:F4:01:02:03', { ports: [80, 443, 631, 9100], web: [{ port: 80, title: 'Brother HL-L3270CDW' }] }],
  ['192.168.1.115', 'DC:A6:32:01:02:03', { ports: [22, 8050], self: true }],
  // Commissioning problems the scanner should call out
  ['192.168.1.64', 'BC:BA:C2:01:02:05', { ports: [80, 554, 8000], sadp: { model: 'DS-2CD2387G2-LU', serial: 'DS-2CD2387G2-LU20230101AAWRJ1', firmware: 'V5.7.15 build 230131', dhcp: false, activated: false, mask: '255.255.255.0', gateway: '192.168.1.1', mac: 'BC:BA:C2:01:02:05', httpPort: 80 } }],
  ['192.168.1.65', 'BC:BA:C2:01:02:06', { ports: [80, 554, 8000], sadp: { model: 'DS-2CD2347G2-LU', serial: 'DS-2CD2347G2-LU20240311AAWRK2', firmware: 'V5.7.18 build 240221', dhcp: true, activated: true, mask: '255.255.255.0', gateway: '192.168.1.1', mac: 'BC:BA:C2:01:02:06' } }],
  ['192.168.0.108', '3C:EF:8C:01:02:03', { ports: [], foreign: true, dahua: { model: 'IPC-HDW2431T-AS', deviceClass: 'IPC', serial: '7G0ABC123', firmware: '2.800.0000000.25.R', dhcp: false, mask: '255.255.255.0', gateway: '192.168.0.1', mac: '3C:EF:8C:01:02:03', vendor: 'Dahua' } }],
  ['10.0.0.70', '00:0C:1E:11:22:44', { ports: [], foreign: true, amx: { make: 'GlobalCache', model: 'iTachIP2SL', firmware: '710-1005-15' } }],
  ['169.254.12.7', '00:05:A6:12:34:56', { ports: [80] }],
  ['192.168.1.120', 'B0:BE:76:01:02:03', { ports: [80], conflictWith: 'D8:BF:C0:11:22:33' }],
];

const asPage = process.argv[2] === '--page';
const out = asPage ? path.join(__dirname, '..', 'public', 'data') : (process.argv[2] || path.join(__dirname, '..', 'scans'));
fs.mkdirSync(out, { recursive: true });
const t0 = Date.now() - 60000;
const devices = D.map(([ip, mac, x]) => {
  const h = { ip, mac, vendor: vendor(mac), randomMac: isRandom(mac), ...x, details: x.details || {}, web: x.web || [], upnp: x.upnp || [] };
  const id = identify(h);
  if (x.self) Object.assign(id, { name: 'sonor-rig', kind: 'This scanner', service: 'design', serviceLabel: '10 Infrastructure' });
  return {
    ip, mac, vendor: h.vendor, randomMac: h.randomMac, name: id.name, make: id.make, model: id.model, kind: id.kind, service: id.service, serviceLabel: id.serviceLabel,
    firmware: id.firmware, firmwareHint: '', serial: id.serial, confidence: id.confidence, evidence: id.evidence, c4Driver: id.c4Driver || '',
    isGateway: !!x.isGateway, isSelf: !!x.self, seenBy: ['tcp', 'arp', x.mdns && 'mdns', x.sddp && 'sddp', x.ubnt && 'ubiquiti', x.upnp && 'ssdp', x.onvif && 'onvif'].filter(Boolean),
    latency: 2 + (ip.length % 7), hostnames: x.ubnt ? [x.ubnt.hostname] : [], ports: (x.ports || []).map((p) => ({ port: p, label: PORTS[p] || '' })), web: h.web, services: (x.mdns && x.mdns.services) || [],
    upnp: h.upnp, ssdpServer: '', sddp: x.sddp || null, ubnt: x.ubnt || null, onvif: x.onvif || null, beacon: x.amx || null, netbios: null,
    sadp: x.sadp || null, dahua: x.dahua || null, foreign: !!x.foreign,
    subnetNote: x.foreign ? `Answered ${x.sadp ? 'SADP' : x.dahua ? 'Dahua discovery' : 'a discovery beacon'} from ${ip}, outside the network this scanner is on (192.168.1.0/24). It can't be reached until it is re-addressed or routed.` : '',
    addressing: addressing({ ip, make: id.make, vendor: h.vendor, isGateway: !!x.isGateway }, { sadp: x.sadp, dahua: x.dahua }),
    conflict: x.conflictWith ? conflicts({ ip }, [{ via: 'arp', mac }, { via: 'tcp reply', mac: x.conflictWith }]) : null,
  };
});
const scan = { id: new Date(t0).toISOString().replace(/[:.]/g, '-'), label: 'Demo house', startedAt: new Date(t0).toISOString(), finishedAt: new Date(t0 + 34000).toISOString(), seconds: 34,
  agent: { hostname: 'sonor-rig', platform: 'linux', interfaces: [] }, targets: ['192.168.1.0/24'], gateways: ['192.168.1.1'], devices };
fs.writeFileSync(path.join(out, asPage ? 'demo-scan.json' : `scan-${scan.id}.json`), JSON.stringify(scan));
for (const d of devices) console.log(d.ip.padEnd(14), d.service.padEnd(9), `${d.make} ${d.model}`.padEnd(34), d.kind.padEnd(28), d.firmware, d.confidence);
