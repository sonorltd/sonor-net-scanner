/* Sonor RF Probe v1.2.0 (2026-11-24): a battery ESP32 + CC1101 you leave at the blind / motor / receiver.
 * It listens on one sub-GHz frequency (Somfy RTS 433.42 MHz by default) and streams the signal level to the
 * Network Scanner's RF tab over Wi-Fi: live RSSI, the noise floor, and the peak of each burst (someone pressing
 * the RTS remote / Bond bridge sending). Receive only: it never transmits.
 *
 * Parts: ESP32 DevKit (or ESP32-C3/S3) · CC1101 module for the band (433 MHz version for RTS / most Bond, 868 MHz
 * version for Somfy io) · 18650 + charger board or a USB power bank. Wiring (VSPI): CC1101 SCK 18, MISO 19, MOSI 23,
 * CSN 5, GDO0 4, VCC 3V3 (NOT 5 V), GND.
 * Library: "SmartRC-CC1101-Driver-Lib" (ELECHOUSE_CC1101_SRC_DRV.h) by LSatan, Arduino Library Manager.
 *
 * Wi-Fi: joins the site Wi-Fi saved on it; if none or it fails, it makes its own hotspot "Sonor-RF-Probe" (password
 * sonorprobe) and serves a page at 192.168.4.1 to enter the site Wi-Fi. mDNS: sonor-rf-XXXX.local, service _sonor-rf._tcp.
 *
 * HTTP (CORS open, JSON):
 *   GET /rssi            → { v, mhz, rssi, floor, peak, peakAt, bursts, uptime, battery, ssid, wifiRssi }  (peak resets on read)
 *   GET /freq?mhz=433.92 → switch frequency (300–348, 387–464, 779–928 MHz depending on the module)
 *   GET /wifi?ssid=..&pass=..  → save site Wi-Fi and reboot
 */
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <ELECHOUSE_CC1101_SRC_DRV.h>
#include <algorithm>

#define VERSION "1.2.0"
#define PIN_GDO0 4
#define PIN_BATT 34          // optional: battery via 2 × 100k divider; reads 0 when not fitted

WebServer http(80);
Preferences prefs;
float mhz = 433.42;
int rssiNow = -120, peak = -120; unsigned long peakAt = 0; uint32_t bursts = 0; bool inBurst = false;
int hist[400]; int hi = 0; int floorDbm = -110;   // ~2 s of samples at 5 ms for the noise floor

void radio() {
  ELECHOUSE_cc1101.Init();
  ELECHOUSE_cc1101.setGDO0(PIN_GDO0);
  ELECHOUSE_cc1101.setMHZ(mhz);
  ELECHOUSE_cc1101.setModulation(2);     // ASK/OOK, as RTS and most blind remotes use
  ELECHOUSE_cc1101.setRxBW(325);         // wide enough for remotes that drift
  ELECHOUSE_cc1101.SetRx();
}

void cors() { http.sendHeader("Access-Control-Allow-Origin", "*"); http.sendHeader("Cache-Control", "no-store"); }
int battery() { int r = analogRead(PIN_BATT); return r < 100 ? -1 : (int)(r / 4095.0 * 3.3 * 2 * 1000); }  // mV

void onRssi() {
  cors();
  char b[320];
  snprintf(b, sizeof b, "{\"v\":\"%s\",\"mhz\":%.2f,\"rssi\":%d,\"floor\":%d,\"peak\":%d,\"peakAgoMs\":%lu,\"bursts\":%u,\"uptime\":%lu,\"battery\":%d,\"ssid\":\"%s\",\"wifiRssi\":%d}",
    VERSION, mhz, rssiNow, floorDbm, peak, peakAt ? millis() - peakAt : 0, bursts, millis() / 1000, battery(), WiFi.SSID().c_str(), WiFi.RSSI());
  http.send(200, "application/json", b);
  peak = -120; peakAt = 0;
}
void onFreq() {
  cors(); float f = http.arg("mhz").toFloat();
  if (!((f >= 300 && f <= 348) || (f >= 387 && f <= 464) || (f >= 779 && f <= 928))) { http.send(400, "application/json", "{\"error\":\"frequency out of CC1101 range\"}"); return; }
  mhz = f; prefs.putFloat("mhz", mhz); radio(); onRssi();
}
void onWifi() {
  cors(); if (!http.hasArg("ssid")) { http.send(200, "text/html", "<form action=/wifi><h3>Sonor RF Probe</h3>Site Wi-Fi <input name=ssid><br>Password <input name=pass type=password><br><button>Save</button></form>"); return; }
  prefs.putString("ssid", http.arg("ssid")); prefs.putString("pass", http.arg("pass")); http.send(200, "text/plain", "Saved, restarting"); delay(500); ESP.restart();
}


// ── Node identity (v1.2): every probe says who and where it is, so several can work on one site at once ──
// Sonor node scheme (shared with every Sonor site node, see sonor-wireless.js NODE): mDNS _sonor-node._tcp, TXT id / kind / caps / spot
// GET /info → { v, kind, board, caps[], id, name, spot, battery, ssid, wifiRssi, uptime } · GET /spot?name=Kitchen blind → saves the spot
// GET /identify → blinks the LED for 5 s so you can tell which unit is which. mDNS TXT carries id, kind and spot.
String nodeId() { uint64_t m = ESP.getEfuseMac(); char b[13]; snprintf(b, sizeof b, "%02X%02X%02X%02X%02X%02X", (uint8_t)m, (uint8_t)(m >> 8), (uint8_t)(m >> 16), (uint8_t)(m >> 24), (uint8_t)(m >> 32), (uint8_t)(m >> 40)); return String(b); }
unsigned long blinkUntil = 0;
#define PIN_LED 2   // DevKit blue LED

void onInfo() {
  cors(); char b[460];
  snprintf(b, sizeof b, "{\"v\":\"%s\",\"kind\":\"rf\",\"board\":\"esp32\",\"caps\":[\"rf433-rssi\",\"rf868-rssi\"],\"id\":\"%s\",\"name\":\"sonor-rf-%s\",\"spot\":\"%s\",\"battery\":%d,\"ssid\":\"%s\",\"wifiRssi\":%d,\"uptime\":%lu}",
    VERSION, nodeId().c_str(), nodeId().substring(8).c_str(), prefs.getString("spot", "").c_str(), battery(), WiFi.SSID().c_str(), WiFi.RSSI(), millis() / 1000);
  http.send(200, "application/json", b);
}
void onSpot() { cors(); String n = http.arg("name"); n.replace("\"", "'"); if (n.length() > 60) n = n.substring(0, 60); prefs.putString("spot", n); MDNS.addServiceTxt("sonor-rf", "tcp", "spot", n.c_str()); MDNS.addServiceTxt("sonor-node", "tcp", "spot", n.c_str()); onInfo(); }
void onIdentify() { cors(); blinkUntil = millis() + 5000; http.send(200, "application/json", "{\"ok\":true}"); }
void blinkTick() { if (!blinkUntil) return; if (millis() > blinkUntil) { blinkUntil = 0; digitalWrite(PIN_LED, LOW); return; } if ((millis() / 150) % 2) { digitalWrite(PIN_LED, HIGH); } else { digitalWrite(PIN_LED, LOW); } }

void setup() {
  Serial.begin(115200); prefs.begin("rfprobe", false); mhz = prefs.getFloat("mhz", 433.42);
  for (int i = 0; i < 400; i++) hist[i] = -110;
  pinMode(PIN_LED, OUTPUT); radio();
  String ssid = prefs.getString("ssid", ""), pass = prefs.getString("pass", "");
  WiFi.mode(WIFI_STA); if (ssid.length()) { WiFi.begin(ssid.c_str(), pass.c_str()); for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) delay(250); }
  if (WiFi.status() != WL_CONNECTED) { WiFi.mode(WIFI_AP); WiFi.softAP("Sonor-RF-Probe", "sonorprobe"); }
  String host = "sonor-rf-" + String((uint32_t)ESP.getEfuseMac() & 0xFFFF, HEX);
  if (MDNS.begin(host.c_str())) { MDNS.addService("sonor-rf", "tcp", 80); MDNS.addServiceTxt("sonor-rf", "tcp", "id", nodeId().c_str()); MDNS.addServiceTxt("sonor-rf", "tcp", "kind", "rf"); MDNS.addServiceTxt("sonor-rf", "tcp", "spot", prefs.getString("spot", "").c_str()); MDNS.addService("sonor-node", "tcp", 80); MDNS.addServiceTxt("sonor-node", "tcp", "id", nodeId().c_str()); MDNS.addServiceTxt("sonor-node", "tcp", "kind", "rf"); MDNS.addServiceTxt("sonor-node", "tcp", "caps", "rf433-rssi,rf868-rssi"); MDNS.addServiceTxt("sonor-node", "tcp", "spot", prefs.getString("spot", "").c_str()); }
  http.on("/info", onInfo); http.on("/spot", onSpot); http.on("/identify", onIdentify);
  http.on("/rssi", onRssi); http.on("/freq", onFreq); http.on("/wifi", onWifi); http.on("/", onWifi);
  http.begin();
}

unsigned long last = 0;
void loop() {
  http.handleClient(); blinkTick();
  if (millis() - last < 5) return; last = millis();
  rssiNow = ELECHOUSE_cc1101.getRssi();
  hist[hi] = rssiNow; hi = (hi + 1) % 400;
  // noise floor = 20th percentile of the last 2 s (bursts are short, so they don't lift it)
  static int tick = 0; if (++tick % 40 == 0) { int c[400]; memcpy(c, hist, sizeof c); std::sort(c, c + 400); floorDbm = c[80]; }
  if (rssiNow > peak) { peak = rssiNow; peakAt = millis(); }
  bool hot = rssiNow > floorDbm + 12; if (hot && !inBurst) bursts++; inBurst = hot;
}
