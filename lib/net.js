'use strict';
// Small network helpers: local subnets, host lists, TCP probes, ARP table, HTTP GET.
const net = require('net');
const http = require('http');
const https = require('https');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { normMac } = require('./oui');

const ipToInt = (ip) => ip.split('.').reduce((a, o) => (a * 256) + Number(o), 0);
const intToIp = (n) => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
const isIp = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((o) => Number(o) <= 255);

// IPv4 interfaces this agent sits on (skips loopback / link-local / docker bridges).
function localSubnets() {
  const out = [];
  for (const [ifname, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|utun|awdl|llw|lo)/.test(ifname)) continue;
    for (const a of addrs || []) {
      if ((a.family !== 'IPv4' && a.family !== 4) || a.internal || a.address.startsWith('169.254.')) continue;
      const bits = a.cidr ? Number(a.cidr.split('/')[1]) : 24;
      const prefix = Math.max(bits, 22); // never sweep more than 1022 hosts per interface
      const base = (ipToInt(a.address) & (prefix === 0 ? 0 : (~0 << (32 - prefix)))) >>> 0;
      out.push({ ifname, address: a.address, mac: normMac(a.mac), cidr: `${intToIp(base)}/${prefix}`, netmaskBits: bits });
    }
  }
  return out;
}

// "192.168.1.0/24", "192.168.1", "10.0.5.0" or "10.0.0.10-10.0.0.60" → list of host IPs.
function expandTarget(t) {
  t = String(t).trim();
  let m;
  if ((m = t.match(/^(\d+\.\d+\.\d+\.\d+)\s*-\s*(\d+\.\d+\.\d+\.\d+)$/)) && isIp(m[1]) && isIp(m[2])) {
    const a = ipToInt(m[1]); const b = Math.min(ipToInt(m[2]), a + 2047);
    const r = []; for (let n = a; n <= b; n++) r.push(intToIp(n)); return r;
  }
  if (/^\d+\.\d+\.\d+$/.test(t)) t += '.0/24';
  if (isIp(t)) t += '/24';
  if ((m = t.match(/^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/)) && isIp(m[1])) {
    const bits = Math.min(Math.max(Number(m[2]), 21), 32);
    if (bits === 32) return [m[1]];
    const base = (ipToInt(m[1]) & (~0 << (32 - bits))) >>> 0;
    const size = 2 ** (32 - bits);
    const r = []; for (let i = 1; i < size - 1; i++) r.push(intToIp(base + i)); return r;
  }
  return [];
}

// TCP probe. 'open' = connected, 'closed' = refused (host is alive!), null = no answer.
function tcp(host, port, timeoutMs = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => { s.destroy(); resolve(v); };
    s.setTimeout(timeoutMs, () => done(null));
    s.on('connect', () => done('open'));
    s.on('error', (e) => done(e.code === 'ECONNREFUSED' ? 'closed' : null));
  });
}

// Connect and read whatever the service says first (optionally after sending something).
function banner(host, port, { send, timeoutMs = 1500, max = 512 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let buf = Buffer.alloc(0);
    const done = () => { s.destroy(); resolve(buf.length ? buf.toString('latin1') : null); };
    s.setTimeout(timeoutMs, done);
    s.on('error', () => done());
    s.on('connect', () => { if (send) s.write(send); });
    s.on('data', (c) => { buf = Buffer.concat([buf, c]); if (buf.length >= max) done(); });
    s.on('end', done);
  });
}

function httpGet(url, { timeoutMs = 2500, headers = {}, max = 300000 } = {}) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { return resolve(null); }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: timeoutMs, headers: { 'User-Agent': 'SonorNetScan/1.0', ...headers }, rejectUnauthorized: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; if (body.length > max) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      res.on('error', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

// Read the OS ARP / neighbour table → Map(ip → MAC).
function arpTable() {
  return new Promise((resolve) => {
    const map = new Map();
    const parse = (text) => {
      for (const line of String(text).split('\n')) {
        const ip = (line.match(/(\d+\.\d+\.\d+\.\d+)/) || [])[1];
        const macRaw = (line.match(/(([0-9a-f]{1,2}[:-]){5}[0-9a-f]{1,2})/i) || [])[1];
        if (!ip || !macRaw) continue;
        const mac = normMac(macRaw.split(/[:-]/).map((x) => x.padStart(2, '0')).join(''));
        if (mac && mac !== '00:00:00:00:00:00' && mac !== 'FF:FF:FF:FF:FF:FF') map.set(ip, mac);
      }
    };
    if (process.platform === 'linux') {
      try { parse(fs.readFileSync('/proc/net/arp', 'utf8').split('\n').filter((l) => !/0x0\s/.test(l)).join('\n')); } catch {}
      execFile('ip', ['neigh'], { timeout: 3000 }, (err, out) => { if (!err) parse(String(out).split('\n').filter((l) => !/FAILED|INCOMPLETE/.test(l)).join('\n')); resolve(map); });
      return;
    }
    execFile('arp', ['-an'], { timeout: 5000 }, (err, out) => {
      if (!err) { parse(String(out).split('\n').filter((l) => !/incomplete/i.test(l)).join('\n')); return resolve(map); }
      execFile('arp', ['-a'], { timeout: 5000 }, (e2, o2) => { if (!e2) parse(o2); resolve(map); });
    });
  });
}

// One ICMP ping through the system tool (works unprivileged on Pi OS, macOS and Windows).
function ping(host, timeoutMs = 900) {
  return new Promise((resolve) => {
    const win = process.platform === 'win32';
    const mac = process.platform === 'darwin';
    const args = win ? ['-n', '1', '-w', String(timeoutMs), host] : mac ? ['-c', '1', '-t', '1', host] : ['-c', '1', '-W', '1', host];
    const t0 = Date.now();
    execFile('ping', args, { timeout: timeoutMs + 1500 }, (err, out) => {
      if (err) return resolve(null);
      const ms = (String(out).match(/time[=<]\s*([\d.]+)\s*ms/i) || [])[1];
      resolve(ms !== undefined ? Number(ms) : Date.now() - t0);
    });
  });
}

// Run fn over items with limited concurrency.
async function pool(items, n, fn) {
  const queue = items.slice();
  const out = [];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => {
    while (queue.length) { const it = queue.shift(); out.push(await fn(it)); }
  }));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { localSubnets, expandTarget, tcp, banner, httpGet, arpTable, ping, pool, sleep, ipToInt, intToIp, isIp };
