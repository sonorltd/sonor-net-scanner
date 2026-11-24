# Sonor Network Scanner · v1.1.0

A commissioning scanner for AV / Control4 sites. It finds every device on the network and says what it is in AV terms (make, model, firmware, serial where the device publishes it), checks the site against the project's plan in the Network Map app, and prints an as-found IP schedule.

## Why there's an agent

A web page can't scan a network: browsers block raw sockets, ARP, multicast and port probes. So a small **agent** (Node 18+, no installs) runs on a Pi test rig or a laptop on the site network and does the scanning. The agent serves the scanner page at `http://<agent-ip>:8050`, so any phone, tablet or laptop on the site Wi-Fi can use it.

## What it does that a normal scanner doesn't

| Source | What it gives |
|---|---|
| Sweep (TCP knock + ping) then the ARP table | Every live IP, including silent devices that only answer ARP, with its MAC |
| IEEE MAC registry (54k entries, bundled) | Maker from the MAC; flags phones using a private (randomised) address |
| Bonjour / mDNS | Apple TV model + tvOS version, HomePods, AirPlay speakers, Google Cast, Lutron RA3 / HomeWorks processors (+ firmware), Hue, HomeKit, Shelly, Sky Stream / Glass, printers… |
| SSDP / UPnP descriptions | TVs (LG / Sony / Samsung / Panasonic), Sky Q, AVRs, NAS, routers: model, serial, firmware |
| **Control4 SDDP** (UDP 1902) | Controllers, touch screens, C4 lighting / audio, and SDDP-certified kit (Araknis, WattBox, Luma, Triad, Episode…) with model and driver |
| **Hikvision SADP** (UDP 37020) | Every Hikvision camera / NVR / door station with model, serial, firmware, DHCP on/off and whether it is activated, even when it sits on the wrong subnet |
| **Dahua discovery** (UDP 37810 / 5050) | Dahua and OEM cameras / recorders with model, serial, firmware and DHCP on/off |
| Ubiquiti discovery | UniFi APs / switches / gateways with model and firmware |
| ONVIF WS-Discovery | IP cameras and NVRs |
| AMX beacons | Global Caché iTach / GC-100 |
| NetBIOS, mDNS reverse, DNS | Device names |
| 55 AV-relevant TCP ports | e.g. C4 Director 5020, Sonos 1400, Global Caché 4998, Crestron 41794, Samsung MDC 1515, LG webOS 3001, RTSP, Telnet, SSH |
| Device info pages | Sonos (model, firmware, room, serial), Samsung TV, Chromecast, Roku, Yamaha MusicCast AVRs, Denon / Marantz, Global Caché version + modules, SSH / Telnet banners |

Each device shows **why** it was identified (the evidence list in the side panel), so a wrong guess is easy to spot. Devices are grouped by the Sonor service colours (01 Cinema … 10 Infrastructure), plus "Personal devices" and "Unidentified".

## Pages

Styled like Network Map (graphite, DM Mono labels, purple tabs). Tick **Service colours** to tint each identified row in its service colour.

- **Devices**: everything found, grouped by service / subnet / maker, searchable, with new / gone since the previous scan. Click a device for every detail, its web page links, and to give it a name and notes (kept on the agent).
- **Address column**: Fixed / DHCP / self-assigned / conflict for each device. It comes from the device itself (SADP, Dahua), from factory default addresses (Hik .64, Dahua .108, Global Caché .70…), 169.254 addresses, or the DHCP pool you type in.
- **Plan column** (once a project plan is loaded): ✓ as planned, ! differs, + not in plan. Hover or tap it for the recommendation (DHCP reservation to add, address to set on the device, wrong service row, missing MAC…).
- **Discovery**: one panel per protocol (SDDP, SADP, Dahua, UniFi, Bonjour, SSDP, ONVIF, AMX, Sonos, NetBIOS) with what each device said.
- **Issues**: wrong subnet, IP conflicts, Hikvision not activated, no DHCP answer, still on a factory default address, set to DHCP, differs from the plan, unidentified.
- **Tools**: live ping graph (loss, min / avg / max, jitter), port check (common AV ports or any list), traceroute, DNS lookup, Wake-on-LAN, subnet calculator. The device panel has Ping / Ports / Trace / Wake buttons.
- **Check against project**: picks the project's plan from the Network Map app (`network_configs`) and lists Found / Wrong IP / Different device at this IP / Not found / Not in plan. **Fill missing MACs and serials into Network Map** writes only empty MAC / serial fields on matched devices, and refuses if the plan changed since it was loaded.
- **IP schedule**: the as-found network on paper, grouped by service, with your names and notes. Print or save as PDF.

The project check needs your Sonor sign-in, so it works when the page is opened from `apps.sonor.co.uk/sonor-net-scanner/` and connected to the agent (a small link window opens to the agent and they talk directly; nothing goes through Supabase). On the agent's own page the other two tabs work with no internet at all.

## Run it

- **Mac:** double-click `Start Network Scanner.command`. **Windows:** double-click `start.bat`. **Anything:** `node server.js`.
- **Pi test rig (starts on boot):** copy this folder to the Pi, then `sudo bash pi/install.sh`. It can share the Pi with the Sky Remote bridge (8049 vs 8050).
- Scans the agent's own subnets by default. For other VLANs, type them in the subnet box (`192.168.20.0/24, 10.0.5.0/24` or a range `10.0.0.10-10.0.0.60`). Multicast discovery (Bonjour, SSDP, SDDP) only reaches the VLAN the agent is on; the sweep, ports and device pages work across routed VLANs.
- A /24 takes about 30 to 40 seconds. The last 40 scans are kept in `scans/`.

## Tests

- `node test/test.js`: parser + identification unit checks, then a real scan of simulated devices on loopback (Sonos, Samsung TV, Global Caché, Yamaha AVR, Control4 controller, DrayTek).
- `node test/demo-scan.js`: writes the demo house (39 devices incl. problem cases) into `scans/`; `--page` writes `public/data/demo-scan.json` for the demo page.
- Demo page: open `index.html?demo=1` (no agent needed). Uses `public/data/demo-scan.json` and the sample plan `public/data/demo-plan.json`.

## Files

`server.js` agent + API · `lib/scan.js` orchestration · `lib/discovery.js` mDNS / SSDP / SDDP / UniFi / ONVIF / beacons / NetBIOS · `lib/probes.js` ports + device pages · `lib/identify.js` rules · `lib/addressing.js` fixed / DHCP / conflicts · `lib/tools.js` ping, ports, trace, DNS, WOL · `lib/oui.js` + `data/oui.tsv` MAC registry (from the BSD-2 `oui-data` package, see `data/oui-LICENSE.txt`) · `public/index.html` the page · `pi/install.sh`.

Not done yet: hosting the page at apps.sonor.co.uk (needs the `sonorltd/sonor-net-scanner` repo + gateway registration), reading the Araknis router's client list, OvrC (no dealer API exists).
