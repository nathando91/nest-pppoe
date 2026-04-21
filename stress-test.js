#!/usr/bin/env node

/**
 * Proxy Stress Test - Bandwidth & Performance Tester
 * 
 * Đồng thời bơm băng thông qua TẤT CẢ proxy để stress test máy proxy.
 * Hỗ trợ cả HTTP proxy direct và HTTPS CONNECT tunnel.
 * 
 * Usage:
 *   node stress-test.js [options]
 *   --connections <n>   Số connection đồng thời mỗi proxy (default: 5)
 *   --duration <s>      Thời gian test tính bằng giây (default: 30)
 *   --file <url>        URL file để download (default: auto-select)
 *   --proxy-file <path> Đường dẫn file proxy (default: proxies.txt)
 *   --timeout <ms>      Timeout mỗi request (default: 15000)
 */

const http = require('http');
const https = require('https');
const tls = require('tls');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

// ═══ Download targets ═══
const DOWNLOAD_TARGETS = [
    // HTTPS targets (will use CONNECT tunnel) — reliable & large
    'https://speed.hetzner.de/100MB.bin',
    'https://proof.ovh.net/files/10Mb.dat',
    'https://speed.cloudflare.com/__down?bytes=50000000',
    'https://ash-speed.hetzner.com/100MB.bin',
    'https://speed.hetzner.de/1GB.bin',
    'https://speed.cloudflare.com/__down?bytes=100000000',
    // HTTP targets (direct proxy)
    'http://speedtest.tele2.net/10MB.zip',
    'http://ipv4.download.thinkbroadband.com/10MB.zip',
    'http://cachefly.cachefly.net/10mb.test',
    'http://speedtest.tele2.net/100MB.zip',
];

// ─── CLI Args ────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = { connections: 10, duration: 60, file: null, proxyFile: 'proxies.txt', timeout: 20000 };
    for (let i = 0; i < args.length; i += 2) {
        switch (args[i]) {
            case '--connections': opts.connections = parseInt(args[i + 1]); break;
            case '--duration': opts.duration = parseInt(args[i + 1]); break;
            case '--file': opts.file = args[i + 1]; break;
            case '--proxy-file': opts.proxyFile = args[i + 1]; break;
            case '--timeout': opts.timeout = parseInt(args[i + 1]); break;
        }
    }
    return opts;
}

// ─── Colors ──────────────────────────────────────────────────────────
const c = {
    reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
    red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', white: '\x1b[37m',
    bgGreen: '\x1b[42m', bgBlue: '\x1b[44m',
};

// ─── Load proxies ────────────────────────────────────────────────────
// Format: IP:port1,port2,port3,... — chỉ lấy port đầu tiên
function loadProxies(filePath) {
    return fs.readFileSync(path.resolve(filePath), 'utf-8')
        .split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#')).map(line => {
            const parts = line.split('@');
            let host, portStr, auth = null;
            if (parts.length === 2) {
                auth = parts[0];
                const hp = parts[1].split(':');
                host = hp[0];
                portStr = hp[1];
            } else {
                const hp = line.split(':');
                host = hp[0];
                portStr = hp[1];
            }
            // portStr có thể là "48188,37831,52427,..." → chỉ lấy port đầu tiên
            const firstPort = parseInt(portStr.split(',')[0]);
            const raw = host + ':' + firstPort;
            return { host, port: firstPort, auth, raw };
        });
}

// ─── Stats ───────────────────────────────────────────────────────────
class ProxyStats {
    constructor(proxy) {
        this.proxy = proxy;
        this.totalBytes = 0;
        this.totalRequests = 0;
        this.successRequests = 0;
        this.failedRequests = 0;
        this.latencies = [];
        this.errors = [];
        this._lastBytes = 0;
        this._lastTime = Date.now();
        this._speed = 0;
        this.startTime = Date.now();
        this.peakSpeed = 0;
    }
    addBytes(n) { this.totalBytes += n; }
    addReq() { this.totalRequests++; }
    addOk() { this.successRequests++; }
    addFail(e) { this.failedRequests++; if (this.errors.length < 5) this.errors.push(String(e).substring(0, 80)); }
    addLat(ms) { this.latencies.push(ms); }
    speed() {
        const now = Date.now(), el = (now - this._lastTime) / 1000;
        if (el < 0.8) return this._speed;
        this._speed = (this.totalBytes - this._lastBytes) / el;
        if (this._speed > this.peakSpeed) this.peakSpeed = this._speed;
        this._lastBytes = this.totalBytes; this._lastTime = now;
        return this._speed;
    }
    avgLat() { return this.latencies.length ? this.latencies.reduce((a, b) => a + b, 0) / this.latencies.length : 0; }
    minLat() { return this.latencies.length ? Math.min(...this.latencies) : 0; }
    maxLat() { return this.latencies.length ? Math.max(...this.latencies) : 0; }
    avgSpeed() { const el = (Date.now() - this.startTime) / 1000; return el ? this.totalBytes / el : 0; }
}

// ─── Format ──────────────────────────────────────────────────────────
function fB(b) { return b < 1024 ? b.toFixed(0) + ' B' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB' : b < 1073741824 ? (b / 1048576).toFixed(2) + ' MB' : (b / 1073741824).toFixed(2) + ' GB'; }
function fS(b) { return b < 1024 ? b.toFixed(0) + ' B/s' : b < 1048576 ? (b / 1024).toFixed(1) + ' KB/s' : b < 1073741824 ? (b / 1048576).toFixed(2) + ' MB/s' : (b / 1073741824).toFixed(2) + ' GB/s'; }
function fBit(b) { const bits = b * 8; return bits < 1e3 ? bits.toFixed(0) + ' bps' : bits < 1e6 ? (bits / 1e3).toFixed(1) + ' Kbps' : bits < 1e9 ? (bits / 1e6).toFixed(2) + ' Mbps' : (bits / 1e9).toFixed(2) + ' Gbps'; }
function fD(ms) { const s = Math.floor(ms / 1000), m = Math.floor(s / 60); return m ? `${m}m${s % 60}s` : `${s}s`; }
function bar(spd, max) { const w = 15, f = Math.min(w, Math.round((spd / max) * w)); const b = '█'.repeat(f) + '░'.repeat(w - f); return (spd > max * 0.7 ? c.green : spd > max * 0.3 ? c.yellow : c.red) + b + c.reset; }

// ─── HTTPS CONNECT tunnel download ──────────────────────────────────
function httpsDownload(proxy, targetUrl, timeout) {
    return new Promise((resolve, reject) => {
        const target = new URL(targetUrl);
        const startTime = Date.now();
        let bytes = 0;

        const connectReq = http.request({
            host: proxy.host, port: proxy.port,
            method: 'CONNECT',
            path: `${target.hostname}:${target.port || 443}`,
            headers: proxy.auth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') } : {},
            timeout: timeout,
        });

        connectReq.on('connect', (res, socket) => {
            if (res.statusCode !== 200) {
                socket.destroy();
                return reject({ error: `CONNECT ${res.statusCode}`, bytes: 0 });
            }

            const latency = Date.now() - startTime;
            const tlsOpts = { socket, servername: target.hostname, rejectUnauthorized: false };

            const tlsSock = tls.connect(tlsOpts, () => {
                const reqStr = [
                    `GET ${target.pathname}${target.search || ''} HTTP/1.1`,
                    `Host: ${target.hostname}`,
                    `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36`,
                    `Accept: */*`,
                    `Accept-Encoding: identity`,
                    `Connection: close`,
                    ``, ``
                ].join('\r\n');
                tlsSock.write(reqStr);
            });

            let headerParsed = false;
            let headerBuf = '';

            tlsSock.on('data', (chunk) => {
                if (!headerParsed) {
                    headerBuf += chunk.toString('binary');
                    const headerEnd = headerBuf.indexOf('\r\n\r\n');
                    if (headerEnd !== -1) {
                        headerParsed = true;
                        const bodyStart = headerEnd + 4;
                        const bodyPart = chunk.length - (Buffer.byteLength(headerBuf.substring(0, bodyStart), 'binary'));
                        if (bodyPart > 0) bytes += bodyPart;
                        // Check for error status
                        const statusLine = headerBuf.split('\r\n')[0];
                        const statusCode = parseInt(statusLine.split(' ')[1]);
                        if (statusCode >= 400) {
                            tlsSock.destroy();
                            return reject({ error: `HTTPS ${statusCode}`, latency, bytes: 0 });
                        }
                    }
                } else {
                    bytes += chunk.length;
                }
            });

            tlsSock.on('end', () => resolve({ latency, bytes, duration: Date.now() - startTime }));
            tlsSock.on('error', (e) => reject({ error: e.message, latency, bytes }));
            tlsSock.setTimeout(timeout, () => { tlsSock.destroy(); resolve({ latency, bytes, duration: Date.now() - startTime, timedOut: true }); });
        });

        connectReq.on('error', (e) => reject({ error: e.message, bytes: 0 }));
        connectReq.on('timeout', () => { connectReq.destroy(); reject({ error: 'CONNECT timeout', bytes: 0 }); });
        connectReq.end();
    });
}

// ─── HTTP direct proxy download ─────────────────────────────────────
function httpDownload(proxy, targetUrl, timeout) {
    return new Promise((resolve, reject) => {
        const target = new URL(targetUrl);
        const startTime = Date.now();
        let bytes = 0;

        const req = http.request({
            host: proxy.host, port: proxy.port,
            path: targetUrl, method: 'GET',
            headers: {
                'Host': target.hostname,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept': '*/*', 'Accept-Encoding': 'identity', 'Connection': 'close',
                ...(proxy.auth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') } : {}),
            },
            timeout: timeout,
        }, (res) => {
            const latency = Date.now() - startTime;

            // Follow redirect
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                res.resume();
                const loc = res.headers.location;
                if (loc.startsWith('https://')) {
                    return httpsDownload(proxy, loc, timeout).then(r => resolve({ ...r, latency })).catch(reject);
                }
                const redir = loc.startsWith('/') ? `http://${target.host}${loc}` : loc;
                return httpDownload(proxy, redir, timeout).then(r => resolve({ ...r, latency })).catch(reject);
            }

            if (res.statusCode >= 400) { res.resume(); return reject({ error: `HTTP ${res.statusCode}`, latency, bytes: 0 }); }

            res.on('data', (chunk) => { bytes += chunk.length; });
            res.on('end', () => resolve({ latency, bytes, duration: Date.now() - startTime }));
            res.on('error', (e) => reject({ error: e.message, latency, bytes }));
        });

        req.on('error', (e) => reject({ error: e.message, bytes: 0 }));
        req.on('timeout', () => { req.destroy(); reject({ error: 'timeout', bytes: 0 }); });
        req.end();
    });
}

// ─── Smart download (detect http/https) ─────────────────────────────
function download(proxy, url, timeout) {
    return url.startsWith('https://') ? httpsDownload(proxy, url, timeout) : httpDownload(proxy, url, timeout);
}

// ─── Stream download for stress test (with real-time byte counting) ─
function stressDownload(proxy, url, timeout, stats, stopSignal) {
    return new Promise((resolve) => {
        if (stopSignal.stopped) return resolve();
        const target = new URL(url);
        const isHttps = url.startsWith('https://');
        const startTime = Date.now();
        stats.addReq();

        if (isHttps) {
            // HTTPS via CONNECT
            const connectReq = http.request({
                host: proxy.host, port: proxy.port,
                method: 'CONNECT',
                path: `${target.hostname}:${target.port || 443}`,
                headers: proxy.auth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') } : {},
                timeout: timeout,
            });

            connectReq.on('connect', (res, socket) => {
                if (res.statusCode !== 200) {
                    stats.addFail(`CONNECT ${res.statusCode}`);
                    socket.destroy();
                    return resolve();
                }

                const latency = Date.now() - startTime;
                stats.addLat(latency);
                stats.addOk();

                const tlsSock = tls.connect({ socket, servername: target.hostname, rejectUnauthorized: false }, () => {
                    const reqStr = `GET ${target.pathname}${target.search || ''} HTTP/1.1\r\nHost: ${target.hostname}\r\nUser-Agent: Mozilla/5.0\r\nAccept: */*\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`;
                    tlsSock.write(reqStr);
                });

                let headerParsed = false;
                let headerBuf = '';

                tlsSock.on('data', (chunk) => {
                    if (stopSignal.stopped) { tlsSock.destroy(); return; }
                    if (!headerParsed) {
                        headerBuf += chunk.toString('binary');
                        const idx = headerBuf.indexOf('\r\n\r\n');
                        if (idx !== -1) {
                            headerParsed = true;
                            // Count body bytes after header
                            const headerLen = Buffer.byteLength(headerBuf.substring(0, idx + 4), 'binary');
                            const bodyBytes = chunk.length - headerLen;
                            if (bodyBytes > 0) stats.addBytes(bodyBytes);
                        }
                    } else {
                        stats.addBytes(chunk.length);
                    }
                });

                tlsSock.on('end', resolve);
                tlsSock.on('error', () => resolve());
                tlsSock.setTimeout(timeout, () => { tlsSock.destroy(); resolve(); });
            });

            connectReq.on('error', (e) => { stats.addFail(e.message); resolve(); });
            connectReq.on('timeout', () => { stats.addFail('CONNECT timeout'); connectReq.destroy(); resolve(); });
            connectReq.end();

        } else {
            // HTTP direct
            const req = http.request({
                host: proxy.host, port: proxy.port,
                path: url, method: 'GET',
                headers: {
                    'Host': target.hostname,
                    'User-Agent': 'Mozilla/5.0', 'Accept': '*/*',
                    'Accept-Encoding': 'identity', 'Connection': 'close',
                    ...(proxy.auth ? { 'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.auth).toString('base64') } : {}),
                },
                timeout: timeout,
            }, (res) => {
                const latency = Date.now() - startTime;

                // Redirect to HTTPS
                if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                    res.resume();
                    stats.totalRequests--; // Don't double-count
                    return stressDownload(proxy, res.headers.location, timeout, stats, stopSignal).then(resolve);
                }

                if (res.statusCode >= 400) { stats.addFail(`HTTP ${res.statusCode}`); res.resume(); return resolve(); }

                stats.addOk();
                stats.addLat(latency);

                res.on('data', (chunk) => {
                    if (stopSignal.stopped) { res.destroy(); return; }
                    stats.addBytes(chunk.length);
                });
                res.on('end', resolve);
                res.on('error', () => resolve());
            });

            req.on('error', (e) => { stats.addFail(e.message); resolve(); });
            req.on('timeout', () => { stats.addFail('timeout'); req.destroy(); resolve(); });
            req.end();
        }
    });
}

// ─── Worker ──────────────────────────────────────────────────────────
async function worker(proxy, stats, targets, timeout, stopSignal) {
    let idx = Math.floor(Math.random() * targets.length);
    while (!stopSignal.stopped) {
        await stressDownload(proxy, targets[idx % targets.length], timeout, stats, stopSignal);
        idx++;
        if (stats.failedRequests > stats.successRequests && stats.totalRequests > 5) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

// ─── Known working targets (skip slow probing) ─────────────────────
const PROVEN_TARGETS = [
    'https://proof.ovh.net/files/10Mb.dat',
    'https://speed.cloudflare.com/__down?bytes=50000000',
    'https://ash-speed.hetzner.com/100MB.bin',
    'https://speed.hetzner.de/100MB.bin',
    'https://speed.cloudflare.com/__down?bytes=100000000',
    'https://speed.hetzner.de/1GB.bin',
];

// ─── Dashboard ───────────────────────────────────────────────────────
function renderDashboard(allStats, elapsed, duration, opts, targets) {
    const lines = [''];
    lines.push(`${c.bgBlue}${c.white}${c.bold}  🚀 PROXY STRESS TEST - LIVE DASHBOARD  ${c.reset}`);
    lines.push(`${c.dim}  ${fD(elapsed * 1000)} / ${fD(duration * 1000)}  │  ${allStats.length} proxies × ${opts.connections} conn = ${allStats.length * opts.connections} total  │  ${targets.length} targets${c.reset}`);

    const p = Math.min(1, elapsed / duration), pw = 50, pf = Math.round(p * pw);
    lines.push(`  ${c.green}${'█'.repeat(pf)}${c.dim}${'░'.repeat(pw - pf)}${c.reset} ${(p * 100).toFixed(1)}%`);
    lines.push('');

    let tB = 0, tR = 0, tOk = 0, tFail = 0, mx = 1;
    const spds = allStats.map(s => { tB += s.totalBytes; tR += s.totalRequests; tOk += s.successRequests; tFail += s.failedRequests; const sp = s.speed(); if (sp > mx) mx = sp; return sp; });
    const tSpd = spds.reduce((a, b) => a + b, 0);

    lines.push(`  ${c.bold}📊 AGGREGATE${c.reset}`);
    lines.push(`  ${c.cyan}Downloaded:${c.reset} ${c.bold}${fB(tB)}${c.reset}  │  ${c.cyan}Speed:${c.reset} ${c.bold}${c.green}${fS(tSpd)}${c.reset} (${c.green}${fBit(tSpd)}${c.reset})  │  ${c.cyan}Req:${c.reset} ${c.green}${tOk}✓${c.reset} ${c.red}${tFail}✗${c.reset}`);
    lines.push('');
    lines.push(`  ${c.dim}#   PROXY                          SPEED          DL       LAT     REQ    BANDWIDTH${c.reset}`);
    lines.push(`  ${c.dim}${'─'.repeat(95)}${c.reset}`);

    allStats.forEach((s, i) => {
        const sp = spds[i], idx = String(i + 1).padStart(2), px = s.proxy.raw.padEnd(30);
        const ss = fS(sp).padStart(12), dl = fB(s.totalBytes).padStart(10);
        const lat = s.avgLat() > 0 ? `${s.avgLat().toFixed(0)}ms`.padStart(6) : '   N/A';
        const rq = `${s.successRequests}/${s.totalRequests}`.padStart(7);
        const b = bar(sp, mx);
        const ico = s.failedRequests > 0 && s.successRequests === 0 ? `${c.red}✗${c.reset}` : s.successRequests > 0 ? `${c.green}●${c.reset}` : `${c.dim}○${c.reset}`;
        lines.push(`  ${ico}${c.dim}${idx}${c.reset} ${px}${ss} ${dl} ${lat} ${rq}  ${b}`);
    });

    lines.push(`  ${c.dim}${'─'.repeat(95)}${c.reset}`);
    lines.push('');
    process.stdout.write('\x1b[2J\x1b[H' + lines.join('\n'));
}

// ─── Final Report ────────────────────────────────────────────────────
function printFinalReport(allStats, duration, opts) {
    const sorted = [...allStats].sort((a, b) => b.totalBytes - a.totalBytes);
    let tB = 0, tR = 0, tOk = 0, tFail = 0;

    console.log('\n');
    console.log(`${c.bgGreen}${c.white}${c.bold}  ✅ STRESS TEST COMPLETE  ${c.reset}`);
    console.log(`${c.dim}  ${fD(duration * 1000)}  │  ${allStats.length} proxies  │  ${opts.connections} conn/proxy${c.reset}\n`);
    console.log(`${c.bold}  RK  PROXY                          AVG SPEED     PEAK SPEED      TOTAL DL   AVG LAT   OK/TOTAL  ERR${c.reset}`);
    console.log(`  ${'═'.repeat(105)}`);

    sorted.forEach((s, i) => {
        tB += s.totalBytes; tR += s.totalRequests; tOk += s.successRequests; tFail += s.failedRequests;
        const rk = `#${i + 1}`.padStart(3), px = s.proxy.raw.padEnd(30);
        const as = fS(s.avgSpeed()).padStart(12), ps = fS(s.peakSpeed).padStart(12);
        const dl = fB(s.totalBytes).padStart(10), lat = s.avgLat() > 0 ? `${s.avgLat().toFixed(0)}ms`.padStart(8) : '     N/A';
        const ok = `${s.successRequests}/${s.totalRequests}`.padStart(8);
        const er = s.failedRequests > 0 ? `${c.red}${s.failedRequests}${c.reset}` : `${c.green}0${c.reset}`;
        let medal = '  '; if (i === 0) medal = '🥇'; if (i === 1) medal = '🥈'; if (i === 2) medal = '🥉';
        const dim = (s.failedRequests > 0 && s.successRequests === 0) ? c.red + c.dim : '';
        console.log(`  ${medal}${dim}${rk} ${px}${as}  ${ps}  ${dl}  ${lat}  ${ok}${dim ? c.reset : ''}   ${er}`);
    });

    console.log(`  ${'═'.repeat(105)}\n`);
    const tAS = tB / duration;
    console.log(`${c.bold}  📈 PERFORMANCE SUMMARY${c.reset}`);
    console.log(`  ${'─'.repeat(65)}`);
    console.log(`  ${c.cyan}Total Downloaded:${c.reset}     ${c.bold}${fB(tB)}${c.reset}`);
    console.log(`  ${c.cyan}Aggregate Speed:${c.reset}      ${c.bold}${fS(tAS)}${c.reset} (${c.bold}${fBit(tAS)}${c.reset})`);
    console.log(`  ${c.cyan}Avg Speed/Proxy:${c.reset}      ${fS(tB / allStats.length / duration)} (${fBit(tB / allStats.length / duration)})`);
    console.log(`  ${c.cyan}Requests:${c.reset}             ${tR} (${c.green}${tOk} OK${c.reset}, ${c.red}${tFail} FAIL${c.reset})`);
    console.log(`  ${c.cyan}Success Rate:${c.reset}         ${tR ? (tOk / tR * 100).toFixed(1) : '0'}%`);
    const alive = sorted.filter(s => s.successRequests > 0).length;
    const dead = sorted.filter(s => s.successRequests === 0 && s.failedRequests > 0).length;
    console.log(`  ${c.cyan}Alive:${c.reset}                ${c.green}${alive}${c.reset} / ${allStats.length}`);
    if (dead > 0) console.log(`  ${c.cyan}Dead:${c.reset}                 ${c.red}${dead}${c.reset} / ${allStats.length}`);
    console.log(`  ${'─'.repeat(65)}`);

    const top5 = sorted.slice(0, 5).filter(s => s.successRequests > 0);
    if (top5.length) {
        console.log(`\n  ${c.bold}🏆 TOP 5 FASTEST${c.reset}`);
        top5.forEach((s, i) => console.log(`    ${i + 1}. ${s.proxy.raw}  →  avg ${c.green}${fS(s.avgSpeed())}${c.reset}  peak ${c.cyan}${fS(s.peakSpeed)}${c.reset}  (${fB(s.totalBytes)})`));
    }
    const aliveList = sorted.filter(s => s.successRequests > 0);
    if (aliveList.length > 5) {
        console.log(`\n  ${c.bold}🐢 BOTTOM 5 SLOWEST${c.reset}`);
        aliveList.slice(-5).reverse().forEach((s, i) => console.log(`    ${i + 1}. ${s.proxy.raw}  →  ${c.yellow}${fS(s.avgSpeed())}${c.reset}  (${fB(s.totalBytes)})`));
    }
    const deadList = sorted.filter(s => s.successRequests === 0 && s.failedRequests > 0);
    if (deadList.length) {
        console.log(`\n  ${c.bold}${c.red}💀 DEAD (${deadList.length})${c.reset}`);
        deadList.forEach(s => console.log(`    ${c.red}✗${c.reset} ${s.proxy.raw}  →  ${c.dim}${s.errors[s.errors.length - 1] || 'unknown'}${c.reset}`));
    }
    console.log(`\n${c.dim}  Tip: node stress-test.js --connections 10 --duration 60${c.reset}\n`);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    const opts = parseArgs();
    console.log('');
    console.log(`${c.bold}${c.cyan}╔════════════════════════════════════════════════════╗${c.reset}`);
    console.log(`${c.bold}${c.cyan}║  🚀 PROXY BANDWIDTH STRESS TEST (HTTP + HTTPS)   ║${c.reset}`);
    console.log(`${c.bold}${c.cyan}╚════════════════════════════════════════════════════╝${c.reset}\n`);

    const proxies = loadProxies(opts.proxyFile);
    console.log(`${c.green}   ✓ ${proxies.length} proxies loaded${c.reset}`);
    console.log(`${c.dim}   ${opts.connections} conn/proxy × ${proxies.length} = ${proxies.length * opts.connections} total connections${c.reset}`);
    console.log(`${c.dim}   Duration: ${opts.duration}s  │  Timeout: ${opts.timeout}ms${c.reset}\n`);

    let targets;
    if (opts.file) {
        targets = [opts.file];
    } else {
        targets = PROVEN_TARGETS;
    }
    console.log(`\n${c.green}   ✓ Using ${targets.length} target(s):${c.reset}`);
    targets.forEach(t => console.log(`${c.dim}     → ${t}${c.reset}`));

    console.log(`\n${c.yellow}   ⏳ Starting in 1s...${c.reset}`);
    await new Promise(r => setTimeout(r, 1000));

    const allStats = proxies.map(p => new ProxyStats(p));
    const stopSignal = { stopped: false };

    const workers = [];
    for (let i = 0; i < proxies.length; i++) {
        for (let j = 0; j < opts.connections; j++) {
            workers.push(worker(proxies[i], allStats[i], targets, opts.timeout, stopSignal));
        }
    }

    const t0 = Date.now();
    const interval = setInterval(() => renderDashboard(allStats, (Date.now() - t0) / 1000, opts.duration, opts, targets), 1000);

    await new Promise(r => setTimeout(r, opts.duration * 1000));
    stopSignal.stopped = true;
    clearInterval(interval);
    await Promise.race([Promise.allSettled(workers), new Promise(r => setTimeout(r, 5000))]);

    process.stdout.write('\x1b[2J\x1b[H');
    printFinalReport(allStats, opts.duration, opts);
}

main().catch(err => { console.error(`${c.red}Fatal: ${err.message}\n${err.stack}${c.reset}`); process.exit(1); });
