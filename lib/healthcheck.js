/**
 * Health Check Monitor
 * Periodically checks if connected sessions have working internet.
 * Auto-rotates sessions that fail consecutive checks.
 */

const net = require('net');
const { getTotalSessions, readConfig } = require('./config');
const { getSessionIP, getProxyPorts } = require('./pppoe');

const CHECK_INTERVAL_MS = 60 * 1000;   // Check every 60 seconds
const TCP_TIMEOUT_MS = 10000;           // 10s timeout per check
const MAX_FAILURES = 2;                 // Auto-rotate after 2 consecutive failures
const BATCH_SIZE = 10;                  // Check 10 at a time to avoid overload

// Track consecutive failures per session: Map<id, failCount>
var failCounts = new Map();
// Track sessions that were manually stopped — health check will NOT auto-start these
var stoppedSessions = new Set();
var io = null;
var rotationQueue = null;
var running = false;

function init(socketIo, rotQueue) {
    io = socketIo;
    rotationQueue = rotQueue;

    // Wait 30s after startup before first health check (let recovery finish)
    setTimeout(function() {
        running = true;
        console.log('🏥 Health check monitor started (interval: ' + (CHECK_INTERVAL_MS / 1000) + 's, max failures: ' + MAX_FAILURES + ')');
        runHealthCheck();
        setInterval(runHealthCheck, CHECK_INTERVAL_MS);
    }, 30 * 1000);
}

function checkProxyTcp(proxyPort) {
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
            resolve({ ok: ok, latency: Date.now() - startTime });
        });

        socket.on('timeout', function() {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve({ ok: false, error: 'timeout' });
        });

        socket.on('error', function(err) {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve({ ok: false, error: err.message });
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

    for (var i = 0; i < total; i++) {
        // Skip sessions already in rotation queue
        if (inQueueIds[i]) continue;

        // Skip sessions that were manually stopped by the user
        if (stoppedSessions.has(i)) continue;

        var iface = 'ppp' + i;
        var ip = await getSessionIP(iface);

        if (!ip) {
            // Session is down — needs auto-start
            sessionsDown.push(i);
            continue;
        }

        var portInfo = getProxyPorts(i);
        if (!portInfo || !portInfo.vipPort) {
            // Has IP but no proxy — also restart
            sessionsDown.push(i);
            continue;
        }

        sessionsToCheck.push({ id: i, ip: ip, vipPort: parseInt(portInfo.vipPort) });
    }

    // Auto-start down sessions
    for (var d = 0; d < sessionsDown.length; d++) {
        var sid = sessionsDown[d];
        console.log('🏥 ppp' + sid + ' is down, auto-starting...');
        if (io) {
            io.emit('rotate_log', { id: sid, data: '🏥 Session down, auto-starting...\\n' });
        }
        rotationQueue.addRequest(sid);
        rotationQueue.executeRotation(sid);
    }

    if (sessionsToCheck.length === 0) return;

    // Check connectivity in batches
    for (var b = 0; b < sessionsToCheck.length; b += BATCH_SIZE) {
        var batch = sessionsToCheck.slice(b, b + BATCH_SIZE);
        var promises = batch.map(function(s) {
            return checkProxyTcp(s.vipPort).then(function(result) {
                return { id: s.id, ip: s.ip, ok: result.ok, error: result.error };
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
            } else {
                // Increment fail count
                var count = (failCounts.get(res.id) || 0) + 1;
                failCounts.set(res.id, count);

                if (count >= MAX_FAILURES) {
                    // Auto-rotate!
                    console.log('🏥 ppp' + res.id + ' failed ' + count + ' checks, auto-rotating...');
                    if (io) {
                        io.emit('rotate_log', { id: res.id, data: '🏥 Health check failed ' + count + 'x (' + (res.error || 'no response') + '), auto-rotating...\\n' });
                    }
                    failCounts.delete(res.id);
                    rotationQueue.addRequest(res.id);
                    rotationQueue.executeRotation(res.id);
                }
            }
        }
    }
}

// Mark a session as manually stopped (health check will skip it)
function markStopped(id) {
    stoppedSessions.add(id);
}

// Unmark a session (health check will monitor it again)
function markStarted(id) {
    stoppedSessions.delete(id);
    failCounts.delete(id);
}

// Mark all sessions as stopped
function markAllStopped(totalSessions) {
    for (var i = 0; i < totalSessions; i++) {
        stoppedSessions.add(i);
    }
}

// Clear all stopped marks
function clearAllStopped() {
    stoppedSessions.clear();
}

module.exports = { init, markStopped, markStarted, markAllStopped, clearAllStopped };
