/* Sonor Zigbee Probe v1.2.0 (2026-11-24): an ESP32-C6 you hold at a keypad, thermostat or bulb. Receive only.
 * It listens on the 802.15.4 radio (Zigbee / Thread, channels 11–26) and serves the Network Scanner's Zigbee tab:
 *   GET /scan            → finds the meshes: a beacon request on every channel, each coordinator / router that answers
 *                          { v, meshes:[{ ch, pan, ext, addr, permitJoin, rssi, lqi, n }] }  (ext = extended PAN id, its
 *                          first 3 bytes are usually the coordinator maker's OUI: Control4 00:0F:FF, Philips Hue 00:17:88)
 *   GET /energy          → real noise per channel (energy detect, everything in the band, not only Wi-Fi)
 *                          { v, energy:[{ ch, dbm }] }
 *   GET /listen?ch=25    → meter on one channel: every node heard, strongest first
 *                          { v, ch, rssi, frames, nodes:[{ addr, pan, rssi, lqi, n, agoMs }], ssid, wifiRssi, uptime, battery }
 *                          &reset=1 clears the node list (do it when you move to the next spot)
 *   GET /wifi?ssid=..&pass=..   → save the site Wi-Fi and restart
 * Wi-Fi: joins the saved site Wi-Fi, otherwise makes a hotspot "Sonor-ZB-Probe" (password sonorprobe), page at 192.168.4.1.
 * mDNS: sonor-zb-XXXX.local, service _sonor-zb._tcp (the scanner lists it in the probe dropdown by itself).
 *
 * Board: ESP32-C6 DevKitC-1 (or Seeed XIAO ESP32C6, which has an external antenna socket). Arduino-ESP32 core 3.1 or
 * later, board "ESP32C6 Dev Module". No libraries beyond the core: it uses Espressif's esp_ieee802154 driver directly.
 * The C6 shares one radio between Wi-Fi and 802.15.4: it never scans Wi-Fi while it sweeps or listens (Espressif rates that
 * unstable, research zbm.hw.choice); an ESP32-H2 is the cleaner chip for an always-on meter. Mesh beacons with no Zigbee
 * payload are reported as kind "thread" (Thread 1.2.1+, Lutron Type X); name them from _meshcop._udp on the LAN.
 * Research: zbm.api.rx / zbm.api.ed / zbm.beacon.* in wifi-rf-rules.json. NOT YET TESTED ON HARDWARE.
 */
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <algorithm>
extern "C" {
#include "esp_ieee802154.h"
}

#define VERSION "1.3.0"
#define PIN_BATT 0             // optional: battery via 2 × 100k divider to GPIO0; reads 0 when not fitted
#define MAXN 64

WebServer http(80);
Preferences prefs;

struct Node { uint16_t pan; uint8_t mode; uint8_t a[8]; int8_t rssi; uint8_t lqi; uint32_t n; uint32_t at; bool permit; uint8_t ext[8]; bool hasExt; uint8_t ch; bool beacon; uint8_t stack; };
Node nodes[MAXN]; volatile int nn = 0; volatile uint32_t frames = 0;
volatile int8_t edPower = -127; volatile bool edDone = false;
uint8_t curCh = 25; bool scanning = false;
portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;

// ── 802.15.4 frame parsing (IEEE 802.15.4-2006 MAC header + Zigbee beacon payload) ──
static Node* nodeFor(uint16_t pan, uint8_t mode, const uint8_t* a) {
  int len = mode == 3 ? 8 : 2;
  for (int i = 0; i < nn; i++) if (nodes[i].pan == pan && nodes[i].mode == mode && !memcmp(nodes[i].a, a, len)) return &nodes[i];
  if (nn >= MAXN) return nullptr;
  Node* x = &nodes[nn++]; memset(x, 0, sizeof *x); x->pan = pan; x->mode = mode; memcpy(x->a, a, len); x->rssi = -127; return x;
}

// The receive callback runs in the ISR: copy the frame into a ring and hand the buffer back at once
// (esp_ieee802154_receive_handle_done is required since IDF 5.1.3 or receiving stops). loop() parses the ring.
struct Rx { uint8_t f[128]; int8_t rssi; uint8_t lqi; uint8_t ch; };
#define RXQ 32
Rx rxq[RXQ]; volatile uint8_t rxHead = 0, rxTail = 0;
extern "C" void esp_ieee802154_receive_done(uint8_t* frame, esp_ieee802154_frame_info_t* info) {
  uint8_t next = (rxHead + 1) % RXQ;
  if (next != rxTail) { Rx& r = rxq[rxHead]; uint8_t len = frame[0] < 127 ? frame[0] : 127; memcpy(r.f, frame, len + 1); r.rssi = info->rssi; r.lqi = info->lqi; r.ch = curCh; rxHead = next; }
  frames++;
  esp_ieee802154_receive_handle_done(frame);
}
void parse(const Rx& r) {
  // f[0] = PSDU length (the last 2 bytes are FCS / RSSI+LQI), MAC header starts at f[1]
  uint8_t len = r.f[0]; const uint8_t* p = r.f + 1; const uint8_t* end = r.f + 1 + (len > 2 ? len - 2 : 0);
  if (len < 5) return;
  uint16_t fc = p[0] | (p[1] << 8); uint8_t type = fc & 7; bool panComp = fc & (1 << 6);
  uint8_t dm = (fc >> 10) & 3, sm = (fc >> 14) & 3; const uint8_t* q = p + 3; uint16_t dpan = 0, span = 0;
  if (dm) { dpan = q[0] | (q[1] << 8); q += 2; q += dm == 3 ? 8 : 2; }
  if (!sm) return;
  if (!panComp) { span = q[0] | (q[1] << 8); q += 2; } else span = dpan;
  const uint8_t* src = q; q += sm == 3 ? 8 : 2; if (q > end) return;
  portENTER_CRITICAL(&mux);
  Node* x = nodeFor(span, sm, src);
  if (x) { x->n++; x->at = millis(); x->ch = r.ch; x->lqi = r.lqi;
    x->rssi = x->rssi == -127 ? r.rssi : (int8_t)((x->rssi * 3 + r.rssi) / 4);   // smoothed
    if (type == 0 && q + 2 <= end) {                       // beacon: superframe(2) GTS(1+) pending(1+) payload
      x->beacon = true; uint16_t sf = q[0] | (q[1] << 8); x->permit = sf & 0x8000; const uint8_t* b = q + 2;
      if (b < end) { uint8_t gts = b[0] & 7; b += 1 + (gts ? 1 + gts * 3 : 0); }
      if (b < end) { uint8_t pend = b[0]; b += 1 + (pend & 7) * 2 + ((pend >> 4) & 7) * 8; }
      // Zigbee beacon payload: protocol id 0, stack profile, …, ext PAN at +3 (Thread 1.2.1+ beacons carry no payload)
      if (b + 11 <= end && b[0] == 0) { x->stack = b[1] & 0x0F; memcpy(x->ext, b + 3, 8); x->hasExt = true; }
    } }
  portEXIT_CRITICAL(&mux);
}
extern "C" void esp_ieee802154_energy_detect_done(int8_t power) { edPower = power; edDone = true; }

void drainRx() { while (rxTail != rxHead) { parse(rxq[rxTail]); rxTail = (rxTail + 1) % RXQ; } }
void drainFor(unsigned long ms) { unsigned long t = millis(); while (millis() - t < ms) { drainRx(); delay(1); } }
void listenOn(uint8_t ch) { curCh = ch; esp_ieee802154_set_channel(ch); esp_ieee802154_receive(); }

void beaconRequest() {   // MAC command frame, dst broadcast PAN/addr, no src: FC 0x0803, seq, 0xFFFF, 0xFFFF, cmd 0x07
  static uint8_t seq = 0; uint8_t f[] = { 10, 0x03, 0x08, seq++, 0xFF, 0xFF, 0xFF, 0xFF, 0x07, 0, 0 };
  esp_ieee802154_transmit(f, false); delay(5); esp_ieee802154_receive();
}

// ── HTTP ──
void cors() { http.sendHeader("Access-Control-Allow-Origin", "*"); http.sendHeader("Cache-Control", "no-store"); }
int battery() { int r = analogRead(PIN_BATT); return r < 100 ? -1 : (int)(r / 4095.0 * 3.3 * 2 * 1000); }
String hex(const uint8_t* a, int len, bool rev) { String s; char b[4]; for (int i = 0; i < len; i++) { snprintf(b, sizeof b, i ? ":%02X" : "%02X", a[rev ? len - 1 - i : i]); s += b; } return s; }
String addrOf(const Node& x) { if (x.mode == 3) return hex(x.a, 8, true); char b[8]; snprintf(b, sizeof b, "0x%04X", x.a[0] | (x.a[1] << 8)); return b; }

void onScan() {
  cors(); scanning = true;
  portENTER_CRITICAL(&mux); nn = 0; portEXIT_CRITICAL(&mux);
  for (uint8_t ch = 11; ch <= 26; ch++) { listenOn(ch); beaconRequest(); drainFor(120); beaconRequest(); drainFor(160); }   // ~280 ms per channel
  String j = "{\"v\":\"" VERSION "\",\"meshes\":[";
  bool first = true;
  for (int i = 0; i < nn; i++) { const Node& x = nodes[i]; if (!x.beacon) continue;   // only coordinators / routers that answered
    char b[64]; snprintf(b, sizeof b, "%s{\"ch\":%u,\"pan\":\"0x%04X\",", first ? "" : ",", x.ch, x.pan); j += b; first = false;
    j += "\"ext\":\"" + (x.hasExt ? hex(x.ext, 8, true) : String("")) + "\",\"addr\":\"" + addrOf(x) + "\",\"kind\":\"" + (x.hasExt ? "zigbee" : "thread") + "\",";
    snprintf(b, sizeof b, "\"permitJoin\":%s,\"rssi\":%d,\"lqi\":%u,\"n\":%u}", x.permit ? "true" : "false", x.rssi, x.lqi, x.n); j += b; }
  j += "]}";
  portENTER_CRITICAL(&mux); nn = 0; portEXIT_CRITICAL(&mux);
  listenOn(prefs.getUChar("ch", 25)); scanning = false;
  http.send(200, "application/json", j);
}

void onEnergy() {   // 8 × 8 ms energy-detect windows per channel (500 symbols of 16 µs); report max (bursts) and median (background)
  cors(); String j = "{\"v\":\"" VERSION "\",\"energy\":[";
  for (uint8_t ch = 11; ch <= 26; ch++) {
    esp_ieee802154_set_channel(ch); int8_t s8[8]; int n = 0;
    for (int k = 0; k < 8; k++) { edDone = false; esp_ieee802154_energy_detect(500); unsigned long t = millis(); while (!edDone && millis() - t < 30) delay(1); if (edDone) s8[n++] = edPower; }
    std::sort(s8, s8 + n); int mx = n ? s8[n - 1] : -127, md = n ? s8[n / 2] : -127;
    char b[60]; snprintf(b, sizeof b, "%s{\"ch\":%u,\"dbm\":%d,\"median\":%d}", ch == 11 ? "" : ",", ch, mx, md); j += b;
  }
  j += "]}"; listenOn(curCh); http.send(200, "application/json", j);
}

void onListen() {
  cors();
  if (http.hasArg("ch")) { int c = http.arg("ch").toInt(); if (c >= 11 && c <= 26 && c != curCh) { portENTER_CRITICAL(&mux); nn = 0; portEXIT_CRITICAL(&mux); prefs.putUChar("ch", c); listenOn(c); } }
  if (http.hasArg("reset")) { portENTER_CRITICAL(&mux); nn = 0; portEXIT_CRITICAL(&mux); }
  drainRx(); int8_t now = esp_ieee802154_get_recent_rssi();
  String j; char b[220];
  snprintf(b, sizeof b, "{\"v\":\"%s\",\"ch\":%u,\"rssi\":%d,\"frames\":%u,\"uptime\":%lu,\"battery\":%d,\"ssid\":\"%s\",\"wifiRssi\":%d,\"nodes\":[",
    VERSION, curCh, now, frames, millis() / 1000, battery(), WiFi.SSID().c_str(), WiFi.RSSI());
  j = b; uint32_t t = millis();
  Node copy[MAXN]; int n; portENTER_CRITICAL(&mux); n = nn; memcpy(copy, nodes, sizeof(Node) * n); portEXIT_CRITICAL(&mux);
  for (int i = 0; i < n; i++) { const Node& x = copy[i];
    snprintf(b, sizeof b, "%s{\"addr\":\"%s\",\"pan\":\"0x%04X\",\"rssi\":%d,\"lqi\":%u,\"n\":%u,\"agoMs\":%lu}", i ? "," : "", addrOf(x).c_str(), x.pan, x.rssi, x.lqi, x.n, (unsigned long)(t - x.at)); j += b; }
  j += "]}"; http.send(200, "application/json", j);
}

void onWifi() {
  cors(); if (!http.hasArg("ssid")) { http.send(200, "text/html", "<form action=/wifi><h3>Sonor Zigbee Probe</h3>Site Wi-Fi <input name=ssid><br>Password <input name=pass type=password><br><button>Save</button></form>"); return; }
  prefs.putString("ssid", http.arg("ssid")); prefs.putString("pass", http.arg("pass")); http.send(200, "text/plain", "Saved, restarting"); delay(500); ESP.restart();
}


// ── Node identity (v1.2): every probe says who and where it is, so several can work on one site at once ──
// Sonor node scheme (shared with every Sonor site node, see sonor-wireless.js NODE): mDNS _sonor-node._tcp, TXT id / kind / caps / spot
// GET /info → { v, kind, board, caps[], id, name, spot, battery, ssid, wifiRssi, uptime } · GET /spot?name=Kitchen blind → saves the spot
// GET /identify → blinks the LED for 5 s so you can tell which unit is which. mDNS TXT carries id, kind and spot.
String nodeId() { uint64_t m = ESP.getEfuseMac(); char b[13]; snprintf(b, sizeof b, "%02X%02X%02X%02X%02X%02X", (uint8_t)m, (uint8_t)(m >> 8), (uint8_t)(m >> 16), (uint8_t)(m >> 24), (uint8_t)(m >> 32), (uint8_t)(m >> 40)); return String(b); }
unsigned long blinkUntil = 0;
#ifndef RGB_BUILTIN
#define RGB_BUILTIN 8
#endif


// ── Wi-Fi scan (v1.3, sonor-wireless.js NODE cap wifi-scan): GET /aps answers from the last background scan and starts the next,
// so a request never waits for the ~2 s channel sweep. The site Wi-Fi link pauses for a moment during each sweep.
String apsJson = "{\"aps\":[]}"; unsigned long apsAt = 0; bool apsBusy = false;
const char* apsSec(wifi_auth_mode_t m) { switch (m) { case WIFI_AUTH_OPEN: return "Open"; case WIFI_AUTH_WEP: return "WEP"; case WIFI_AUTH_WPA_PSK: return "WPA"; case WIFI_AUTH_WPA2_PSK: case WIFI_AUTH_WPA_WPA2_PSK: return "WPA2"; case WIFI_AUTH_WPA2_ENTERPRISE: return "WPA2-Enterprise"; case WIFI_AUTH_WPA3_PSK: return "WPA3"; case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3"; default: return "?"; } }
void apsTick() {
  if (!apsBusy) return; int n = WiFi.scanComplete(); if (n == WIFI_SCAN_RUNNING) return; apsBusy = false; if (n < 0) return;
  String j = "{\"aps\":["; for (int i = 0; i < n && i < 60; i++) { String s = WiFi.SSID(i); s.replace("\"", "'"); s.replace("\\", "/");
    j += String(i ? "," : "") + "{\"ssid\":\"" + s + "\",\"bssid\":\"" + WiFi.BSSIDstr(i) + "\",\"ch\":" + WiFi.channel(i) + ",\"rssi\":" + WiFi.RSSI(i) + ",\"sec\":\"" + apsSec(WiFi.encryptionType(i)) + "\"}"; }
  j += "]}"; apsJson = j; apsAt = millis(); WiFi.scanDelete();
}
void onAps() {
  cors(); if (WiFi.getMode() == WIFI_AP) { http.send(503, "application/json", "{\"error\":\"not on the site Wi-Fi yet (hotspot mode)\"}"); return; }
  apsTick(); if (!apsBusy && millis() - apsAt > 3000) { WiFi.scanNetworks(true, true, false, 110); apsBusy = true; }
  String r = "{\"v\":\"" VERSION "\",\"band\":\"2.4 GHz\",\"at\":" + String(apsAt) + ",\"age_ms\":" + String(apsAt ? millis() - apsAt : -1) + "," + apsJson.substring(1);
  http.send(200, "application/json", r);
}

void onInfo() {
  cors(); char b[460];
  snprintf(b, sizeof b, "{\"v\":\"%s\",\"kind\":\"zigbee\",\"board\":\"esp32c6\",\"caps\":[\"zb-scan\",\"zb-energy\",\"zb-meter\",\"wifi-scan\"],\"id\":\"%s\",\"name\":\"sonor-zb-%s\",\"spot\":\"%s\",\"battery\":%d,\"ssid\":\"%s\",\"wifiRssi\":%d,\"uptime\":%lu}",
    VERSION, nodeId().c_str(), nodeId().substring(8).c_str(), prefs.getString("spot", "").c_str(), battery(), WiFi.SSID().c_str(), WiFi.RSSI(), millis() / 1000);
  http.send(200, "application/json", b);
}
void onSpot() { cors(); String n = http.arg("name"); n.replace("\"", "'"); if (n.length() > 60) n = n.substring(0, 60); prefs.putString("spot", n); MDNS.addServiceTxt("sonor-zb", "tcp", "spot", n.c_str()); MDNS.addServiceTxt("sonor-node", "tcp", "spot", n.c_str()); onInfo(); }
void onIdentify() { cors(); blinkUntil = millis() + 5000; http.send(200, "application/json", "{\"ok\":true}"); }
void blinkTick() { if (!blinkUntil) return; if (millis() > blinkUntil) { blinkUntil = 0; rgbLedWrite(RGB_BUILTIN, 0, 0, 0); return; } if ((millis() / 150) % 2) { rgbLedWrite(RGB_BUILTIN, 0, 0, 64); } else { rgbLedWrite(RGB_BUILTIN, 0, 0, 0); } }

void setup() {
  Serial.begin(115200); prefs.begin("zbprobe", false);
  String ssid = prefs.getString("ssid", ""), pass = prefs.getString("pass", "");
  WiFi.mode(WIFI_STA); if (ssid.length()) { WiFi.begin(ssid.c_str(), pass.c_str()); for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250); }
  if (WiFi.status() != WL_CONNECTED) { WiFi.mode(WIFI_AP); WiFi.softAP("Sonor-ZB-Probe", "sonorprobe"); }
  esp_ieee802154_enable();
  esp_ieee802154_set_promiscuous(true);      // hear every frame, not only ones addressed to us
  esp_ieee802154_set_rx_when_idle(true);
  esp_ieee802154_set_coordinator(false);
  listenOn(prefs.getUChar("ch", 25));
  String host = "sonor-zb-" + String((uint32_t)ESP.getEfuseMac() & 0xFFFF, HEX);
  if (MDNS.begin(host.c_str())) { MDNS.addService("sonor-zb", "tcp", 80); MDNS.addServiceTxt("sonor-zb", "tcp", "id", nodeId().c_str()); MDNS.addServiceTxt("sonor-zb", "tcp", "kind", "zigbee"); MDNS.addServiceTxt("sonor-zb", "tcp", "spot", prefs.getString("spot", "").c_str()); MDNS.addService("sonor-node", "tcp", 80); MDNS.addServiceTxt("sonor-node", "tcp", "id", nodeId().c_str()); MDNS.addServiceTxt("sonor-node", "tcp", "kind", "zigbee"); MDNS.addServiceTxt("sonor-node", "tcp", "caps", "zb-scan,zb-energy,zb-meter,wifi-scan"); MDNS.addServiceTxt("sonor-node", "tcp", "spot", prefs.getString("spot", "").c_str()); }
  http.on("/info", onInfo); http.on("/spot", onSpot); http.on("/identify", onIdentify);
  http.on("/scan", onScan); http.on("/energy", onEnergy); http.on("/listen", onListen); http.on("/aps", onAps); http.on("/wifi", onWifi); http.on("/", onWifi);
  http.begin();
}

void loop() { drainRx(); http.handleClient(); blinkTick(); apsTick(); delay(1); }
