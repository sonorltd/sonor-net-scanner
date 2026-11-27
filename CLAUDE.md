# APP - Network Scanner (sonor-net-scanner) · v1.9.0

> Current version: 1.9.0 (2026-11-27). One constant per surface: `APP_VERSION` in public/index.html, `VERSION` in server.js. The Android app (`APP - Android Apps/netscanner`) carries the same number in `versionName`.

Commissioning scanner for AV / Control4 sites: finds every device, names it in AV terms, checks the site against the project's Network Map plan, Wi-Fi survey and walk test, as-found IP schedule. Full feature list: README.md.

## Spine / platform
- Spine version: 1.2.6 pattern (pre-shell): sonor-header, sonor-theme (graphite), brand.css, served kit, the shared SonorProjectBar (`?pid=`, `sonor_active_project_id`, `sonor:project-changed`), `app_versions` self-report (app_key `net-scanner`), sonor-app-auth for the Android app.
- Hub group **android**. Favicon = `data/favicons/android.svg` copied to public/data/favicon.svg (registry-check 5).
- The page loads **public/data/**, not data/. sync-everything.sh refreshes every shared file already in public/data from its master (2026-11-26); never hand-edit a copy there.
- Three places run this page: the Pi / laptop agent (`node server.js`, port 8050), apps.sonor.co.uk/sonor-net-scanner/public/ (gateway sign-in, `?demo=1` for the Hub card), and the Android app. The Android copy (`APP - Android Apps/netscanner/scanner/{public,lib,server.js}`) is a **mirror** made by sync-everything.sh from `android-mirrors.tsv`: edit here only.

## Shared seams consumed
- `network_configs` (Network Map plan, read; "Fill missing MACs and serials" writes only empty fields with the updated_at guard).
- `net_scans` + `v_net_scans` + RPCs `net_scan_assign / apply / dismiss` (this app is the one writer of scans; Network Map reads them in its Scans tab and links back with `?pid=&scan=`).
- Takeoffs floor plans through `sonor-plan-image.js` (read only; plans are uploaded from the Mac web apps, never from Android).
- Shared files (masters at the workspace root or the kit): sonor-header.*, sonor-theme.js, sonor-vocab.css, brand.css, sonor-brand.js, sonor-project-bus/list/bar.js, sonor-plan-image.js, sonor-wireless.js, wifi-rf-rules.json, sonor-artnet.js, lib/sitelog.js (= sonor-sitelog.js), sonor-app-auth.js (master `APP - Android Apps/shared/`).
- This thread is the single writer of `sonor-wireless.js` and `sonor-sitelog.js`.

## Brand overrides
None. Graphite theme, service colours from sonor-brand.js.

## Data: where it lives
- Supabase: `net_scans` (uploads, `scanned_by` = signed-in person via `sonor_who()`), `app_versions`.
- On the agent / tablet: scan history, device names and notes (`notes.json`), troubleshooting logs. In the browser: Wi-Fi walk readings (`netscan.walk`), UI settings. An Upload carries the walk and survey inside `net_scans.netinfo`.
- `site_findings` (shared, Takeoffs contract `docs/SITE-INFO-CONTRACT.md`): since 1.8.2 an Upload upserts every found non-personal device (source_app `scanner`, key `mac:` else `ip:`, facts only, never `state`), carrying the engineer's names and notes to the office.
- **Open (CROSS-APP-CONTRACTS Notices):** read `projects.metadata.wireless_plan` and radio roles through `SonorWireless.radioOf`.

## Rules
- Sign-in: the gateway on the web, sonor-app-auth on Android; never a second login. All Supabase calls go through `rest()` → `sbHeaders()`.
- Port 8050 (Remotes 8049, IR & RF 8052). Node built-ins only in the agent.
- Supabase schema changes need the owner's yes first. Every round: version bump in all sites + this banner + Hub card + push block.

## Timeline
- 1.9.0 (2026-11-27): Art-Net flash watch in the Log tab (`lib/artwatch.js`, test/artwatch.test.js): full-packet Art-Net + broadcast / multicast capture on its own port (ideally a mirror of the node's switch port), alerts (second sender, reset / re-address packets, OFF channels lit at once, blackout, length change, bursts flagged when about hourly), every changed DMX frame logged, "Flash seen now" marks, and a .pcap clip from 2 min before to 1 min after each alert (`scans/pcap/flash/`, downloads at `/pcap/flash/`). Built for the 2 Parkside hourly flash.
- 1.8.2 (2026-11-26): Upload reports found devices to `site_findings` (test/findings.test.js).
- 1.8.x (2026-11-25): universal project bar, site log sessions (sonor-sitelog 1.1.0), Art-Net / traffic fault finders.
- 1.6.x (2026-11-24): `?pid=` / `&scan=` deep links, shared project id, Wi-Fi map on Takeoffs plans, wireless rules.
- 1.4.0 (2026-11-24): Wi-Fi tab. 1.3.0: network at a glance, scan upload + office review. 1.0.0 (2026-11-24): first build.
