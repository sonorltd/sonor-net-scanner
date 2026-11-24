#!/usr/bin/env bash
# Sonor Network Scanner: set up a Raspberry Pi (Pi OS Bookworm, or any Debian with systemd) as the scan agent.
# Can sit on the same Pi as the Sky Remote bridge (that uses port 8049, this uses 8050).
# Usage, from the unzipped net-scanner folder on the Pi:
#   sudo bash pi/install.sh
# Afterwards the agent starts on every boot: http://<pi-ip>:8050  or  http://<hostname>.local:8050
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DEST=/opt/sonor-net-scanner
USER_NAME=netscan

if [ "$(id -u)" -ne 0 ]; then echo "Run with sudo: sudo bash pi/install.sh"; exit 1; fi
need_node() { ! command -v node >/dev/null 2>&1 || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 18 ]; }
if need_node; then echo "Installing Node.js…"; apt-get update -qq && apt-get install -y -qq nodejs; fi
if need_node; then echo "Node.js 18 or newer is needed and could not be installed. Install it from https://nodejs.org and run this again."; exit 1; fi
command -v ping >/dev/null 2>&1 || apt-get install -y -qq iputils-ping
command -v ip >/dev/null 2>&1 || apt-get install -y -qq iproute2
# Traffic tab (1.7.0): tshark for the live capture; the service user may capture through dumpcap (wireshark group), nothing else runs as root
if ! command -v tshark >/dev/null 2>&1; then echo "wireshark-common wireshark-common/install-setuid boolean true" | debconf-set-selections; DEBIAN_FRONTEND=noninteractive apt-get install -y -qq tshark || echo "tshark could not be installed: the Traffic tab will fall back to tcpdump"; fi
command -v tcpdump >/dev/null 2>&1 || apt-get install -y -qq tcpdump || true

id -u "$USER_NAME" >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin "$USER_NAME"
getent group wireshark >/dev/null 2>&1 && usermod -aG wireshark "$USER_NAME"
DC=$(command -v dumpcap || true); [ -n "$DC" ] && setcap cap_net_raw,cap_net_admin=eip "$DC" 2>/dev/null || true
mkdir -p "$DEST/scans"
# saved scans and notes in $DEST/scans are kept on reinstall
cp -r "$SRC/lib" "$SRC/public" "$SRC/data" "$SRC/server.js" "$SRC/package.json" "$DEST/"
chown -R "$USER_NAME":"$USER_NAME" "$DEST"

cat > /etc/systemd/system/sonor-net-scanner.service <<UNIT
[Unit]
Description=Sonor Network Scanner agent
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$DEST
Environment=PORT=8050
ExecStart=$(command -v node) $DEST/server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now sonor-net-scanner.service
sleep 2
systemctl --no-pager --lines=8 status sonor-net-scanner.service || true
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "Done. The scanner agent starts on every boot."
echo "  Open:  http://${IP:-<pi-ip>}:8050   or   http://$(hostname).local:8050"
echo "  Logs:  journalctl -u sonor-net-scanner -f"
