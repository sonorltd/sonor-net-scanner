# Sonor Network Scanner · v1.8.1

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

## v1.8.1 (2026-11-25): the shared project selector
- The Sonor project bar (SonorProjectBar, the same one every app shows) sits under the header on every tab. Projects with a Network Map plan are marked "network plan"; picking one loads its plan for the Check tab, picking one without a plan says so. The bar follows the project picked in any other Sonor app.
- On the offline site rig (no internet), the plain plan picker on the Check tab takes over as before.

## v1.8.0 (2026-11-25): live Wi-Fi channel monitor from every node
- Wi-Fi tab ▸ Live channel monitor: this rig's (or tablet's) own radio plus every Sonor node with cap `wifi-scan` sample every 8 s, each in its own place. Grid = channel load per place (neighbours only: our SSIDs are left out), Now / Worst 10 min, 2.4 / 5 GHz, a waterfall per place, and the whole-site pick (the channel whose worst place is quietest; 2.4 from 1/6/11, 5 GHz non-DFS first). Flags: all of 1/6/11 busy in a room, strong networks on 2–5 / 7–10, crowded 5 GHz, no channel quiet everywhere. Uploads as netinfo.wifiMon.
- Agent action `wifiMon({ ips, self })` (Pi / laptop and Android). Android throttles Wi-Fi scans (4 per 2 min in the foreground), so on a tablet the nodes do most of the sampling.
- Probes 1.3.0 (rf-probe, zb-probe): GET /aps, cap `wifi-scan` (background scan, never blocks). sonor-wireless.js 1.4.0: NODE kind `multi` (Sonor site node), caps list, /aps + /spectrum contract, `wifiChannelLoad`, `sitePick`, `loadVerdict`. One shared firmware lives in APP - IR RF Capture/firmware (build flags per board).
- Grades follow the research rules (wifi.mon.*): count networks at -85 dBm or louder; 2.4 GHz allows 2, 5 GHz allows 1. Crowded = over that, or a co-channel network at -67 or louder, or an overlapping one at -62 or louder. Clear = nothing co-channel at -85 or louder and nothing overlapping at -62 or louder. Each BSSID is the median of its last 5 sightings and drops after 3 misses. The channel advice is the minimax across rooms and only changes when the new pick is a grade or 6 dB better for 10 minutes.

### Logging (Log tab, on the rig only)
- Off by default. **Site visit** logs while you are on site and stops after 12 hours. **Trouble watch** leaves the rig logging for 1, 3, 7, 14 or 30 days and carries on through reboots. While a session is on, the header shows a red "Logging" pill on every tab.
- Every tool logs into one session (tick boxes): Wi-Fi in every room (per-minute grades, BSSIDs appearing, going or changing channel, 6 dB rises), RF probes (floor, peak, bursts), Zigbee energy sweeps, Art-Net nodes coming and going, traffic (top protocols, talkers, faults), node online / offline with battery, and a rolling .pcap ring (5 min / 50 MB files) for Wireshark.
- Look back: pick a session, a window (hour to 30 days), a tool, a kind or a search; the graph shows when things happened and the table what. Each session downloads as .jsonl.gz.
- Files live on the Pi in `data/logs/` (one folder per session, one .jsonl per day), 2 GB cap, pruned 30 days after a session ends. Nothing goes to Supabase. Shared module: `lib/sitelog.js` (master `sonor-sitelog.js`, contract in CROSS-APP-CONTRACTS.md). The Android app answers "Logging runs on the Pi rig".

## v1.7.1 (2026-11-24): radio roles from the Library, Heatmiser neo is not Zigbee
- sonor-wireless.js 1.3.0: `radioOf(placement, libRow)` gives each device its radio system and role (Repeater / End device only), from the Takeoffs placement (`sonorSymbol.radio`), then the Library (`sonor_blocks.metadata.radio`, `{none:true}` = not a radio), then the same built-in table Takeoffs uses. Contract: APP - Takeoffs/docs/WIRELESS-CONTRACT.md.
- Heatmiser neo is its own 868 MHz + 2.4 GHz mesh (about 40 m open space, 32 devices per neoHub), not Zigbee: removed from the Zigbee channel plan and the neoHub channel read; hub tips rewritten (APP - Takeoffs/docs/research/heatmiser-neo-radio.md).

## v1.7.0 (2026-11-24): Traffic tab (live capture on the Pi rig or laptop)
- `lib/capture.js`: tshark (`-T fields`, snaplen 128) or tcpdump (`-e -tt`) on the agent's port, started when the tab opens and stopped when it closes; auto-stop after 30 min. A 4,000-packet ring is held in memory, nothing is uploaded, and the tablet can't capture (Android).
- AV labels: Art-Net, sACN (only when tshark says E1.31; Shure also uses 5568), Control4 SDDP and control, mDNS, SSDP, DHCP, PTP/Dante, NDI, AirPlay, Sonos, Crestron, Savant, UniFi, SNMP and more. One-tap presets set the capture filter.
- Live view: packets per second (all, broadcast, multicast), what's on the wire, top talkers named from the scan, and a packet list with a filter (tap a row or pick).
- **Record to .pcap** (dumpcap, headers only) saves to `scans/pcap/` and downloads from `/pcap/<file>` to open in Wireshark. Full payloads = Wireshark on a laptop on the same (mirror) port.
- Faults (`public/data/traffic-faults.js`, ids and thresholds from the research file `traffic-rules.json`): sustained broadcast 100/1000 pps, multicast flooding, rogue DHCP, duplicate IP (ARP), no IGMP querier after 260 s or 2+ queriers, STP topology changes, TCP retransmits 1%/5%, and normal-vs-mirror port.
- `pi/install.sh` installs tshark and tcpdump, adds the service user to the wireshark group and sets capabilities on dumpcap. On a Mac, install Wireshark (ChmodBPF). On Windows, install Wireshark with Npcap.

## v1.6.9 (2026-11-24): Art-Net tab (discovery and info)
- `lib/artnet.js`: ArtPoll to 2.255.255.255, 10.255.255.255 and each local broadcast (never 255.255.255.255), flags "reply on change", sent twice; ArtPollReply parsed by the research offsets (>= 207 bytes), grouped by MAC across BindIndex; ArtDmx heard while listening (source, universe, Hz, out-of-order count); sACN universe discovery on 239.255.250.214:5568 for 11 s, plus sniffing of the universes the nodes output (priority, Hz, per-channel priority, sequence errors); ArtAddress Locate / normal.
- Every scan now also polls Art-Net, so nodes are named in the device list ("Art-Net node", lighting) and saved in the scan (`artnet`). `_rdmnet._tcp` added to mDNS.
- Art-Net tab: auto poll on open and Live every 3 s (a node is lost after 3 missed polls), sACN listen, faults (`data/artnet-faults.js`, shared by the page and agents: 2.x/10.x addressing outside the LAN, broadcast ArtDmx, 2 or 3+ sources, equal sACN priority, off-by-one universe, outputs with no data, merging, IGMP querier hint, low rate, sequence errors), node table (status dot, names, IP + DHCP/static, MAC, maker/OEM/firmware, ports with Art-Net and sACN numbers, data/merge flags, node report, Locate, Web), and universe table (who sends, who outputs). Uploads as `netinfo.artnet`.
- Full DMX channel testing is the separate Sonor Art-Net app; its deep link goes in `ARTNET_APP` once that app is registered. The codec here becomes the shared `sonor-artnet.js` when it lands.

## v1.6.8 (2026-11-24): several probes at once, found by themselves
- Sonor node scheme (`SonorWireless.NODE`, module 1.2.0): every probe advertises `_sonor-node._tcp` (TXT id, kind, caps, spot) and answers `GET /info`, `/identify` (blinks 5 s) and `/spot?name=`. rf-probe and zb-probe firmware 1.2.0.
- Agent actions `nodes` (mDNS + the last scan + typed IPs, /info each, cached 15 s) and `node` (info / identify / spot). The Android agent lists probes from the scan and typed IPs (no mDNS browse yet).
- RF and Zigbee tabs: probe cards refresh every 20 s. Tick the ones to use, pick where each sits from the Takeoffs rooms or devices found (saved on the probe), and press Identify to blink one.
- RF: every ticked probe draws its own line, and **Test a press** logs one row per probe at its spot.
- Zigbee: Find meshes and Noise sweep merge every probe (the strongest copy of each mesh, the loudest noise per channel and where). Meter shows one tile per probe and a "Heard by" column per node, and **Test here** logs each probe at its spot.
- Typical rig: a rack Pi on wired LAN runs the agent, a USB probe sits in the rack, and battery ESP32s go out to keypads and motors.

## v1.6.7 (2026-11-24): research round 2, no-typing Zigbee
- **Channels read from the hubs**: the neoHub's Zigbee channel over its legacy API (TCP 4242, `GET_SYSTEM`), the Hue bridge's over its API (one press of the bridge button pairs it, the key is kept), Control4's from the project's last upload (Control4 has no LAN source). Then the probe's beacon scan is matched by `SonorWireless.autoMatch`: hub channel first, Thread by ext PAN, maker code as a hint, a pre-filled list last.
- **Thread** meshes (beacons with no Zigbee payload, Lutron Type X) are named from Thread border routers on the LAN (`_meshcop._udp` nn / vn / mn). **Joining open** is flagged.
- **Noise sweep** grades from research: clear below -85, busy to -70, bad above; peak and background per channel; a node less than 10 dB above the background fails.
- **Discovery**: neoHub by UDP `hubseek` (19790) even with 4242 off, and by HomeKit name; IKEA Dirigera (`_ihsp._tcp`); Thread border routers; Lutron product from DEVCLASS; SmartThings and Somfy (Overkiz) by MAC; Somfy Developer Mode noted.
- **zb-probe 1.1.0**: frames copied out of the receive ISR and the buffer handed back at once (required since IDF 5.1.3), 8 × 8 ms energy windows with max and median, ext PAN read at the right offset, Thread beacons reported as `kind: "thread"`, no Wi-Fi scanning during a sweep; ESP32-H2 noted as the cleaner always-on chip.

## v1.6.6 (2026-11-24): one shared wireless module
- The Zigbee / Wi-Fi channel maths, the mesh systems and maker codes, hub guidance, RF and Zigbee grades, RF frequencies and the probe HTTP paths now live in the workspace module **`data/sonor-wireless.js`** (`window.SonorWireless`, or `require()` in the Pi and Android agents). Master: `~/Code/Sonor/sonor-wireless.js`; `sync-everything.sh` copies it (and the research `wifi-rf-rules.json`) to every app's `data/` and to this app's `public/data/`, so Takeoffs' wireless planning, Site and Remotes use the same numbers. `test/wireless.test.js` pins them.

## v1.6.5 (2026-11-24): Zigbee probe, everything picked from lists
- **Sonor Zigbee probe** (`zb-probe/`: ESP32-C6, receive only, found by the scan through `_sonor-zb._tcp`): **Find meshes** sends a beacon request on 11–26 and fills the site's mesh channels by itself (maker from the extended PAN id: Control4 `00:0F:FF`, Hue `00:17:88`; an unknown mesh goes to Heatmiser when a neoHub is on the LAN, else Other; each found mesh has a "which system" list). **Noise sweep** measures real energy per channel (dashed line on the chart, a column in the table, flags on busy mesh channels). **Meter** lists every node heard on a mesh, strongest first, with signal, LQI and a draft grade (Solid ≥ -75, Marginal ≥ -85); **Test here** saves the spot. All of it goes up with the scan (`netinfo.zigbee.found / energy / tests`).
- Opening the Zigbee tab listens to the Wi-Fi and asks the probe for the meshes on its own.
- **Dropdowns instead of typing**: mesh channels and the meter channel are lists; RF and Zigbee spots are picked from the Takeoffs plan rooms (or walk-test rooms) and the radio devices found, with "Type a place…" last; the RF frequency follows the hubs found (Somfy 433.42, Bond 433.92) until picked by hand; Tools fields suggest the devices, gateway, hostnames and subnets found.

## v1.6.4 (2026-11-24): Zigbee tab
- **Zigbee** is its own tab, between Wi-Fi and RF. Type the channel each mesh uses (Control4, Heatmiser neo, Hue, other Thread / Lutron Type X) and press Listen (or Live): each mesh is checked against the Wi-Fi heard here and against the others (two meshes on one channel is flagged), Control4's best of 15 / 20 / 25 with reasons, the quietest free channels for another mesh, a per-channel chart and table, and the Zigbee hubs the scan found (Control4, Hue, neoHub). Channels go up with the scan (`netinfo.zigbee`).
- **RF** now covers sub-GHz only (Bond, Somfy, Lutron Clear Connect, Shelly) plus the RF probe. The Wi-Fi tab keeps the Zigbee marks under its 2.4 GHz chart.

## v1.6.3 (2026-11-24): Heatmiser neo
- **Heatmiser neoHub** found by its local API ports (4242 legacy, 4243 websocket) as well as the vendor name, and shown on the RF tab as its own Zigbee mesh: keep its channel off the Control4 and Hue channels, mains neoStats repeat and battery stats do not. Ranges are a draft until researched.
- The RF tab says plainly that Zigbee nodes (Control4 keypads and dimmers, neoStats, Hue bulbs) are not on the LAN; they will come from the Takeoffs wireless plan (handover: project files `handover/takeoffs-wireless-planning.md`).

## v1.6.0 (2026-11-24): real-world performance on the Wi-Fi map
- **Speed test at every spot** ("+ speed test", on by default): each walk-test reading also stores download, upload and jitter; the room table shows the slowest speed per room and the Speed heat layer colours the plan by Mb/s.
- **Predicted vs tested** (default view): the prediction from the APs on the plan shows faintly straight away; each spot the engineer stands on and records turns solid within 3 m, live. Each reading shows how far it is from the prediction, e.g. −61 (−6), and the panel shows the % of the floor tested.
- **Shared project**: `?pid=` and the workspace's `sonor_active_project_id` pick the project; choosing one writes it back and fires `sonor:project-changed`, and the page follows a project picked elsewhere. `?pid=<uuid>&scan=<net_scans.id>` (Network Map's Scans rows) opens that upload for review.
- **Live spectrum** (Wi-Fi tab › Live): re-surveys every 5 s (30 s on the tablet, Android's scan limit). The 2.4 GHz chart shows Zigbee / Thread channels 11–26 underneath, coloured by the Wi-Fi on top of each, with the microwave band marked; the three clearest Zigbee channels are listed and the site's Zigbee channel (typed once) is checked against the Wi-Fi here. Non-Wi-Fi noise (Bluetooth, microwaves, the mesh itself) needs an 802.15.4 radio (ESP32-C6 energy scan, Engineer Toolkit).
- **RF tab**: RF hubs the scan finds (Bond via `_bond._tcp` / Olibra MAC, Somfy TaHoma `_kizbox._tcp`, Lutron, Hue, Control4 Zigbee, Shelly) with their band and placement checks, and the **Sonor RF probe** (`rf-probe/`: ESP32 + CC1101, receive only) left at a blind or motor: live level, noise floor, and **Test a press** measures the margin above the noise at that spot (433.42 RTS, 433.92, 315, 868.3). Tests are kept and uploaded with the scan (`netinfo.rf`). Rules come from the research file `public/data/wifi-rf-rules.json` (Control4 Zigbee 15/20/25 with plain-sentence reasons, 12/13 warning, AP ≥ 5 m, -67 / -82 dBm lines on the charts, probe grades on level and margin, UK Lutron 868 MHz).
- Every IP has a ↗ link to the device's web page.
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
