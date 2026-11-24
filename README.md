# Sonor Network Scanner · v1.6.0

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
- **Tools**: live ping graph (loss, min / avg / max, jitter), port check (presets: common AV + network, control systems, TVs / projectors, audio, CCTV, network kit, remote-access exposure, 1 to 1024, or any list; each open port says what it usually is, with banners, page titles and a link; port reference in `public/data/portinfo.js`), traceroute, DNS lookup, Wake-on-LAN, subnet calculator. The device panel has Ping / Ports / Trace / Wake buttons.
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

## v1.3.0 (2026-11-24)
- **Network at a glance** (top of every tab, `lib/netinfo.js`, API `netinfo` / `speedtest`): this device (IP / mask / MAC / Wi-Fi name, band,
  signal), gateway (MAC maker, ping), DNS servers (each tested), DHCP (OS lease + an active DHCP DISCOVER that lists **every** server
  that answers: two = rogue DHCP), internet (Cloudflare / Google latency, DNS, captive portal, IPv6), WAN (public IP, ISP, ASN,
  town via ipinfo.io; router's own WAN IP via UPnP IGD → **double NAT / CGNAT** flag) and an on-demand Cloudflare speed test.
  Saved with each scan; network flags also appear on the Issues tab. The DHCP check needs UDP 68 (Pi service or admin).
- **Upload** (top bar) → Supabase `net_scans` (migration `supabase/migrations/20261124200000_net_scans.sql`, applied). Project
  picked automatically by matching the Wi-Fi name to Network Map's saved Wi-Fi; several matches = engineer picks; none = Unassigned.
- **Check against project** shows the project's uploaded scans (one master table, filtered per project) and the office's Unassigned
  list (attach to a project). **Review** opens an uploaded scan here; Fill MACs / Mark reviewed calls `net_scan_apply`, which writes
  the revision note into Network Map's history (`sonor_revisions`, app `network-map`: who scanned, who reviewed, what changed).

## v1.6.0 (2026-11-24): real-world performance on the Wi-Fi map
- **Speed test at every spot** ("+ speed test", on by default): each walk-test reading also stores download, upload and jitter; the room table shows the slowest speed per room and the Speed heat layer colours the plan by Mb/s.
- **Predicted vs tested** (default view): the prediction from the APs on the plan shows faintly straight away; each spot the engineer stands on and records turns solid within 3 m, live. Each reading shows how far it is from the prediction, e.g. −61 (−6), and the panel shows the % of the floor tested.
- Readings are pinned where the engineer tapped "Stand here", never at the AP. The demo starts blank (old demo readings that sat on the APs are cleared) and simulates each reading at the spot you tap.

## v1.5.0 (2026-11-24): Wi-Fi map on the Takeoffs plan, tablet sign-in

- **Wi-Fi map** (Wi-Fi tab): pick the project and Load plan. It shows the Takeoffs floor (active plan image through the shared
  `sonor-plan-image.js`, rooms from `content.areas`, building outline, and every WAP / AP symbol) at Takeoffs coordinates.
  Tap where you stand, Record: the room comes from the room polygon and the reading is pinned to the plan. Heat is
  **Measured** (between readings, clipped to the building) or **Predicted** (log-distance from the APs, about 5 dB a wall,
  calibrated from readings next to linked APs). The side panel scores every room against −67 dBm.
- **AP proposals**: Add / Move / Remove AP on the plan, or "+ AP" on a weak room. Link AP ties the radio the tablet is on to a
  plan AP (Network Map MACs are matched too). Proposals, links and readings go up with the scan (`netinfo.wifiPlan`, no schema change).
- **Office approval**: Review an uploaded scan, tick the changes, *Apply ticked changes to Takeoffs*. That floor is updated only if
  its `version` has not moved since (the compare-and-swap Takeoffs itself uses), the new APs get Takeoffs-style ids
  (`ROOM-WAP-01`), and the scan's revision note records who surveyed, who approved and what changed. Network Map picks the APs up
  on its next Takeoffs sync. Nothing is written to Takeoffs from the tablet.
- **No Takeoffs plan yet**: Own plan (photo or PDF, with Set scale) or Grid. Those proposals go to the office for drawing in Takeoffs;
  plans themselves are only ever added in Takeoffs on the Mac.
- **Tablet sign-in**: the Android app signs in as the engineer (gateway `/__sonor/app-login`, `data/sonor-app-auth.js`), so project
  plans, uploads and reviews carry the person's own session, exactly like the web.
- Fixed: opening an uploaded scan for review crashed on scans without a gateway list.
- Tests: `test/wifimap.test.js` (rooms, mask, prediction, calibration, BSSID match, Takeoffs apply).

## v1.4.0 (2026-11-24): Wi-Fi tab
- **Signal here**: live signal of this device's own Wi-Fi (dBm, quality, access point and its maker, channel, rate) with a graph, and a note when it roams to another AP.
- **Wi-Fi map / walk test**: stand in a room, name it, press Record (5 readings + a ping to the router). Optional floor plan image: tap where you stand and each reading is drawn as a coloured heat spot. CSV export. Readings stay on the device and go up with the scan upload.
- **Networks around / channel plan**: every network in the air (signal, band, channel, width, security, AP maker), 2.4 and 5 GHz channel charts with ours highlighted, the best channel for each band (2.4 GHz from 1/6/11 only; 5 GHz non-DFS first, quietest DFS shown), and flags: off-grid 2.4 GHz channels, 40 MHz on 2.4 GHz, open networks, WEP/TKIP/WPA1, mixed security on one SSID, crowded 2.4 GHz.
- Sources: Pi / Linux `nmcli`, Mac `system_profiler` (no AP MACs on macOS), Windows `netsh`, Android app `WifiManager` scan results (needs location permission; Android allows 4 fresh scans per 2 minutes). On the Site Rig the radio runs the hotspot, so the survey is best from the tablet.
- `lib/wifi.js` (survey, link, analyse), actions `wifiSurvey` and `wifiLink`. Test: `node test/wifi.test.js` (fake nmcli on PATH).
