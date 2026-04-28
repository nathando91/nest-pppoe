#!/usr/bin/env node
/**
 * capture.js - HTTP Traffic Capture on PPP interfaces
 * 
 * Captures HTTP (port 80) traffic on all ppp interfaces,
 * extracts URLs, headers, and body content.
 * Logs to both console and logs/http_capture_<date>.txt
 * 
 * Usage: node capture.js [options]
 *   --interface, -i <name>   Capture on specific interface (default: any, filtered to ppp)
 *   --port, -p <number>      Port to capture (default: 80)
 *   --output, -o <file>      Output file path
 *   --all                    Capture on all interfaces (not just ppp)
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// --- Config ---
const args = process.argv.slice(2);
function getArg(flags, defaultVal) {
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  }
  return defaultVal;
}

const INTERFACE = getArg(['-i', '--interface'], 'any');
const PORT = getArg(['-p', '--port'], '80');
const CAPTURE_ALL = args.includes('--all');
const DATE_STR = new Date().toISOString().split('T')[0];
const OUTPUT_FILE = getArg(['-o', '--output'],
  path.join(__dirname, 'logs', `http_capture_${DATE_STR}.txt`)
);

// Ensure logs dir exists
const logsDir = path.dirname(OUTPUT_FILE);
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// --- Log stream ---
const logStream = fs.createWriteStream(OUTPUT_FILE, { flags: 'a' });

function log(msg) {
  console.log(msg);
  logStream.write(msg + '\n');
}

function logSeparator() {
  log('═'.repeat(90));
}

// --- Colors ---
const C = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  white: '\x1b[37m',
};

function clog(color, msg) {
  console.log(`${color}${msg}${C.reset}`);
  logStream.write(msg + '\n');
}

// --- HTTP Parser ---
class HttpSniffer {
  constructor() {
    this.buffer = '';
    this.stats = { total: 0, httpRequests: 0, httpResponses: 0 };
  }

  feed(data) {
    this.buffer += data;
    this.processBuffer();
  }

  processBuffer() {
    // Split on tcpdump packet boundary lines
    // Each packet starts with timestamp like: 08:46:18.843519 enp12s0 Out IP ...
    const packets = this.buffer.split(/(?=\d{2}:\d{2}:\d{2}\.\d+\s+\S+\s+(?:In|Out)\s+IP\s+)/);

    // Keep last chunk as it may be incomplete
    this.buffer = packets.pop() || '';

    for (const pkt of packets) {
      if (pkt.trim()) {
        this.parsePacket(pkt);
      }
    }
  }

  parsePacket(raw) {
    // Parse first line: timestamp, interface, direction, src, dst
    const headerMatch = raw.match(
      /^(\d{2}:\d{2}:\d{2}\.\d+)\s+(\S+)\s+(In|Out)\s+IP\s+(\S+)\s+>\s+(\S+?):\s+Flags/
    );
    if (!headerMatch) return;

    const [, timestamp, iface, direction, srcFull, dstFull] = headerMatch;

    // Filter: only ppp interfaces unless --all
    if (!CAPTURE_ALL && !iface.startsWith('ppp')) return;

    this.stats.total++;

    // Check if packet has length > 0 and contains HTTP
    const lengthMatch = raw.match(/length\s+(\d+)/);
    const len = lengthMatch ? parseInt(lengthMatch[1]) : 0;
    if (len === 0) return;

    // Parse IP:port - format is like "117.3.180.233.50113" (last segment is port)
    const srcParts = srcFull.split('.');
    const srcPort = srcParts.pop();
    const srcIp = srcParts.join('.');

    const dstParts = dstFull.split('.');
    const dstPort = dstParts.pop();
    const dstIp = dstParts.join('.');

    // Look for HTTP request line
    const reqMatch = raw.match(/(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT)\s+(\/\S*)\s+HTTP\/[\d.]+/);
    if (reqMatch) {
      this.stats.httpRequests++;
      this.logRequest(timestamp, iface, direction, srcIp, srcPort, dstIp, dstPort, reqMatch[1], reqMatch[2], raw);
      return;
    }

    // Look for HTTP response line
    const resMatch = raw.match(/HTTP\/[\d.]+\s+(\d{3})\s+([^\r\n]+)/);
    if (resMatch && raw.includes('HTTP:')) {
      this.stats.httpResponses++;
      this.logResponse(timestamp, iface, direction, srcIp, srcPort, dstIp, dstPort, resMatch[1], resMatch[2], raw);
      return;
    }
  }

  logRequest(ts, iface, dir, srcIp, srcPort, dstIp, dstPort, method, url, raw) {
    const headers = this.extractHeaders(raw);
    const host = headers['Host'] || headers['host'] || dstIp;
    const body = this.extractBody(raw);

    logSeparator();
    clog(C.green,   `  📤 REQUEST  [${ts}]  ${iface} (${dir})`);
    clog(C.cyan,    `  From: ${srcIp}:${srcPort}  →  To: ${dstIp}:${dstPort}`);
    clog(C.bright,  `  ${method} ${url}`);
    clog(C.magenta, `  🔗 http://${host}${url}`);

    if (Object.keys(headers).length > 0) {
      clog(C.dim, `  ┌── Headers ──`);
      for (const [k, v] of Object.entries(headers)) {
        clog(C.dim, `  │ ${k}: ${v}`);
      }
      clog(C.dim, `  └──`);
    }

    if (body) {
      clog(C.dim,   `  ┌── Body ──`);
      clog(C.white,  `  │ ${body}`);
      clog(C.dim,   `  └──`);
    }
    log('');
  }

  logResponse(ts, iface, dir, srcIp, srcPort, dstIp, dstPort, code, status, raw) {
    const headers = this.extractHeaders(raw);
    const body = this.extractBody(raw);

    const color = code.startsWith('2') ? C.green
      : code.startsWith('3') ? C.blue
      : code.startsWith('4') ? C.yellow
      : C.red;

    logSeparator();
    clog(color,     `  📥 RESPONSE [${ts}]  ${iface} (${dir})`);
    clog(C.cyan,    `  From: ${srcIp}:${srcPort}  →  To: ${dstIp}:${dstPort}`);
    clog(C.bright,  `  HTTP ${code} ${status}`);

    if (Object.keys(headers).length > 0) {
      clog(C.dim, `  ┌── Headers ──`);
      for (const [k, v] of Object.entries(headers)) {
        clog(C.dim, `  │ ${k}: ${v}`);
      }
      clog(C.dim, `  └──`);
    }

    if (body) {
      clog(C.dim,   `  ┌── Body ──`);
      clog(C.white,  `  │ ${body}`);
      clog(C.dim,   `  └──`);
    }
    log('');
  }

  extractHeaders(raw) {
    const headers = {};
    // Match lines that look like HTTP headers (Key: Value)
    // Must come after the HTTP request/response line
    const lines = raw.split('\n');
    let inHeaders = false;
    for (const line of lines) {
      if (line.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT)\s+/) || line.match(/^HTTP\/[\d.]+\s+\d{3}/)) {
        inHeaders = true;
        continue;
      }
      if (inHeaders) {
        const hMatch = line.match(/^([A-Za-z][\w-]+):\s*(.+)$/);
        if (hMatch) {
          headers[hMatch[1]] = hMatch[2].trim();
        } else if (line.trim() === '' || line.trim() === '\r') {
          break; // end of headers
        }
      }
    }
    return headers;
  }

  extractBody(raw) {
    // Find the body: after the first blank line following HTTP headers
    const lines = raw.split('\n');
    let inHeaders = false;
    let headerDone = false;
    let bodyLines = [];

    for (const line of lines) {
      if (!inHeaders && (line.match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|CONNECT)\s+/) || line.match(/^HTTP\/[\d.]+\s+\d{3}/))) {
        inHeaders = true;
        continue;
      }
      if (inHeaders && !headerDone) {
        if (line.trim() === '' || line.trim() === '\r') {
          headerDone = true;
          continue;
        }
        continue; // skip header lines
      }
      if (headerDone) {
        bodyLines.push(line);
      }
    }

    if (bodyLines.length === 0) return null;

    let body = bodyLines.join('\n').trim();
    // Filter non-printable chars
    body = body.replace(/[^\x20-\x7E\n\r\t{}[\]:,"'.=&?@_\-\/\\+!#$%^*()~`]/g, '');
    body = body.trim();
    if (body.length < 3) return null;
    if (body.length > 3000) body = body.substring(0, 3000) + '... [truncated]';
    return body;
  }

  flush() {
    if (this.buffer.trim()) {
      this.parsePacket(this.buffer);
      this.buffer = '';
    }
  }

  printStats() {
    logSeparator();
    clog(C.bright,  `  📊 Statistics (${new Date().toISOString()})`);
    clog(C.white,   `     Packets on ppp:  ${this.stats.total}`);
    clog(C.green,   `     HTTP Requests:   ${this.stats.httpRequests}`);
    clog(C.blue,    `     HTTP Responses:  ${this.stats.httpResponses}`);
    logSeparator();
  }
}

// --- Main ---
function main() {
  const sniffer = new HttpSniffer();

  logSeparator();
  clog(C.bright, `  🔍 HTTP Capture Started`);
  clog(C.white,  `     Interface:  ${INTERFACE} ${CAPTURE_ALL ? '(all)' : '(ppp only)'}`);
  clog(C.white,  `     Port:       ${PORT}`);
  clog(C.white,  `     Output:     ${OUTPUT_FILE}`);
  clog(C.white,  `     Time:       ${new Date().toISOString()}`);
  clog(C.dim,    `     Press Ctrl+C to stop`);
  logSeparator();
  log('');

  const tcpdump = spawn('tcpdump', [
    '-i', INTERFACE,
    '-A',
    '-s', '0',
    '-l',
    `tcp port ${PORT}`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let stdoutBuf = '';
  tcpdump.stdout.on('data', (chunk) => {
    sniffer.feed(chunk.toString());
  });

  tcpdump.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg && !msg.includes('listening on') && !msg.includes('verbose output')) {
      clog(C.dim, `  [tcpdump] ${msg}`);
    }
  });

  tcpdump.on('error', (err) => {
    clog(C.red, `  ❌ Failed to start tcpdump: ${err.message}`);
    clog(C.yellow, `     Run with sudo if needed: sudo node capture.js`);
    process.exit(1);
  });

  tcpdump.on('close', () => {
    sniffer.flush();
    log('');
    sniffer.printStats();
    clog(C.bright, `\n  ✅ Capture stopped. Log saved to: ${OUTPUT_FILE}`);
    logStream.end();
    process.exit(0);
  });

  // Ctrl+C
  process.on('SIGINT', () => {
    clog(C.yellow, `\n  ⏹  Stopping capture...`);
    tcpdump.kill('SIGTERM');
  });

  // Print stats every 60s
  setInterval(() => {
    sniffer.printStats();
  }, 60000);
}

main();
