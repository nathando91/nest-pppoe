/**
 * Health Check Monitor
 * Periodically checks if connected sessions have working internet.
 * Logs failures — sweeper handles reconnect.
 */

const net = require('net');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getTotalSessions, readConfig } = require('./config');
const { getSessionIP, getProxyPorts, isPrivateIP, spawnProxyWithGuard, reconfigureProxy, killProxy } = require('./pppoe');
const nestproxy = require('./nestproxy');

const CHECK_INTERVAL_MS = 30 * 1000;   // Check every 30 seconds
const TCP_TIMEOUT_MS = 10000;           // 10s timeout per check
const BATCH_SIZE = 20;                  // Check 20 at a time to avoid overload
const MAX_FAILURES = 3;                 // Rotate after 3 consecutive failures
const ROTATE_COOLDOWN_MS = 5 * 60 * 1000; // Wait 5 mins between auto-rotations per session

// Track consecutive failures per session: Map<id, failCount>
var failCounts = new Map();
// Track last auto-rotation time per session (for cooldown)
var lastRotateAt = new Map();
// Track sessions that were manually stopped — health check will NOT auto-start these
var stoppedSessions = new Set();
var io = null;
var rotationQueue = null;
var running = false;

// Persistence file for stopped sessions state
var STATE_FILE = path.join(__dirname, '..', 'healthcheck_state.json');

function init(socketIo, rotQueue) {
    io = socketIo;
    rotationQueue = rotQueue;

    // Wait 60s after startup before first health check (let auto-start/recovery finish)
    setTimeout(function() {
        running = true;
        console.log('🏥 Health check monitor started (interval: ' + (CHECK_INTERVAL_MS / 1000) + 's, max failures: ' + MAX_FAILURES + ', cooldown: ' + (ROTATE_COOLDOWN_MS / 1000) + 's)');
        runHealthCheck();
    }, 60 * 1000);
}

function scheduleNext() {
    setTimeout(runHealthCheck, CHECK_INTERVAL_MS);
}

// Check connectivity via VN API (priority) through proxy
function checkViaVN(proxyPort) {
    return new Promise(function(resolve) {
        var resolved = false;
        var startTime = Date.now();

        var req = http.request({
            host: '127.0.0.1',
            port: proxyPort,
            method: 'GET',
            path: 'http://devapi.nestproxy.com/api/dev/check-ip',
            headers: { 'Host': 'devapi.nestproxy.com' },
            timeout: TCP_TIMEOUT_MS
        }, function(res) {
            var body = '';
            res.on('data', function(chunk) { body += chunk; });
            res.on('end', function() {
                if (resolved) return;
                resolved = true;
                try {
                    var json = JSON.parse(body);
                    var ok = json.status === 'ok' && !!json.ip;
                    resolve({ ok: ok, latency: Date.now() - startTime, source: 'VN' });
                } catch (e) {
                    resolve({ ok: false, error: 'invalid response', latency: Date.now() - startTime, source: 'VN' });
                }
            });
        });

        req.on('timeout', function() {
            if (resolved) return;
            resolved = true;
            req.destroy();
            resolve({ ok: false, error: 'timeout', source: 'VN' });
        });

        req.on('error', function(err) {
            if (resolved) return;
            resolved = true;
            resolve({ ok: false, error: err.message, source: 'VN' });
        });

        req.end();
    });
}

// Check connectivity via Google through proxy (fallback)
function checkViaGoogle(proxyPort) {
    return new Promise(function(resolve) {
        var socket = new net.Socket();
        var resolved = false;
        var startTime = Date.now();

        socket.setTimeout(TCP_TIMEOUT_MS);

        socket.connect(proxyPort, '127.0.0.1', function() {
            socket.write('CONNECT google.com:80 HTTP/1.1\r\nHost: google.com:80\r\n\r\n');
        });

        socket.on('data', function(data) {
            if (resolved) return;
            resolved = true;
            var response = data.toString();
            var ok = response.indexOf('200') !== -1;
            socket.destroy();
            resolve({ ok: ok, latency: Date.now() - startTime, source: 'Google' });
        });

        socket.on('timeout', function() {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve({ ok: false, error: 'timeout', source: 'Google' });
        });

        socket.on('error', function(err) {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve({ ok: false, error: err.message, source: 'Google' });
        });
    });
}

// Check connectivity: try VN first, fallback to Google. Either success = OK
function checkProxyConnectivity(proxyPort) {
    return checkViaVN(proxyPort).then(function(vnResult) {
        if (vnResult.ok) return vnResult;
        // VN failed, try Google as fallback
        return checkViaGoogle(proxyPort).then(function(googleResult) {
            if (googleResult.ok) return googleResult;
            // Both failed — return VN error (priority)
            return { ok: false, error: 'VN: ' + (vnResult.error || 'fail') + ', Google: ' + (googleResult.error || 'fail'), latency: vnResult.latency };
        });
    });
}

// Check connectivity directly via ppp interface (no proxy dependency)
function checkInterfaceConnectivity(iface) {
    return new Promise(function(resolve) {
        var startTime = Date.now();
        var { execFile } = require('child_process');
        
        // Try curl through the ppp interface directly
        execFile('curl', [
            '--interface', iface,
            '--connect-timeout', '8',
            '--max-time', '10',
            '-s', '-o', '/dev/null', '-w', '%{http_code}',
            'http://devapi.nestproxy.com/api/dev/check-ip'
        ], { timeout: 12000 }, function(err, stdout) {
            var latency = Date.now() - startTime;
            if (err) {
                // Fallback: try Google
                execFile('curl', [
                    '--interface', iface,
                    '--connect-timeout', '8',
                    '--max-time', '10',
                    '-s', '-o', '/dev/null', '-w', '%{http_code}',
                    'http://www.google.com'
                ], { timeout: 12000 }, function(err2, stdout2) {
                    if (err2) {
                        resolve({ ok: false, error: 'both failed', latency: latency });
                    } else {
                        var code2 = parseInt(stdout2);
                        resolve({ ok: code2 >= 200 && code2 < 400, latency: Date.now() - startTime, source: 'Google' });
                    }
                });
            } else {
                var code = parseInt(stdout);
                resolve({ ok: code >= 200 && code < 400, latency: latency, source: 'VN' });
            }
        });
    });
}


async function runHealthCheck() {
    if (!running || !rotationQueue) return;

    var config = readConfig();
    var total = getTotalSessions(config);
    if (total === 0) return;

    var queueEntries = rotationQueue.getAll();
    var inQueueIds = {};
    for (var q = 0; q < queueEntries.length; q++) {
        var qs = queueEntries[q].status;
        if (qs === 'in_progress' || qs === 'pending_retry' || qs === 'queued') {
            inQueueIds[queueEntries[q].id] = true;
        }
    }

    var sessionsToCheck = [];
    var sessionsDown = [];
    var healthySessions = [];

    // --- Optimization: Fetch all IPs in parallel first ---
    var allSessionIds = [];
    for (var i = 0; i < total; i++) allSessionIds.push(i);

    var ipPromises = allSessionIds.map(async (i) => {
        if (inQueueIds[i] || stoppedSessions.has(i)) return null;
        var iface = 'ppp' + i;
        var ip = await getSessionIP(iface);
        return { id: i, ip: ip, iface: iface };
    });

    var sessionInfos = await Promise.all(ipPromises);

    for (var i = 0; i < sessionInfos.length; i++) {
        var s = sessionInfos[i];
        if (!s) continue;

        if (!s.ip) {
            sessionsDown.push(s.id);
            continue;
        }

        // Skip CGNAT — handled by sweeper (rotation.js) and recoverProxies (server.js)
        if (isPrivateIP(s.ip)) continue;

        sessionsToCheck.push(s);
    }

    // Auto-start down sessions — sweeper handles this automatically.
    // Only log for visibility; DO NOT call addRequest (sweeper will pick them up).
    if (sessionsDown.length > 0) {
        if (config.auto_start) {
            console.log('ℹ️  ' + sessionsDown.length + ' sessions are truly down: ppp' + sessionsDown.join(', ppp'));
            console.log('   Health check will auto-start them if needed (after 60s delay)');
        } else {
            console.log('ℹ️  ' + sessionsDown.length + ' sessions down but auto_start is OFF — sweeper will handle when enabled');
        }
    }

    if (sessionsToCheck.length === 0) {
        scheduleNext();
        return;
    }

    // Check connectivity in batches (directly via ppp interface)
    for (var b = 0; b < sessionsToCheck.length; b += BATCH_SIZE) {
        var batch = sessionsToCheck.slice(b, b + BATCH_SIZE);
        var promises = batch.map(function(s) {
            return checkInterfaceConnectivity(s.iface).then(function(result) {
                return { id: s.id, ip: s.ip, ok: result.ok, error: result.error, latency: result.latency };
            });
        });

        var results = await Promise.all(promises);

        for (var r = 0; r < results.length; r++) {
            var res = results[r];
            if (res.ok) {
                // Clear fail count on success
                if (failCounts.has(res.id)) {
                    failCounts.delete(res.id);
                }
                healthySessions.push(res.id);
            } else {
                // Increment fail count
                var count = (failCounts.get(res.id) || 0) + 1;
                failCounts.set(res.id, count);
                console.log('🏥 ppp' + res.id + ' connectivity FAILED (' + count + '/' + MAX_FAILURES + '): ' + (res.error || 'no response'));

                // Auto-rotate after MAX_FAILURES consecutive failures
                if (count >= MAX_FAILURES && rotationQueue) {
                    var now = Date.now();
                    var lastRotate = lastRotateAt.get(res.id) || 0;
                    if (now - lastRotate >= ROTATE_COOLDOWN_MS) {
                        console.log('🔄 ppp' + res.id + ' — ' + count + ' consecutive failures → auto-rotating');
                        if (io) io.emit('rotate_log', { id: res.id, data: '🔄 ppp' + res.id + ': ' + count + ' lần check mạng thất bại liên tiếp → tự động xoay IP\n' });
                        lastRotateAt.set(res.id, now);
                        failCounts.delete(res.id);
                        rotationQueue.addRequest(res.id);
                    }
                }
            }
        }
    }

    // ---- 3proxy batch watchdog ----
    // Single pgrep call to find all running 3proxy, then check healthy sessions
    if (healthySessions.length > 0) {
        try {
            var { execFileSync } = require('child_process');
            var proxyList = '';
            try {
                proxyList = execFileSync('pgrep', ['-af', '3proxy'], { encoding: 'utf8', timeout: 5000 });
            } catch (e) {
                // pgrep returns exit 1 if no matches — that means zero 3proxy running
            }

            // Build set of session IDs that have a running 3proxy
            var running3proxyIds = new Set();
            var lines = proxyList.split('\n');
            for (var l = 0; l < lines.length; l++) {
                var match = lines[l].match(/3proxy_ppp(\d+)_active/);
                if (match) running3proxyIds.add(parseInt(match[1]));
            }

            // Check healthy sessions — restart 3proxy only for those missing
            for (var h = 0; h < healthySessions.length; h++) {
                var sid = healthySessions[h];
                if (running3proxyIds.has(sid)) continue; // 3proxy alive — OK

                var cfgFile = path.join(__dirname, '..', 'proxy', '3proxy_ppp' + sid + '_active.cfg');
                if (!fs.existsSync(cfgFile)) continue; // No active config — not fully set up

                console.log('🔧 3proxy ppp' + sid + ' died silently — restarting with guardian...');
                if (io) io.emit('rotate_log', { id: sid, data: '🔧 3proxy ppp' + sid + ' bị crash, đang khởi động lại (guardian)...\n' });
                spawnProxyWithGuard(sid, cfgFile);
            }

            // ---- IP mismatch detection ----
            // If pppd silently reconnected with a new IP, 3proxy config becomes stale
            for (var m = 0; m < healthySessions.length; m++) {
                var mid = healthySessions[m];
                if (!running3proxyIds.has(mid)) continue; // No running 3proxy to fix

                var mCfgFile = path.join(__dirname, '..', 'proxy', '3proxy_ppp' + mid + '_active.cfg');
                try {
                    var mContent = fs.readFileSync(mCfgFile, 'utf8');
                    var mIpMatch = mContent.match(/^# IP: (.+)$/m);
                    if (mIpMatch) {
                        var cfgIp = mIpMatch[1].trim();
                        var actualIp = await getSessionIP('ppp' + mid);
                        if (actualIp && cfgIp !== actualIp) {
                            console.log('🔧 ppp' + mid + ' IP mismatch: config=' + cfgIp + ', actual=' + actualIp + ' — reconfiguring proxy');
                            if (io) io.emit('rotate_log', { id: mid, data: '🔧 ppp' + mid + ': IP đổi (' + cfgIp + ' → ' + actualIp + ') — cấu hình lại proxy\n' });
                            var mResult = await reconfigureProxy(mid, actualIp);
                            await nestproxy.pushSessionProxies(mid, actualIp, mResult.ports).catch(function() {});
                            if (io) io.emit('rotate_log', { id: mid, data: '✅ ppp' + mid + ': proxy đã cấu hình lại → VIP:' + mResult.vipPort + '\n' });
                        }
                    }
                } catch (e2) { /* ignore read errors */ }
            }
        } catch (e) {
            console.error('[HealthCheck] 3proxy batch watchdog error:', e.message);
        }
    }

    // Schedule next run after current one finishes
    scheduleNext();
}

// Mark a session as manually stopped (health check will skip it)
function markStopped(id) {
    stoppedSessions.add(id);
    saveState();
}

// Unmark a session (health check will monitor it again)
function markStarted(id) {
    stoppedSessions.delete(id);
    failCounts.delete(id);
    saveState();
}

// Mark all sessions as stopped
function markAllStopped(totalSessions) {
    for (var i = 0; i < totalSessions; i++) {
        stoppedSessions.add(i);
    }
    saveState();
}

// Clear all stopped marks
function clearAllStopped() {
    stoppedSessions.clear();
    saveState();
}

// Save stopped sessions to disk (survives server restart)
function saveState() {
    try {
        var data = {
            stoppedSessions: Array.from(stoppedSessions),
            savedAt: Date.now()
        };
        fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        console.error('[HealthCheck] saveState error:', e.message);
    }
}

// Load stopped sessions from disk (call on startup)
function loadState() {
    try {
        if (!fs.existsSync(STATE_FILE)) return;
        var raw = fs.readFileSync(STATE_FILE, 'utf8');
        var data = JSON.parse(raw);
        if (data.stoppedSessions && Array.isArray(data.stoppedSessions)) {
            stoppedSessions = new Set(data.stoppedSessions);
            if (stoppedSessions.size > 0) {
                console.log('[HealthCheck] Loaded ' + stoppedSessions.size + ' stopped sessions from state file');
            }
        }
    } catch (e) {
        console.error('[HealthCheck] loadState error:', e.message);
    }
}

function isStopped(id) {
    return stoppedSessions.has(id);
}

module.exports = { init, markStopped, markStarted, markAllStopped, clearAllStopped, saveState, loadState, isStopped };

