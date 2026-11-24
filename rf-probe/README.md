# Sonor RF Probe (ESP32 + CC1101), v1.0.0

A receive-only signal meter you leave where the radio has to arrive: next to the Somfy RTS motor, the blind, or the receiver a
Bond bridge talks to. The Network Scanner's **RF tab** reads it over Wi-Fi and shows live level, noise floor and the peak of
each press, so you can tell "solid", "marginal" or "won't work" at that spot before anything is fixed.

## Parts (about £15)
- ESP32 DevKit (ESP32-WROOM, or ESP32-C3 / S3 with the pins changed)
- CC1101 module for the band: **433 MHz** version for Somfy RTS (433.42) and most Bond-controlled RF; **868 MHz** version for Somfy io
- 18650 cell + TP4056 charger, or a USB power bank. Optional 2 × 100 kΩ divider to GPIO34 for battery level.

## Wiring
| CC1101 | ESP32 |
|---|---|
| VCC | 3V3 (never 5 V) |
| GND | GND |
| SCK | 18 |
| MISO | 19 |
| MOSI | 23 |
| CSN | 5 |
| GDO0 | 4 |

## Flash
Arduino IDE with the ESP32 boards package; Library Manager: **SmartRC-CC1101-Driver-Lib**. Open `rf-probe.ino`, upload.

## First use
It makes a hotspot **Sonor-RF-Probe** (password `sonorprobe`). Join it, open http://192.168.4.1, enter the site Wi-Fi. It
restarts on the site Wi-Fi and the scanner finds it (`_sonor-rf._tcp`), or type its IP in the RF tab.

## In the RF tab
Pick the frequency (RTS 433.42, 433.92, 315, 868.3), put the probe at the motor, press **Test a press** and press the remote
(or send from the Bond / Control4) within 5 s. The result is the peak above the noise floor at that spot, saved with the
location name and uploaded with the scan.

Thresholds shown are a first guide; the researched values replace them (`rf-rules.json`).
