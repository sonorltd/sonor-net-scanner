'use strict';
// Turns everything learnt about one IP into: make, model, kind, firmware, serial, name and a
// Sonor service group (the same ids the Network Map uses), with the evidence for each guess.

const SERVICE_LABELS = {
  cinema: '01 Cinema', audio: '02 Audio', video: '03 Video', lighting: '04 Lighting', auto: '05 Automation', hvac: '06 HVAC',
  control: '07 Control', cctv: '08 Security', network: '09 Network', design: '10 Infrastructure', client: 'Personal devices', ungrouped: 'Unidentified',
};

const APPLE_MODELS = {
  'AppleTV5,3': 'Apple TV HD', 'AppleTV6,2': 'Apple TV 4K (1st gen)', 'AppleTV11,1': 'Apple TV 4K (2nd gen)', 'AppleTV14,1': 'Apple TV 4K (3rd gen)',
  'AudioAccessory1,1': 'HomePod', 'AudioAccessory1,2': 'HomePod', 'AudioAccessory5,1': 'HomePod mini', 'AudioAccessory6,1': 'HomePod (2nd gen)',
};

// Vendor (from the MAC) → default guess. Most specific first. [regex, make, service, kind]
const VENDOR_RULES = [
  [/control4/i, 'Control4', 'control', 'Control4 device'],
  [/snapav|snap one|araknis|pakedge|wattbox/i, 'Snap One', 'network', 'Snap One device (Araknis / WattBox / Luma)'],
  [/lutron/i, 'Lutron', 'lighting', 'Lutron device'],
  [/crestron/i, 'Crestron', 'control', 'Crestron device'],
  [/savant/i, 'Savant', 'control', 'Savant device'],
  [/universal remote|^rti\b|remote technologies/i, 'URC / RTI', 'control', 'Control processor'],
  [/global cach/i, 'Global Caché', 'control', 'IR / serial gateway'],
  [/sonos/i, 'Sonos', 'audio', 'Sonos player'],
  [/bose/i, 'Bose', 'audio', 'Bose speaker'],
  [/lenbrook|bluesound/i, 'Bluesound', 'audio', 'Bluesound player'],
  [/d&m|sound united|denon|marantz/i, 'Denon / Marantz', 'audio', 'AV receiver / HEOS'],
  [/yamaha(?! motor)/i, 'Yamaha', 'audio', 'AV receiver / MusicCast'],
  [/onkyo|pioneer/i, 'Onkyo / Pioneer', 'audio', 'AV receiver'],
  [/anthem|paradigm|arcam|harman|nad electronics|trinnov|storm audio/i, null, 'cinema', 'AV processor'],
  [/jvc ?kenwood|jvckenwood/i, 'JVC', 'cinema', 'Projector'],
  [/sony visual|sony video/i, 'Sony', 'cinema', 'Projector'],
  [/sky uk/i, 'Sky', 'video', 'Sky box'],
  [/roku/i, 'Roku', 'video', 'Roku'],
  [/lg electronics(?! \(mobile)|lg innotek/i, 'LG', 'video', 'LG TV'],
  [/samsung electronics/i, 'Samsung', 'video', 'Samsung device'],
  [/^sony(?! interactive)/i, 'Sony', 'video', 'Sony device'],
  [/sony interactive/i, 'Sony', 'client', 'PlayStation'],
  [/panasonic/i, 'Panasonic', 'video', 'Panasonic device'],
  [/nvidia/i, 'NVIDIA', 'video', 'NVIDIA Shield'],
  [/ubiquiti/i, 'Ubiquiti', 'network', 'UniFi device'],
  [/draytek/i, 'DrayTek', 'network', 'DrayTek router / switch'],
  [/luxul|ruckus|netgear|cisco|aruba|tp-link|mikrotik|zyxel|juniper|access networks|cambium|engenius|meraki/i, null, 'network', 'Network device'],
  [/synology|qnap/i, null, 'network', 'NAS'],
  [/hikvision/i, 'Hikvision', 'cctv', 'Camera / NVR'],
  [/dahua/i, 'Dahua', 'cctv', 'Camera / NVR'],
  [/axis comm/i, 'Axis', 'cctv', 'Camera'],
  [/doorbird|bird home/i, 'DoorBird', 'cctv', 'Door intercom'],
  [/^2n telekom/i, '2N', 'cctv', 'Door intercom'],
  [/^ring\b|skybell/i, null, 'cctv', 'Doorbell'],
  [/heatmiser/i, 'Heatmiser', 'hvac', 'neoHub'],
  [/eq-3/i, 'eQ-3', 'hvac', 'Heating controller (Homematic)'],
  [/daikin|mitsubishi electric|mitsubishi heavy|tado|honeywell|danfoss|wiser/i, null, 'hvac', 'Heating / cooling controller'],
  [/signify|philips lighting/i, 'Philips Hue', 'lighting', 'Hue bridge'],
  [/somfy/i, 'Somfy', 'auto', 'Blinds controller'],
  [/loxone|weinzierl|gira|jung|abb|schneider/i, null, 'auto', 'Automation / KNX device'],
  [/shelly|allterco/i, 'Shelly', 'auto', 'Shelly relay'],
  [/espressif|tuya|beken|realtek semi/i, null, 'auto', 'Smart device (Wi-Fi module)'],
  [/nest labs/i, 'Google Nest', 'hvac', 'Nest device'],
  [/raspberry pi/i, 'Raspberry Pi', 'design', 'Raspberry Pi'],
  [/apple/i, 'Apple', 'client', 'Apple device'],
  [/amazon/i, 'Amazon', 'client', 'Amazon device'],
  [/google/i, 'Google', 'client', 'Google device'],
  [/hewlett|canon|brother|epson|kyocera|xerox|ricoh|lexmark/i, null, 'client', 'Printer / PC'],
  [/intel|microsoft|dell|lenovo|asustek|giga-byte|micro-star|azurewave|liteon|hon hai|murata|chicony/i, null, 'client', 'Computer'],
];

const MAKE_FIX = [[/^lg( electronics)?.*/i, 'LG'], [/^sony.*/i, 'Sony'], [/^samsung.*/i, 'Samsung'], [/^globalcache$|^global cach.*/i, 'Global Caché'],
  [/^panasonic.*/i, 'Panasonic'], [/^d&m.*/i, 'Denon / Marantz'], [/^hikvision.*|^hangzhou hikvision.*/i, 'Hikvision'], [/^ubiquiti.*/i, 'Ubiquiti'], [/^yamaha corp.*/i, 'Yamaha'],
  [/^denon.*/i, 'Denon'], [/^marantz.*/i, 'Marantz'], [/^control4.*/i, 'Control4'], [/^lutron.*/i, 'Lutron'], [/^sonos.*/i, 'Sonos'], [/^apple.*/i, 'Apple'], [/^roku.*/i, 'Roku']];
function cleanMake(m) {
  m = String(m || '').trim(); if (!m) return '';
  for (const [re, v] of MAKE_FIX) if (re.test(m)) return v;
  return m.replace(/[,.]?\s+(Corporation|Corp\.?|Inc\.?|Ltd\.?|Limited|Co\.?|GmbH|Electronics|Technologies|International)\b.*$/i, '').trim();
}

function first(...v) { for (const x of v) if (x !== undefined && x !== null && String(x).trim()) return String(x).trim(); return ''; }

function identify(h) {
  const ev = []; // evidence lines shown in the page
  const r = { make: '', model: '', kind: '', service: 'ungrouped', firmware: '', serial: '', name: '', confidence: 'low' };
  const set = (o, why, conf = 'high') => {
    for (const k of ['make', 'model', 'kind', 'service', 'firmware', 'serial', 'name']) if (o[k] && !r[k + '_locked']) r[k] = String(o[k]);
    if (why) ev.push(why);
    if (conf === 'high' || (conf === 'medium' && r.confidence === 'low')) r.confidence = conf;
  };
  const svc = (h.mdns && h.mdns.services) || [];
  const svcOf = (t) => svc.find((s) => s.type === t);
  const desc = (h.upnp && h.upnp[0]) || {};
  const det = h.details || {};
  const ports = h.ports || [];

  // 1) vendor default
  const vend = h.vendor || '';
  for (const [re, make, service, kind] of VENDOR_RULES) {
    if (re.test(vend)) { set({ make: make || vend.split(' ')[0], service, kind }, `MAC maker: ${vend}`, 'low'); break; }
  }
  if (h.randomMac) set({ service: 'client', kind: 'Phone / tablet / laptop (private Wi-Fi address)' }, 'Randomised MAC (private Wi-Fi address)', 'medium');

  // 2) port shapes
  if (ports.includes(62078)) set({ make: 'Apple', service: 'client', kind: 'iPhone / iPad' }, 'Port 62078 (Apple device sync)', 'medium');
  if ((ports.includes(445) || ports.includes(139)) && ports.includes(3389)) set({ service: 'client', kind: 'Windows PC' }, 'SMB + Remote Desktop open', 'medium');
  if (ports.includes(9100) || svcOf('_ipp._tcp') || svcOf('_printer._tcp') || svcOf('_pdl-datastream._tcp')) set({ service: 'client', kind: 'Printer' }, 'Printer service', 'medium');
  if (ports.includes(5020) || ports.includes(5021)) set({ make: 'Control4', service: 'control', kind: 'Control4 controller' }, 'Control4 Director port 5020/5021 open', 'medium');
  if (ports.includes(41794) || ports.includes(41795)) set({ make: 'Crestron', service: 'control', kind: 'Crestron processor / panel' }, 'Crestron CIP/CTP port open', 'medium');
  if (ports.includes(37777)) set({ make: 'Dahua', service: 'cctv', kind: 'Camera / NVR' }, 'Dahua port 37777', 'medium');
  if (ports.includes(1515)) set({ make: 'Samsung', service: 'video', kind: 'Samsung display (MDC)' }, 'Samsung MDC port 1515', 'medium');
  if (ports.includes(3001) && /lg/i.test(vend)) set({ make: 'LG', service: 'video', kind: 'LG webOS TV' }, 'LG webOS port 3001', 'high');
  if (ports.includes(55000)) set({ make: 'Panasonic', service: 'video', kind: 'Panasonic TV' }, 'Panasonic TV port 55000', 'medium');
  if (ports.includes(60128)) set({ service: 'audio', kind: 'AV receiver (Onkyo / Pioneer / Integra eISCP)' }, 'eISCP port 60128', 'medium');
  if (ports.includes(32400)) set({ kind: 'Plex Media Server' }, 'Plex port 32400', 'low');
  if (h.isGateway) set({ service: 'network', kind: 'Router / gateway' }, 'Default gateway of this subnet', 'high');

  // 3) SSDP / UPnP description
  if (desc.manufacturer || desc.modelName) {
    const m = `${desc.manufacturer || ''} ${desc.modelName || ''} ${desc.modelDescription || ''} ${desc.deviceType || ''}`;
    const o = { make: desc.manufacturer, model: first(desc.modelName && desc.modelNumber && !desc.modelName.includes(desc.modelNumber) ? `${desc.modelName} ${desc.modelNumber}` : '', desc.modelName, desc.modelNumber),
      firmware: desc.firmware, serial: desc.serial, name: first(desc.roomName, desc.friendlyName) };
    if (/MediaRenderer|dial|tv|bravia|webos|tizen/i.test(m) && /samsung|lg|sony|panasonic|philips|hisense|tcl|vestel|sharp/i.test(m)) Object.assign(o, { service: 'video', kind: 'TV' });
    if (/InternetGatewayDevice|WANDevice/i.test(m)) Object.assign(o, { service: 'network', kind: 'Router / gateway' });
    if (/nds-com|sky/i.test(m + (h.ssdp && h.ssdp.server))) Object.assign(o, { make: 'Sky', service: 'video', kind: 'Sky Q box' });
    if (/denon|marantz|yamaha|onkyo|pioneer|integra|anthem|arcam|nad/i.test(m) && /receiver|AVR|AV|MediaRenderer/i.test(m)) Object.assign(o, { service: 'audio', kind: 'AV receiver' });
    if (/roku/i.test(m)) Object.assign(o, { service: 'video', kind: 'Roku' });
    if (/synology|qnap/i.test(m)) Object.assign(o, { service: 'network', kind: 'NAS' });
    set(o, `UPnP description: ${[desc.manufacturer, desc.modelName].filter(Boolean).join(' ')}`, 'high');
  }

  // 4) Bonjour services
  const air = svcOf('_airplay._tcp') || svcOf('_raop._tcp');
  const comp = svcOf('_companion-link._tcp');
  const appleModel = (air && (air.txt.model || air.txt.am)) || (comp && comp.txt.rpmd) || '';
  if (appleModel) {
    const nice = APPLE_MODELS[appleModel] || appleModel;
    let kind = 'AirPlay device'; let service = 'audio';
    if (/^AppleTV/.test(appleModel)) { kind = 'Apple TV'; service = 'video'; }
    else if (/^AudioAccessory/.test(appleModel)) { kind = 'HomePod'; service = 'audio'; }
    else if (/^(Mac|iMac|MacBook)/.test(appleModel)) { kind = 'Mac'; service = 'client'; }
    else if (/^(iPhone|iPad)/.test(appleModel)) { kind = appleModel.startsWith('iPad') ? 'iPad' : 'iPhone'; service = 'client'; }
    const isApple = /^(AppleTV|AudioAccessory|Mac|iMac|MacBook|iPhone|iPad)/.test(appleModel);
    set({ make: isApple ? 'Apple' : '', model: isApple ? nice : appleModel, kind, service, firmware: air && (air.txt.osvers ? `${kind === 'Apple TV' ? 'tvOS' : kind === 'HomePod' ? 'HomePod software' : kind === 'Mac' ? 'macOS' : 'iOS'} ${air.txt.osvers}` : air.txt.srcvers ? `AirPlay ${air.txt.srcvers}` : ''), name: (air && air.name.replace(/^[0-9A-F]{12}@/, '')) || (comp && comp.name) },
      `Bonjour AirPlay/Companion: model ${appleModel}`, 'high');
    if (!isApple && air) set({ kind: 'AirPlay speaker / receiver' }, 'AirPlay 2 receiver (third party)', 'medium');
  }
  const cast = svcOf('_googlecast._tcp');
  if (cast) {
    const md = cast.txt.md || '';
    const audio = /home|nest audio|nest mini|speaker|audio|group/i.test(md);
    set({ make: /google|chromecast|nest/i.test(md) ? 'Google' : '', model: md, kind: audio ? 'Google speaker' : 'Chromecast / Google TV', service: audio ? 'audio' : 'video', name: cast.txt.fn }, `Bonjour Google Cast: ${md}`, 'high');
  }
  if (svcOf('_sonos._tcp') || svcOf('_spotify-connect._tcp') && /sonos/i.test(vend)) set({ make: 'Sonos', service: 'audio', kind: 'Sonos player' }, 'Bonjour _sonos', 'high');
  const lut = svcOf('_lutron._tcp') || svcOf('_leap._tcp');
  if (lut) {
    const t = lut.txt;
    set({ make: 'Lutron', service: 'lighting', kind: first(t.systype, t.devclass ? `Lutron processor (class ${t.devclass})` : '', 'Lutron processor'), firmware: first(t.codever, t.fw), serial: first(t.serial, t.sn), name: lut.name },
      `Bonjour Lutron: ${Object.entries(t).map(([k, v]) => `${k}=${v}`).join(' ').slice(0, 80)}`, 'high');
  }
  if (svcOf('_hue._tcp')) set({ make: 'Philips Hue', service: 'lighting', kind: 'Hue bridge', model: svcOf('_hue._tcp').txt.modelid }, 'Bonjour Hue bridge', 'high');
  if (svcOf('_rdk-rics._tcp')) set({ make: 'Sky', service: 'video', kind: 'Sky Stream / Sky Glass' }, 'Bonjour Sky RDK', 'high');
  if (svcOf('_amzn-wplay._tcp')) set({ make: 'Amazon', service: 'video', kind: 'Fire TV' }, 'Bonjour Amazon Fire TV', 'medium');
  if (svcOf('_androidtvremote2._tcp')) set({ service: 'video', kind: 'Android / Google TV' }, 'Bonjour Android TV remote', 'medium');
  if (svcOf('_hap._tcp') && r.service === 'ungrouped') set({ service: 'auto', kind: 'HomeKit accessory', model: svcOf('_hap._tcp').txt.md }, 'Bonjour HomeKit', 'medium');
  if (svcOf('_shelly._tcp')) set({ make: 'Shelly', service: 'auto', kind: 'Shelly relay', firmware: svcOf('_shelly._tcp').txt.fw_id || svcOf('_shelly._tcp').txt.ver }, 'Bonjour Shelly', 'high');
  if (svcOf('_axis-video._tcp')) set({ make: 'Axis', service: 'cctv', kind: 'Camera' }, 'Bonjour Axis video', 'high');
  if (svcOf('_musc._tcp') || svcOf('_bluos._tcp')) set({ make: 'Bluesound', service: 'audio', kind: 'BluOS player' }, 'Bonjour BluOS', 'high');
  if (svcOf('_heos-audio._tcp')) set({ service: 'audio', kind: 'HEOS player / AVR' }, 'Bonjour HEOS', 'medium');
  if (svcOf('_device-info._tcp') && svcOf('_device-info._tcp').txt.model && !r.model) set({ model: svcOf('_device-info._tcp').txt.model }, `Bonjour device-info: ${svcOf('_device-info._tcp').txt.model}`, 'low');
  if (svcOf('_smb._tcp') && r.service === 'ungrouped') set({ service: 'client', kind: 'Computer / NAS' }, 'Bonjour SMB file sharing', 'low');

  // 5) Control4 SDDP — the most reliable source for C4 + SDDP-certified kit
  if (h.sddp) {
    const s = h.sddp;
    const mk = first(s.manufacturer, /^c4:/i.test(s.type || '') ? 'Control4' : '');
    const t = `${s.type || ''} ${s.model || ''} ${s.primaryProxy || ''}`.toLowerCase();
    let service = 'control'; let kind = 'SDDP device';
    if (/control4/i.test(mk)) {
      if (/controller|ea[135]|ca[1-9]|core|hc[2-8]00|director/.test(t)) kind = 'Control4 controller';
      else if (/t3|t4|t5|tsc|touch|screen|navigator/.test(t)) kind = 'Control4 touch screen';
      else if (/keypad|kpz|kp|dimmer|switch|light/.test(t)) { kind = 'Control4 lighting'; service = 'lighting'; }
      else if (/amp|matrix|audio|triad|episode/.test(t)) { kind = 'Control4 audio'; service = 'audio'; }
      else if (/intercom|door|ds2/.test(t)) { kind = 'Control4 intercom'; service = 'cctv'; }
      else kind = 'Control4 device';
    } else if (/araknis|wattbox|pakedge|ovrc/i.test(mk + t)) { service = 'network'; kind = /wattbox/i.test(mk + t) ? 'WattBox power' : 'Araknis network'; }
    else if (/luma/i.test(mk + t)) { service = 'cctv'; kind = 'Luma camera / NVR'; }
    else if (/triad|episode|sonance|anthem|marantz|denon|yamaha|onkyo|integra/i.test(mk + t)) { service = 'audio'; kind = 'Audio (SDDP)'; }
    else if (/binary|tv|display|lg|samsung|sony|sky/i.test(mk + t)) { service = 'video'; kind = /sky/i.test(mk + t) ? 'Sky box' : 'Video (SDDP)'; }
    if (!/control4/i.test(mk) && r.service !== 'ungrouped' && r.confidence !== 'low') { service = r.service; kind = r.kind || kind; }
    set({ make: mk || r.make, model: first(s.model, s.type), kind, service, name: s.host }, `Control4 SDDP: ${[s.type, s.model, s.primaryProxy].filter(Boolean).join(' · ')}`, 'high');
    r.c4Driver = s.driver || '';
  }

  // 6) other discovery protocols
  if (h.ubnt) set({ make: 'Ubiquiti', model: h.ubnt.model, firmware: h.ubnt.firmware, name: h.ubnt.hostname, service: 'network', kind: /^U(AP|6|7|AL)|^U[67]/i.test(h.ubnt.model || '') ? 'UniFi access point' : /^US|^USW/i.test(h.ubnt.model || '') ? 'UniFi switch' : /UDM|UXG|USG|UCG|UDR/i.test(h.ubnt.model || '') ? 'UniFi gateway' : 'UniFi device' }, `Ubiquiti discovery: ${h.ubnt.model || ''} ${h.ubnt.firmware || ''}`, 'high');
  if (h.onvif) set({ service: 'cctv', kind: 'IP camera / NVR (ONVIF)', model: h.onvif.hardware, name: h.onvif.name }, `ONVIF: ${[h.onvif.name, h.onvif.hardware].filter(Boolean).join(' ')}`, 'high');
  if (h.sadp) {
    const x = h.sadp; const t = `${x.deviceType} ${x.model}`;
    const kind = /NVR|DVR|DS-7|DS-9|iDS-7|HCVR/i.test(t) ? 'NVR / recorder' : /DS-KD|DS-KV|KD8|KV6|DS-KH|KH6|KH8|intercom|door/i.test(t) ? 'Door station / intercom' : /DS-K1|access/i.test(t) ? 'Access control' : 'IP camera';
    set({ make: 'Hikvision', model: x.model, serial: x.serial, firmware: x.firmware, service: 'cctv', kind }, `Hikvision SADP: ${x.model}${x.activated === false ? ' (NOT ACTIVATED)' : ''}`, 'high');
  }
  if (h.dahua) {
    const x = h.dahua; const t = `${x.deviceClass} ${x.model}`;
    set({ make: x.vendor && !/general|private/i.test(x.vendor) ? x.vendor : 'Dahua', model: x.model, serial: x.serial, firmware: x.firmware, service: 'cctv', kind: /NVR|DVR|XVR|HCVR/i.test(t) ? 'NVR / recorder' : /VTO|VTH|door/i.test(t) ? 'Door station / intercom' : 'IP camera' }, `Dahua discovery: ${x.model}`, 'high');
  }
  if (h.amx) set({ make: h.amx.make, model: h.amx.model, firmware: h.amx.firmware, service: /global/i.test(h.amx.make || '') ? 'control' : r.service, kind: /global/i.test(h.amx.make || '') ? 'IR / serial gateway' : r.kind || 'AMX beacon device' }, `AMX beacon: ${h.amx.make} ${h.amx.model}`, 'high');

  // 7) device info pages (most specific; win over everything)
  for (const [k, d] of Object.entries(det)) {
    if (k === 'ssh' || k === 'telnet') continue;
    const service = { sonos: 'audio', cast: 'video', roku: 'video', samsung: 'video', yamaha: 'audio', denon: 'audio', globalcache: 'control' }[k];
    const kind = d.kind || { sonos: 'Sonos player', cast: 'Cast device', roku: 'Roku', samsung: 'Samsung TV', globalcache: 'IR / serial gateway' }[k];
    set({ ...d, service, kind }, `Read from the device (${k}): ${[d.make, d.model, d.firmware].filter(Boolean).join(' ')}`, 'high');
  }
  if (det.telnet && det.telnet.make) set(det.telnet, 'Telnet banner', 'medium');

  // 8) web page hints
  for (const w of h.web || []) {
    const s = `${w.server} ${w.title} ${w.realm}`;
    if (!s.trim()) continue;
    if (/draytek|vigor/i.test(s)) set({ make: 'DrayTek', service: 'network', kind: r.kind || 'DrayTek router' }, `Web page: ${s.trim()}`, 'medium');
    else if (/araknis/i.test(s)) set({ make: 'Araknis', service: 'network', kind: /switch/i.test(s) ? 'Araknis switch' : 'Araknis network' }, `Web page: ${s.trim()}`, 'medium');
    else if (/wattbox/i.test(s)) set({ make: 'WattBox', service: 'network', kind: 'WattBox power' }, `Web page: ${s.trim()}`, 'medium');
    else if (/hikvision|webs$|DNVRS-Webs/i.test(s)) set({ make: 'Hikvision', service: 'cctv', kind: 'Camera / NVR' }, `Web page: ${s.trim()}`, 'medium');
    else if (/luma/i.test(s)) set({ make: 'Luma', service: 'cctv', kind: 'Camera / NVR' }, `Web page: ${s.trim()}`, 'medium');
    else if (/unifi/i.test(s)) set({ make: 'Ubiquiti', service: 'network' }, `Web page: ${s.trim()}`, 'medium');
    else if (/lutron/i.test(s)) set({ make: 'Lutron', service: 'lighting' }, `Web page: ${s.trim()}`, 'medium');
    else if (/control4|composer|director/i.test(s)) set({ make: 'Control4', service: 'control' }, `Web page: ${s.trim()}`, 'medium');
    else if (/heatmiser|neohub/i.test(s)) set({ make: 'Heatmiser', service: 'hvac', kind: 'neoHub' }, `Web page: ${s.trim()}`, 'medium');
    else if (/doorbird/i.test(s)) set({ make: 'DoorBird', service: 'cctv', kind: 'Door intercom' }, `Web page: ${s.trim()}`, 'medium');
    else if (/\b2N\b|helios/i.test(s)) set({ make: '2N', service: 'cctv', kind: 'Door intercom' }, `Web page: ${s.trim()}`, 'medium');
    else if (/projector|jvc|epson.*(eb|eh|ls)|vpl-/i.test(s)) set({ service: 'cinema', kind: 'Projector' }, `Web page: ${s.trim()}`, 'medium');
    else if (/synology|diskstation|qnap/i.test(s)) set({ service: 'network', kind: 'NAS' }, `Web page: ${s.trim()}`, 'medium');
    else if (/wattbox|snapav|ovrc/i.test(s)) set({ make: 'Snap One', service: 'network' }, `Web page: ${s.trim()}`, 'medium');
    else if (/printer|laserjet|officejet|epson|brother/i.test(s)) set({ service: 'client', kind: 'Printer' }, `Web page: ${s.trim()}`, 'medium');
  }

  if (!r.name) r.name = first(h.netbios && h.netbios.name, h.mdnsName, h.hostname, h.mdns && h.mdns.hostname, h.dnsName);
  if (!r.firmware && det.ssh && det.ssh.sshBanner) r.firmwareHint = det.ssh.sshBanner;
  if (!r.kind && r.service === 'ungrouped' && (h.ports || []).length === 0) r.kind = 'Silent device (answers ARP only)';
  r.make = cleanMake(r.make);
  r.serviceLabel = SERVICE_LABELS[r.service] || r.service;
  r.evidence = ev;
  return r;
}

module.exports = { identify, SERVICE_LABELS, APPLE_MODELS };
