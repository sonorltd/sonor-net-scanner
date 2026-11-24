# Sonor Zigbee Probe (ESP32-C6 or ESP32-H2), v1.1.0

A receive-only Zigbee meter you hold at a Control4 keypad, a Heatmiser neoStat or a Hue bulb. The Network Scanner's
**Zigbee tab** finds it on the network by itself and uses it three ways:

- **Find meshes**: a beacon request on every channel 11–26. Each mesh that answers (channel, PAN id, extended PAN id,
  permit-join) fills the site's mesh channels for you. The extended PAN id's first three bytes usually name the maker:
  Control4 `00:0F:FF`, Philips Hue `00:17:88`; anything else is offered as Heatmiser neo or Other to pick from a list.
- **Noise sweep**: real energy on every channel, including Bluetooth, microwaves and the meshes themselves, which the
  tablet's Wi-Fi survey cannot hear.
- **Meter**: listens on one mesh's channel and lists every node heard, strongest first, with RSSI and LQI. Stand next to
  a keypad: the strongest node is its nearest router. **Test here** saves the spot with the best signal heard.

Draft grades (to calibrate on the first unit, not yet researched): Solid ≥ -75 dBm, Marginal ≥ -85 dBm, otherwise Fail
(Zigbee radios typically receive down to about -100 dBm, so these leave a fade margin).

## Parts (about £10)
- ESP32-C6 DevKitC-1, or Seeed XIAO ESP32C6 (has an external antenna option, better for a meter)
- USB power bank, or a LiPo on the XIAO's battery pads. Optional 2 × 100 kΩ divider to GPIO0 for battery level.

## Flash
Arduino IDE, ESP32 boards package **3.1 or later**, board **ESP32C6 Dev Module**. No extra libraries. Open
`zb-probe.ino`, upload. (It uses Espressif's `esp_ieee802154` driver directly, not the Zigbee stack, so it never joins
a mesh.)

## First use
It makes a hotspot **Sonor-ZB-Probe** (password `sonorprobe`). Join it, open http://192.168.4.1, enter the site Wi-Fi.
It restarts on the site Wi-Fi and appears in the Zigbee tab's probe dropdown (`_sonor-zb._tcp`).

## Limits
- The C6 shares one radio between Wi-Fi and 802.15.4: it never scans Wi-Fi during a sweep or meter (Espressif rates that unstable). For an always-on meter an ESP32-H2 with an Ethernet or USB link is cleaner (research zbm.hw.choice).
- Meshes whose beacon has no Zigbee payload are reported as Thread (Thread 1.2.1+, Lutron Type X); the scanner names them from the Thread border router on the LAN (`_meshcop._udp`).
- Noise sweep: 8 windows of 8 ms per channel, max (bursts) and median (background). Grades: clear below -85 dBm, busy -85 to -70, bad above -70; a channel whose median is within 10 dB of the weakest node fails.
- It hears node short addresses, not names: names come from the Takeoffs wireless plan once that module exists.
- Not yet tested on hardware.

## Several probes on one site (v1.2.0)
Put as many Zigbee probes round the house as you like (battery units at the blinds or keypads, one wired near the rack).
Each says who it is (`/info`: id from its MAC, name, battery, Wi-Fi) and remembers **where it is** (`/spot?name=…`,
set from the scanner's room list, kept across restarts and published in its mDNS TXT). **Identify** (`/identify`) blinks
its LED for 5 s so you can match the unit in your hand to the one on screen. The scanner's Pi or laptop agent keeps
looking for probes every 20 s while the RF or Zigbee tab is open, so a probe switched on mid-visit just appears.
