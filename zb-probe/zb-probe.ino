/* Sonor Zigbee Probe v1.0.0 (2026-11-24): an ESP32-C6 you hold at a keypad, thermostat or bulb. Receive only.
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
 * The C6 shares one radio between Wi-Fi and 802.15.4 (time-sliced coexistence), so a few frames are missed while Wi-Fi
 * talks; the probe keeps its Wi-Fi traffic to the scanner's polls. NOT YET TESTED ON HARDWARE.
 */
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
extern "C" {
#include "esp_ieee802154.h"
}

#define VERSION "1.0.0"
#define PIN_BATT 0             // optional: battery via 2 × 100k divider to GPIO0; reads 0 when not fitted
#define MAXN 64

WebServer http(80);
Preferences prefs;

struct Node { uint16_t pan; uint8_t mode; uint8_t a[8]; int8_t rssi; uint8_t lqi; uint32_t n; uint32_t at; bool permit; uint8_t ext[8]; bool hasExt; uint8_t ch; };
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

extern "C" void esp_ieee802154_receive_done(uint8_t* frame, esp_ieee802154_frame_info_t* info) {
  // frame[0] = PHY length (incl. 2-byte FCS), MAC header starts at frame[1]
  uint8_t len = frame[0]; const uint8_t* p = frame + 1; const uint8_t* end = frame + 1 + (len > 2 ? len - 2 : 0);
  frames++;
  if (len >= 5) {
    uint16_t fc = p[0] | (p[1] << 8); uint8_t type = fc & 7; bool panComp = fc & (1 << 6);
    uint8_t dm = (fc >> 10) & 3, sm = (fc >> 14) & 3; const uint8_t* q = p + 3; uint16_t dpan = 0, span = 0;
    if (dm) { dpan = q[0] | (q[1] << 8); q += 2; q += dm == 3 ? 8 : 2; }
    if (sm) {
      if (!panComp) { span = q[0] | (q[1] << 8); q += 2; } else span = dpan;
      const uint8_t* src = q; q += sm == 3 ? 8 : 2;
      if (q <= end) {
        portENTER_CRITICAL_ISR(&mux);
        Node* x = nodeFor(span, sm, src);
        if (x) { x->n++; x->at = millis(); x->ch = curCh; x->lqi = info->lqi;
          x->rssi = x->rssi == -127 ? info->rssi : (int8_t)((x->rssi * 3 + info->rssi) / 4);   // smoothed
          if (type == 0 && q + 4 <= end) {                       // beacon: superframe(2) GTS(1+) pending(1+) payload
            uint16_t sf = q[0] | (q[1] << 8); x->permit = sf & 0x8000; const uint8_t* b = q + 2;
            uint8_t gts = b[0] & 7; b += 1 + (gts ? 1 + gts * 3 : 0);
            if (b < end) { uint8_t pend = b[0]; b += 1 + (pend & 7) * 2 + ((pend >> 4) & 7) * 8; }
            if (b + 10 <= end && b[0] == 0) { memcpy(x->ext, b + 2, 8); x->hasExt = true; }   // Zigbee: protocol id 0, ext PAN at +2
          } }
        portEXIT_CRITICAL_ISR(&mux);
      }
    }
  }
  esp_ieee802154_receive_handle_done(frame);
}
extern "C" void esp_ieee802154_energy_detect_done(int8_t power) { edPower = power; edDone = true; }

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
  for (uint8_t ch = 11; ch <= 26; ch++) { listenOn(ch); beaconRequest(); delay(120); beaconRequest(); delay(130); }
  String j = "{\"v\":\"" VERSION "\",\"meshes\":[";
  bool first = true;
  for (int i = 0; i < nn; i++) { const Node& x = nodes[i]; if (!x.hasExt && !x.permit && x.n < 1) continue;
    char b[64]; snprintf(b, sizeof b, "%s{\"ch\":%u,\"pan\":\"0x%04X\",", first ? "" : ",", x.ch, x.pan); j += b; first = false;
    j += "\"ext\":\"" + (x.hasExt ? hex(x.ext, 8, true) : String("")) + "\",\"addr\":\"" + addrOf(x) + "\",";
    snprintf(b, sizeof b, "\"permitJoin\":%s,\"rssi\":%d,\"lqi\":%u,\"n\":%u}", x.permit ? "true" : "false", x.rssi, x.lqi, x.n); j += b; }
  j += "]}";
  portENTER_CRITICAL(&mux); nn = 0; portEXIT_CRITICAL(&mux);
  listenOn(prefs.getUChar("ch", 25)); scanning = false;
  http.send(200, "application/json", j);
}

void onEnergy() {
  cors(); String j = "{\"v\":\"" VERSION "\",\"energy\":[";
  for (uint8_t ch = 11; ch <= 26; ch++) {
    esp_ieee802154_set_channel(ch); int8_t worst = -127;
    for (int k = 0; k < 4; k++) { edDone = false; esp_ieee802154_energy_detect(10); unsigned long t = millis(); while (!edDone && millis() - t < 50) delay(1); if (edDone && edPower > worst) worst = edPower; }
    char b[40]; snprintf(b, sizeof b, "%s{\"ch\":%u,\"dbm\":%d}", ch == 11 ? "" : ",", ch, worst); j += b;
  }
  j += "]}"; listenOn(curCh); http.send(200, "application/json", j);
}

void onListen() {
  cors();
  if (http.hasArg("ch")) { int c = http.arg("ch").toInt(); if (c >= 11 && c <= 26 && c != curCh) { portENTER_CRITICAL(&mux); nn = 0; portEXIT_CRITICAL(&mux); prefs.putUChar("ch", c); listenOn(c); } }
  if (http.hasArg("reset")) { portENTER_CRITICAL(&mux); nn = 0; portEXIT_CRITICAL(&mux); }
  int8_t now = esp_ieee802154_get_recent_rssi();
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
  if (MDNS.begin(host.c_str())) MDNS.addService("sonor-zb", "tcp", 80);
  http.on("/scan", onScan); http.on("/energy", onEnergy); http.on("/listen", onListen); http.on("/wifi", onWifi); http.on("/", onWifi);
  http.begin();
}

void loop() { http.handleClient(); delay(2); }
