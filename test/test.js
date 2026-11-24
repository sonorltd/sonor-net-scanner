'use strict';
// Simulated site on loopback aliases (Linux: all of 127.0.0.0/8 is local), then a real scan of 127.0.0.0/24.
//   127.0.0.10  Sonos player       (1400 device_description.xml)
//   127.0.0.11  Samsung TV         (8001 /api/v2/)
//   127.0.0.12  Global Caché iTach (4998 getversion)
//   127.0.0.13  Yamaha AVR         (80 YamahaExtendedControl)
//   127.0.0.14  Control4 controller (5020 open)
//   127.0.0.15  DrayTek router     (80 web page title)
// Plus unit checks of the mDNS parser, OUI lookup and identify() with Bonjour / SDDP / UniFi inputs.
// Run: node test/test.js
const http = require('http');
const net = require('net');
const assert = require('assert');
const { scan } = require('../lib/scan');
const { identify } = require('../lib/identify');
const { vendor, isRandom } = require('../lib/oui');
const disc = require('../lib/discovery');

function httpServer(host, port, routes) {
  return new Promise((res) => {
    const s = http.createServer((req, rsp) => {
      const r = routes[req.url.split('?')[0]];
      if (!r) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { 'Content-Type': r.type || 'text/html', ...(r.headers || {}) }); rsp.end(r.body);
    });
    s.listen(port, host, () => res(s));
  });
}
function tcpServer(host, port, onData) {
  return new Promise((res) => { const s = net.createServer((c) => { c.on('data', (d) => onData(c, d.toString())); c.on('error', () => {}); }); s.listen(port, host, () => res(s)); });
}

(async () => {
  // ── unit checks ──
  assert.strictEqual(vendor('5C:AA:FD:12:34:56'), 'Sonos');
  assert.strictEqual(vendor('00:0F:FF:00:00:01'), 'Control4');
  assert.ok(isRandom('DA:A1:19:00:00:01'));
  assert.ok(/Private/.test(vendor('DA:A1:19:00:00:01')));

  // mDNS answer: AirPlay from an Apple TV 4K
  const pkt = Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 3, 0, 0, 0, 0]),
    // PTR _airplay._tcp.local → Lounge._airplay._tcp.local
    Buffer.from('\x08_airplay\x04_tcp\x05local\x00', 'latin1'), Buffer.from([0, 12, 0, 1, 0, 0, 0, 120, 0, 9]), Buffer.from('\x06Lounge\xc0\x0c', 'latin1'),
    // TXT model=AppleTV11,1 osvers=18.1
    Buffer.from([0xc0, 0x26, 0, 16, 0x80, 1, 0, 0, 0, 120, 0, 30]), Buffer.from('\x11model=AppleTV11,1\x0bosvers=18.1', 'latin1'),
    // SRV port 7000 target Lounge.local
    Buffer.from([0xc0, 0x26, 0, 33, 0x80, 1, 0, 0, 0, 120, 0, 0x14, 0, 0, 0, 0, 0x1b, 0x58]), Buffer.from('\x06Lounge\x05local\x00', 'latin1'),
  ]);
  const recs = disc.parseDns(pkt);
  const txt = recs.find((r) => r.type === 16); const srv = recs.find((r) => r.type === 33);
  assert.strictEqual(txt.data.model, 'AppleTV11,1'); assert.strictEqual(srv.data.port, 7000); assert.strictEqual(srv.data.target, 'Lounge.local');

  const atv = identify({ ip: '1.1.1.1', vendor: 'Apple', ports: [7000], mdns: { services: [{ type: '_airplay._tcp', name: 'Lounge', port: 7000, txt: txt.data }] } });
  assert.strictEqual(atv.model, 'Apple TV 4K (2nd gen)'); assert.strictEqual(atv.service, 'video'); assert.ok(/18\.1/.test(atv.firmware));
  const c4 = identify({ ip: '1.1.1.2', vendor: 'Control4', ports: [5020, 5021], sddp: { type: 'c4:control4_ea3', manufacturer: 'Control4', model: 'EA-3', primaryProxy: 'controller', host: 'c4-ea3-000FFF' } });
  assert.strictEqual(c4.kind, 'Control4 controller'); assert.strictEqual(c4.model, 'EA-3');
  const ap = identify({ ip: '1.1.1.3', vendor: 'Ubiquiti', ubnt: { model: 'U6-Pro', firmware: 'U6-Pro.6.6.77', hostname: 'Hall-AP' } });
  assert.strictEqual(ap.kind, 'UniFi access point'); assert.strictEqual(ap.firmware, 'U6-Pro.6.6.77');
  const lut = identify({ ip: '1.1.1.4', vendor: 'Lutron Electronics', mdns: { services: [{ type: '_lutron._tcp', name: 'Lutron-0123', txt: { codever: '23.1.0.42', systype: 'RadioRA3' } }] } });
  assert.strictEqual(lut.service, 'lighting'); assert.strictEqual(lut.firmware, '23.1.0.42'); assert.strictEqual(lut.kind, 'RadioRA3');
  const phone = identify({ ip: '1.1.1.5', vendor: 'Private (randomised) address', randomMac: true, ports: [62078] });
  assert.strictEqual(phone.service, 'client');
  // Hikvision SADP + Dahua answers (sent unicast to the listening port), incl. a device on the wrong subnet
  {
    const dg = require('dgram'); const tx = dg.createSocket('udp4');
    const sp = disc.sadp(1200);
    setTimeout(() => {
      const x = '<?xml version="1.0" encoding="UTF-8"?><ProbeMatch><Uuid>1</Uuid><Types>inquiry</Types><DeviceType>139383</DeviceType><DeviceDescription>DS-2CD2387G2-LU</DeviceDescription><DeviceSN>DS-2CD2387G2-LU20230101AAWRJ12345678</DeviceSN><CommandPort>8000</CommandPort><HttpPort>80</HttpPort><MAC>bc-ba-c2-01-02-04</MAC><IPv4Address>192.168.1.64</IPv4Address><IPv4SubnetMask>255.255.255.0</IPv4SubnetMask><IPv4Gateway>192.168.1.1</IPv4Gateway><DHCP>false</DHCP><SoftwareVersion>V5.7.15build 230131</SoftwareVersion><Activated>false</Activated></ProbeMatch>';
      tx.send(Buffer.from(x), 37020, '127.0.0.1');
    }, 300);
    const hik = (await sp).get('192.168.1.64');
    assert.ok(hik, 'SADP answer parsed'); assert.strictEqual(hik.dhcp, false); assert.strictEqual(hik.activated, false); assert.strictEqual(hik.mac, 'BC:BA:C2:01:02:04');
    const id = identify({ ip: '192.168.1.64', vendor: 'Hikvision', sadp: hik });
    assert.strictEqual(id.make, 'Hikvision'); assert.strictEqual(id.kind, 'IP camera'); assert.ok(/NOT ACTIVATED/.test(id.evidence.join(' ')));
    const { addressing } = require('../lib/addressing');
    assert.strictEqual(addressing({ ip: '192.168.1.64', make: 'Hikvision' }, { sadp: hik }).mode, 'static');
    assert.strictEqual(addressing({ ip: '192.168.1.64', make: 'Hikvision' }, {}).source, 'factory');
    assert.strictEqual(addressing({ ip: '169.254.3.4', make: '' }, {}).mode, 'selfassigned');
    const dp = disc.dahua(1200);
    setTimeout(() => {
      const j = Buffer.from(JSON.stringify({ method: 'client.notifyDevInfo', params: { deviceInfo: { DeviceType: 'IPC-HDW2431T', DeviceClass: 'IPC', SerialNo: '7G0ABC', Mac: '3c:ef:8c:01:02:03', Version: '2.800', IPv4Address: { IPAddress: '192.168.1.108', SubnetMask: '255.255.255.0', DefaultGateway: '192.168.1.1', DhcpEnable: false } } } }));
      const hd = Buffer.alloc(32); hd.writeUInt32LE(0x20, 0); hd.write('DHIP', 4); tx.send(Buffer.concat([hd, j]), 37810, '127.0.0.1');
    }, 300);
    const dh = (await dp).get('192.168.1.108');
    assert.ok(dh, 'Dahua answer parsed'); assert.strictEqual(dh.model, 'IPC-HDW2431T'); assert.strictEqual(dh.dhcp, false);
    assert.strictEqual(identify({ ip: '192.168.1.108', dahua: dh }).make, 'Dahua');
    tx.close();
  }
  console.log('unit checks ok');

  // ── simulated devices ──
  const servers = [
    await httpServer('127.0.0.10', 1400, { '/xml/device_description.xml': { type: 'text/xml', body: '<root><device><roomName>Kitchen</roomName><modelName>Sonos Era 100</modelName><modelNumber>S39</modelNumber><displayVersion>16.4</displayVersion><serialNum>48-A6-B8-11-22-33:7</serialNum><MACAddress>48:A6:B8:11:22:33</MACAddress></device></root>' } }),
    await httpServer('127.0.0.11', 8001, { '/api/v2/': { type: 'application/json', body: JSON.stringify({ device: { modelName: 'QE65S95CATXXU', name: 'Samsung S95C', wifiMac: '64:1C:AE:00:11:22', firmwareVersion: 'Unknown', OS: 'Tizen' } }) } }),
    await tcpServer('127.0.0.12', 4998, (c, d) => { if (/getversion/.test(d)) c.write('710-1005-15\r'); if (/getdevices/.test(d)) c.write('device,0,0 ETHERNET\rdevice,1,3 IR\rendlistdevices\r'); }),
    await httpServer('127.0.0.13', 80, { '/YamahaExtendedControl/v1/system/getDeviceInfo': { type: 'application/json', body: JSON.stringify({ response_code: 0, model_name: 'RX-A8A', system_version: 3.71, serial_number: 'Y123456' }) }, '/YamahaExtendedControl/v1/system/getNameText': { type: 'application/json', body: JSON.stringify({ response_code: 0, zone_list: [{ id: 'main', text: 'Cinema' }] }) } }),
    await tcpServer('127.0.0.14', 5020, () => {}),
    await httpServer('127.0.0.15', 80, { '/': { body: '<html><head><title>Vigor Login Page</title></head></html>', headers: { Server: 'DrayTek/Vigor2927' } } }),
  ];
  const r = await scan({ targets: ['127.0.0.8-127.0.0.16'], ping: false });
  const by = Object.fromEntries(r.devices.map((d) => [d.ip, d]));
  const show = (ip) => { const d = by[ip]; return d ? `${d.ip} ${d.service} | ${d.make} ${d.model} | ${d.kind} | fw ${d.firmware} | ${d.ports.map((p) => p.port).join(',')}` : `${ip} MISSING`; };
  ['127.0.0.10', '127.0.0.11', '127.0.0.12', '127.0.0.13', '127.0.0.14', '127.0.0.15'].forEach((ip) => console.log(show(ip)));
  assert.strictEqual(by['127.0.0.10'].model, 'Sonos Era 100'); assert.strictEqual(by['127.0.0.10'].firmware, '16.4'); assert.strictEqual(by['127.0.0.10'].name, 'Kitchen');
  assert.strictEqual(by['127.0.0.10'].mac, '48:A6:B8:11:22:33');
  assert.strictEqual(by['127.0.0.11'].model, 'QE65S95CATXXU'); assert.strictEqual(by['127.0.0.11'].service, 'video');
  assert.strictEqual(by['127.0.0.12'].make, 'Global Caché'); assert.strictEqual(by['127.0.0.12'].firmware, '710-1005-15');
  assert.strictEqual(by['127.0.0.13'].model, 'RX-A8A'); assert.strictEqual(by['127.0.0.13'].name, 'Cinema');
  assert.strictEqual(by['127.0.0.14'].kind, 'Control4 controller');
  assert.strictEqual(by['127.0.0.15'].make, 'DrayTek');
  servers.forEach((s) => s.close());
  console.log(`scan ok: ${r.devices.length} devices in ${r.seconds}s`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
