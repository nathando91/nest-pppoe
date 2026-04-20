/**
 * Rotation Queue Manager
 * Tracks rotation requests, auto-retries when IP doesn't change.
 */

const { getSessionIP, getProxyPorts, killProxy, killPppd, rebuildMacvlan, connectPppoe, setupProxy, sleep } = require('./pppoe');
const { PROXY_DIR, IP_FILE } = require('./config');
const fs = require('fs');
const path = require('path');
const net = require('net');

// ---- Post-rotation connectivity check ----

var CONNECTIVITY_CHECK_COUNT = 3;
var CONNECTIVITY_CHECK_DELAY_MS = 3000; // 3s between checks
var CONNECTIVITY_TCP_TIMEOUT_MS = 8000; // 8s timeout per check

function checkProxyConnectivity(proxyPort) {
    return new Promise(function(resolve) {
        var socket = new net.Socket();
        var resolved = false;

        socket.setTimeout(CONNECTIVITY_TCP_TIMEOUT_MS);

        socket.connect(proxyPort, '127.0.0.1', function() {
            socket.write('CONNECT google.com:80 HTTP/1.1\r\nHost: google.com:80\r\n\r\n');
        });

        socket.on('data', function(data) {
            if (resolved) return;
            resolved = true;
            var response = data.toString();
            var ok = response.indexOf('200') !== -1;
            socket.destroy();
            resolve(ok);
        });

        socket.on('timeout', function() {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve(false);
        });

        socket.on('error', function() {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve(false);
        });
    });
}

// Check connectivity up to CONNECTIVITY_CHECK_COUNT times.
// Returns true as soon as one check passes. Returns false if all fail.
async function verifyConnectivityAfterRotation(proxyPort, id, entry) {
    for (var c = 0; c < CONNECTIVITY_CHECK_COUNT; c++) {
        if (c > 0) await sleep(CONNECTIVITY_CHECK_DELAY_MS);
        entry.message = '🔍 Kiểm tra mạng (' + (c + 1) + '/' + CONNECTIVITY_CHECK_COUNT + ')...';
        emitQueueUpdate();
        emitSessionState(id, { ip: entry.newIp, status: 'connected', step: 'connectivity_check', message: 'Kiểm tra mạng (' + (c + 1) + '/' + CONNECTIVITY_CHECK_COUNT + ')...' });
        if (io) io.emit('rotate_log', { id: id, data: '   🔍 Kiểm tra kết nối lần ' + (c + 1) + '/' + CONNECTIVITY_CHECK_COUNT + '...\n' });

        var ok = await checkProxyConnectivity(proxyPort);
        if (ok) {
            if (io) io.emit('rotate_log', { id: id, data: '   ✅ Kết nối OK!\n' });
            return true;
        }
        if (io) io.emit('rotate_log', { id: id, data: '   ❌ Không có mạng (lần ' + (c + 1) + ')\n' });
    }
    return false;
}

// ---- IP.txt deduplication (format: IP|timestamp) ----

var IP_EXPIRE_MS = 1 * 24 * 60 * 60 * 1000; // 1 day

function loadUsedIPs() {
    try {
        var lines = fs.readFileSync(IP_FILE, 'utf8').split('\n').filter(Boolean);
        return lines.map(function(l) {
            var parts = l.trim().split('|');
            return { ip: parts[0], ts: parseInt(parts[1]) || 0 };
        });
    } catch (e) {
        return [];
    }
}

function isIpUsed(ip) {
    if (!ip) return false;
    var now = Date.now();
    var entries = loadUsedIPs();
    // Check from bottom (newest) to top (oldest)
    for (var i = entries.length - 1; i >= 0; i--) {
        // If entry is older than expiry, all above are also old — stop
        if ((now - entries[i].ts) >= IP_EXPIRE_MS) {
            break;
        }
        if (entries[i].ip === ip) {
            return true;
        }
    }
    return false;
}

function addUsedIP(ip) {
    if (!ip) return;
    var ts = Date.now();
    fs.appendFileSync(IP_FILE, ip + '|' + ts + '\n');
}

const RETRY_DELAY_MS = 60 * 1000; // 1 minute between retries
const SCAN_INTERVAL_MS = 10 * 1000; // check queue every 10s
const SUCCESS_KEEP_MS = 30 * 1000; // keep success entries for 30s then remove

// In-memory rotation queue
// Map<sessionId, { id, iface, oldIp, newIp, requestedAt, status, attempts, lastAttemptAt, nextRetryAt, message }>
var queue = new Map();
var io = null;

function init(socketIo) {
    io = socketIo;
    // Start background scanner
    setInterval(scanQueue, SCAN_INTERVAL_MS);
}

function emitQueueUpdate() {
    if (io) {
        io.emit('rotation_queue_update', getAll());
    }
}

function emitSessionState(id, updates) {
    if (!io) return;
    var iface = 'ppp' + id;
    io.emit('session_live_update', {
        id: id,
        iface: iface,
        ip: updates.ip || '',
        vipPort: updates.vipPort || '',
        ports: updates.ports || [],
        status: updates.status || 'stopped',
        proxyStatus: updates.proxyStatus || 'stopped',
        step: updates.step || '',
        message: updates.message || '',
        nextRetryAt: updates.nextRetryAt || null
    });
}

// Add a rotation request to the queue
function addRequest(id) {
    var existing = queue.get(id);
    // If already in progress, skip
    if (existing && existing.status === 'in_progress') {
        return existing;
    }
    var entry = {
        id: id,
        iface: 'ppp' + id,
        oldIp: '',
        newIp: '',
        requestedAt: Date.now(),
        status: 'queued', // queued, in_progress, pending_retry, success, failed
        attempts: 0,
        lastAttemptAt: null,
        nextRetryAt: null,
        message: 'Đang chờ...'
    };
    queue.set(id, entry);
    emitQueueUpdate();
    return entry;
}

// Execute rotation for a single session
async function executeRotation(id) {
    var entry = queue.get(id);
    if (!entry) return;

    entry.status = 'in_progress';
    entry.attempts++;
    entry.lastAttemptAt = Date.now();
    entry.nextRetryAt = null;
    entry.message = 'Đang xoay IP (lần ' + entry.attempts + ')...';
    emitQueueUpdate();

    var iface = 'ppp' + id;

    try {
        // Get old IP
        var oldIp = await getSessionIP(iface);
        if (entry.attempts === 1) {
            entry.oldIp = oldIp || '';
        }

        var oldInfo = getProxyPorts(id);
        var oldVipPort = oldInfo ? oldInfo.vipPort : '';

        if (io) {
            io.emit('rotate_log', { id: id, data: '🔄 [Lần ' + entry.attempts + '] Xoay IP cho ' + iface + '\n' });
            if (oldIp) {
                io.emit('rotate_log', { id: id, data: '   IP cũ: ' + oldIp + '\n' });
            }
        }

        emitSessionState(id, { ip: oldIp, vipPort: oldVipPort, ports: oldInfo ? oldInfo.ports : [], status: 'rotating', step: 'kill_proxy', message: 'Đang dừng proxy...' });
        entry.message = 'Dừng proxy...';
        emitQueueUpdate();

        // Kill old proxy
        await killProxy(id);

        // Disconnect pppd
        emitSessionState(id, { ip: '', status: 'rotating', step: 'disconnect', message: 'Đang ngắt kết nối...' });
        entry.message = 'Ngắt kết nối...';
        emitQueueUpdate();
        if (io) io.emit('rotate_log', { id: id, data: '   Disconnect pppd...\n' });
        await killPppd(id);
        await sleep(2000);

        // Reconnect
        emitSessionState(id, { ip: '', status: 'rotating', step: 'reconnect', message: 'Đang kết nối lại...' });
        entry.message = 'Kết nối lại...';
        emitQueueUpdate();
        if (io) io.emit('rotate_log', { id: id, data: '   Reconnect...\n' });
        var newIp = await connectPppoe(id);

        // If no IP, try rebuilding macvlan
        if (!newIp) {
            emitSessionState(id, { status: 'rotating', step: 'rebuild_macvlan', message: 'Tạo lại macvlan...' });
            entry.message = 'Tạo lại macvlan...';
            emitQueueUpdate();
            if (io) io.emit('rotate_log', { id: id, data: '   ⚠️ Không nhận IP, thử tạo lại macvlan...\n' });
            var mac = await rebuildMacvlan(id);
            if (mac && io) io.emit('rotate_log', { id: id, data: '   macvlan MAC: ' + mac + '\n' });
            newIp = await connectPppoe(id);
        }

        if (!newIp) {
            // No IP - schedule retry (never give up)
            entry.status = 'pending_retry';
            entry.newIp = '';
            entry.nextRetryAt = Date.now() + RETRY_DELAY_MS;
            entry.message = '⏳ Không có IP, thử lại (lần ' + entry.attempts + ')...';
            emitSessionState(id, { status: 'stopped', step: 'waiting', message: 'Chờ thử lại...', nextRetryAt: entry.nextRetryAt });
            if (io) {
                io.emit('rotate_log', { id: id, data: '⚠️ ' + iface + ' không nhận được IP, sẽ thử lại sau 60s (lần ' + entry.attempts + ')\n' });
            }
            emitQueueUpdate();
            return;
        }

        entry.newIp = newIp;

        // Check if IP is duplicate (same as old OR already in IP.txt)
        var isDuplicate = isIpUsed(newIp);
        if (isDuplicate) {
            // IP duplicate - always retry (no limit)
            if (io) io.emit('rotate_log', { id: id, data: '   ⚠️ IP trùng (' + newIp + ' đã có trong IP.txt), sẽ thử lại...\n' });
            
            // Try macvlan rebuild before scheduling retry
            await killPppd(id);
            var retryMac = await rebuildMacvlan(id);
            if (retryMac && io) io.emit('rotate_log', { id: id, data: '   Tạo lại macvlan (MAC: ' + retryMac + ')\n' });

            // Quick retry immediately with new macvlan
            emitSessionState(id, { ip: '', status: 'rotating', step: 'reconnect2', message: 'Kết nối lại sau macvlan...' });
            entry.message = 'Reconnect sau macvlan...';
            emitQueueUpdate();
            var retryIp = await connectPppoe(id);

            if (retryIp && !isIpUsed(retryIp)) {
                // Success! Got a unique IP
                newIp = retryIp;
                entry.newIp = newIp;
                // Fall through to success path below
            } else {
                // Still same IP or no IP - reconnect to keep session alive, schedule delayed retry
                if (!retryIp) {
                    retryIp = await connectPppoe(id);
                }
                if (retryIp) {
                    // Setup proxy with current IP to keep it alive
                    var tempResult = await setupProxy(id, retryIp);
                    var retryAt = Date.now() + RETRY_DELAY_MS;
                    emitSessionState(id, { ip: retryIp, vipPort: String(tempResult.vipPort), ports: tempResult.ports.map(String), status: 'connected', proxyStatus: 'running', step: 'waiting', message: 'IP trùng, chờ thử lại (lần ' + entry.attempts + ')', nextRetryAt: retryAt });
                }

                entry.status = 'pending_retry';
                entry.newIp = retryIp || '';
                entry.nextRetryAt = Date.now() + RETRY_DELAY_MS;
                entry.message = '⏳ IP trùng, chờ thử lại (lần ' + entry.attempts + ')';
                if (io) io.emit('rotate_log', { id: id, data: '   ⏳ Sẽ thử lại lần ' + (entry.attempts + 1) + ' sau 60s...\n' });
                emitQueueUpdate();
                return;
            }
        }

        // Setup proxy with new IP
        addUsedIP(newIp);
        emitSessionState(id, { ip: newIp, status: 'connected', step: 'proxy', message: 'Đang cấu hình proxy...' });
        entry.message = 'Cấu hình proxy...';
        emitQueueUpdate();
        if (io) io.emit('rotate_log', { id: id, data: '   IP mới: ' + newIp + '\n' });
        var result = await setupProxy(id, newIp);

        // Wait a moment for proxy to start
        await sleep(2000);

        // ---- POST-ROTATION CONNECTIVITY CHECK ----
        // Verify actual internet connectivity through the proxy
        if (io) io.emit('rotate_log', { id: id, data: '   🔍 Kiểm tra kết nối mạng...\n' });
        var hasInternet = await verifyConnectivityAfterRotation(parseInt(result.vipPort), id, entry);

        if (!hasInternet) {
            // No internet after 3 checks — tear down and re-rotate
            if (io) io.emit('rotate_log', { id: id, data: '   ⚠️ Có IP ' + newIp + ' nhưng KHÔNG có mạng! Xoay lại...\n' });
            
            // Kill proxy and pppd
            await killProxy(id);
            await killPppd(id);
            await sleep(2000);

            // Rebuild macvlan with new MAC for better chance of getting working connection
            var retryMac = await rebuildMacvlan(id);
            if (retryMac && io) io.emit('rotate_log', { id: id, data: '   Tạo lại macvlan (MAC: ' + retryMac + ')\n' });

            // Schedule retry immediately (no delay — the session has no internet)
            entry.status = 'pending_retry';
            entry.newIp = '';
            entry.nextRetryAt = Date.now() + 5000; // retry after 5 seconds
            entry.message = '⏳ Không có mạng, xoay lại (lần ' + entry.attempts + ')...';
            emitSessionState(id, { ip: '', status: 'stopped', step: 'waiting', message: 'Không có mạng, chờ xoay lại...', nextRetryAt: entry.nextRetryAt });
            if (io) io.emit('rotate_log', { id: id, data: '   ⏳ Sẽ xoay lại sau 5s (lần ' + (entry.attempts + 1) + ')...\n' });
            emitQueueUpdate();
            return;
        }

        // Done! — connectivity verified
        emitSessionState(id, { ip: newIp, vipPort: String(result.vipPort), ports: result.ports.map(String), status: 'connected', proxyStatus: 'running', step: 'done', message: '' });

        if (entry.oldIp && newIp !== entry.oldIp) {
            entry.status = 'success';
            entry.message = '✅ ' + entry.oldIp + ' → ' + newIp;
            if (io) {
                io.emit('rotate_log', { id: id, data: '✅ Đổi IP thành công: ' + entry.oldIp + ' → ' + newIp + ' (VIP:' + result.vipPort + ')\n' });
                io.emit('session_update', { id: id, output: 'OK ' + newIp + ':' + result.vipPort, code: 0 });
            }
        } else if (!entry.oldIp) {
            entry.status = 'success';
            entry.message = '✅ Khôi phục → ' + newIp;
            if (io) {
                io.emit('rotate_log', { id: id, data: '✅ Khôi phục session: ' + newIp + ' (VIP:' + result.vipPort + ')\n' });
                io.emit('session_update', { id: id, output: 'OK ' + newIp + ':' + result.vipPort, code: 0 });
            }
        } else {
            // Same IP but max retries - keep running
            if (io) {
                io.emit('rotate_log', { id: id, data: '⚠️ IP không đổi: ' + newIp + ' (VIP:' + result.vipPort + ')\n' });
                io.emit('session_update', { id: id, output: 'OK ' + newIp + ':' + result.vipPort, code: 0 });
            }
        }

        emitQueueUpdate();

        // Auto-remove success entries after a delay
        if (entry.status === 'success') {
            setTimeout(function() {
                if (queue.get(id) === entry) {
                    queue.delete(id);
                    emitQueueUpdate();
                }
            }, SUCCESS_KEEP_MS);
        }

    } catch (err) {
        entry.status = 'failed';
        entry.message = '❌ Lỗi: ' + err.message;
        emitSessionState(id, { status: 'stopped', step: 'error', message: 'Lỗi: ' + err.message });
        if (io) {
            io.emit('rotate_log', { id: id, data: '❌ Lỗi: ' + err.message + '\n' });
            io.emit('session_update', { id: id, output: 'ERROR: ' + err.message, code: 1 });
        }
        emitQueueUpdate();
    }
}

// Background scanner: check for pending_retry items whose time has come
async function scanQueue() {
    var now = Date.now();
    var entries = Array.from(queue.values());
    for (var i = 0; i < entries.length; i++) {
        var entry = entries[i];
        if (entry.status === 'pending_retry' && entry.nextRetryAt && now >= entry.nextRetryAt) {
            // Time to retry
            executeRotation(entry.id); // fire and forget
        }
    }
}

// Get all queue entries as array
function getAll() {
    var result = [];
    queue.forEach(function(entry) {
        result.push({
            id: entry.id,
            iface: entry.iface,
            oldIp: entry.oldIp,
            newIp: entry.newIp,
            requestedAt: entry.requestedAt,
            status: entry.status,
            attempts: entry.attempts,
            lastAttemptAt: entry.lastAttemptAt,
            nextRetryAt: entry.nextRetryAt,
            message: entry.message
        });
    });
    return result;
}

// Remove an entry from the queue
function removeRequest(id) {
    queue.delete(id);
    emitQueueUpdate();
}

// Clear all entries
function clearAll() {
    queue.clear();
    emitQueueUpdate();
}

module.exports = {
    init,
    addRequest,
    executeRotation,
    getAll,
    removeRequest,
    clearAll
};
