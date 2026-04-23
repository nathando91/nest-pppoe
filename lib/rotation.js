/**
 * Rotation Manager — Per-Farm Sequential Sweeper
 *
 * Each farm runs ONE background worker (sweeper) that:
 *   1. Finds all stopped sessions for that farm
 *   2. Shuffles them randomly
 *   3. Tries to rotate each one ONCE — success or fail, moves on (no retry)
 *   4. Sleeps SWEEP_INTERVAL, then repeats
 *
 * 2 farms → 2 independent workers, never interfere.
 */

const { shellExec, getSessionIP, getProxyPorts, killProxy, killPppd, rebuildMacvlan, connectPppoe, setupProxy, sleep, isPrivateIP } = require('./pppoe');
const { PROXY_DIR, IP_FILE, getAccountForSession, readConfig } = require('./config');
const nestproxy = require('./nestproxy');
const fs = require('fs');
const path = require('path');

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
    for (var i = entries.length - 1; i >= 0; i--) {
        if ((now - entries[i].ts) >= IP_EXPIRE_MS) break;
        if (entries[i].ip === ip) return true;
    }
    return false;
}

function addUsedIP(ip) {
    if (!ip) return;
    fs.appendFileSync(IP_FILE, ip + '|' + Date.now() + '\n');
}

// ---- Timing ----

const SWEEP_INTERVAL_MS  = 8 * 1000;   // Time between sweeps (after a full pass)
const SUCCESS_KEEP_MS    = 15 * 1000;  // How long to show success entry in queue UI
const FAIL_KEEP_MS       = 8 * 1000;   // How long to show fail entry in queue UI

// ---- State ----

// Queue map for UI display: id → entry
var queue = new Map();

var io = null;

// Per-farm sweeper state: farmIdx → { active: bool }
var farmSweepers = new Map();

// Sessions currently being rotated (to avoid double-rotation)
var rotatingSet = new Set();

// Sweeper enabled/disabled (runtime toggle, also persisted to config)
var sweeperEnabled = true;

// ---- Socket helpers ----

function emitQueueUpdate() {
    if (io) io.emit('rotation_queue_update', getAll());
}

function emitSessionState(id, updates) {
    if (!io) return;
    var iface = 'ppp' + id;
    io.emit('session_live_update', {
        id: id,
        iface: iface,
        ip:          updates.ip          || '',
        vipPort:     updates.vipPort     || '',
        ports:       updates.ports       || [],
        status:      updates.status      || 'stopped',
        proxyStatus: updates.proxyStatus || 'stopped',
        step:        updates.step        || '',
        message:     updates.message     || '',
        nextRetryAt: updates.nextRetryAt || null
    });
}

// ---- Init ----

function init(socketIo) {
    io = socketIo;
    // Read initial sweeper state from config
    var config = readConfig();
    sweeperEnabled = config.sweeper !== false; // default ON
    // Start sweepers after server is fully booted (8s delay)
    setTimeout(startAllSweepers, 8000);
}

// ---- Farm Sweeper ----

function startAllSweepers() {
    var config = readConfig();
    if (!config.pppoe || config.pppoe.length === 0) {
        console.log('[Rotation] No farms configured, sweeper not started');
        return;
    }
    if (!sweeperEnabled) {
        console.log('[Rotation] Sweeper is DISABLED in config — skipping');
        return;
    }
    for (var i = 0; i < config.pppoe.length; i++) {
        (function(farmIdx) {
            if (!farmSweepers.has(farmIdx)) {
                var state = { active: true };
                farmSweepers.set(farmIdx, state);
                console.log('[Rotation] Farm ' + farmIdx + ' sweeper started');
                runFarmSweeper(farmIdx, state).catch(function(e) {
                    console.error('[Rotation] Farm ' + farmIdx + ' sweeper crash:', e.message);
                });
            }
        })(i);
    }
}

async function runFarmSweeper(farmIdx, state) {
    while (state.active) {
        // Pause loop if sweeper is globally disabled
        if (!sweeperEnabled) {
            await sleep(5000);
            continue;
        }
        try {
            // Only farm 0 runs the global orphan-PID cleanup (avoid duplicate runs)
            if (farmIdx === 0) {
                await cleanOrphanPids();
            }
            await sweepFarm(farmIdx, state);
        } catch (e) {
            console.error('[Rotation] Farm ' + farmIdx + ' sweep error:', e.message);
        }
        await sleep(SWEEP_INTERVAL_MS);
    }
}

// Kill pppd/3proxy processes that have no corresponding active pppN interface with IP
async function cleanOrphanPids() {
    try {
        // --- Orphan pppd ---
        var allPids = await shellExec('pgrep -a pppd 2>/dev/null');
        if (allPids) {
            var lines = allPids.split('\n').filter(Boolean);
            for (var i = 0; i < lines.length; i++) {
                var parts = lines[i].split(' ');
                var pid = parseInt(parts[0]);
                var cmd = parts.slice(1).join(' ');

                // Extract session ID from cmdline
                var unitMatch = cmd.match(/\bunit\s+(\d+)\b/);
                var peerMatch = cmd.match(/pppd call nest_ppp(\d+)/);
                var sessionId = -1;
                if (unitMatch) sessionId = parseInt(unitMatch[1]);
                else if (peerMatch) sessionId = parseInt(peerMatch[1]);
                if (sessionId < 0) continue;

                // Check if pppN interface has an IP
                var iface = 'ppp' + sessionId;
                var ip = await getSessionIP(iface);
                if (!ip) {
                    // No IP — orphan pppd keeping ISP connection open, kill it
                    console.log('[Sweeper] Orphan pppd PID ' + pid + ' (ppp' + sessionId + ' no IP) → killing');
                    if (io) io.emit('rotate_log', { id: sessionId, data: '🧹 Dọn pppd vô chủ PID ' + pid + ' (không có IP)\n' });
                    await shellExec('kill -9 ' + pid + ' 2>/dev/null');
                }
            }
        }

        // --- Orphan 3proxy ---
        var allProxy = await shellExec('pgrep -af 3proxy 2>/dev/null');
        if (allProxy) {
            var plines = allProxy.split('\n').filter(Boolean);
            for (var j = 0; j < plines.length; j++) {
                var pparts = plines[j].split(' ');
                var ppid = parseInt(pparts[0]);
                var pcmd = pparts.slice(1).join(' ');

                var proxyMatch = pcmd.match(/3proxy_ppp(\d+)_active/);
                if (!proxyMatch) continue;
                var proxySessionId = parseInt(proxyMatch[1]);

                var piface = 'ppp' + proxySessionId;
                var pip = await getSessionIP(piface);
                if (!pip) {
                    // No IP on this session — 3proxy is orphaned
                    console.log('[Sweeper] Orphan 3proxy PID ' + ppid + ' (ppp' + proxySessionId + ' no IP) → killing');
                    if (io) io.emit('rotate_log', { id: proxySessionId, data: '🧹 Dọn 3proxy vô chủ PID ' + ppid + '\n' });
                    await shellExec('kill -9 ' + ppid + ' 2>/dev/null');
                }
            }
        }
    } catch (e) {
        console.error('[Sweeper] cleanOrphanPids error:', e.message);
    }
}


async function sweepFarm(farmIdx, state) {
    var config = readConfig();
    if (!config.pppoe || farmIdx >= config.pppoe.length) return;

    // Calculate session range for this farm
    var offset = 0;
    for (var i = 0; i < farmIdx; i++) {
        offset += config.pppoe[i].max_session || 30;
    }
    var maxSess = config.pppoe[farmIdx].max_session || 30;

    // Find all stopped sessions (no active IP) that are not already rotating
    var stoppedIds = [];
    for (var s = offset; s < offset + maxSess; s++) {
        if (rotatingSet.has(s)) continue;
        var ip = await getSessionIP('ppp' + s).catch(function() { return null; });
        if (!ip) stoppedIds.push(s);
    }

    if (stoppedIds.length === 0) return; // All sessions healthy

    // Shuffle randomly
    shuffle(stoppedIds);

    // Try each stopped session once — skip failures, move on
    for (var k = 0; k < stoppedIds.length; k++) {
        if (!state.active) break;
        var id = stoppedIds[k];

        // Re-check: already rotating or came back up during this sweep
        if (rotatingSet.has(id)) continue;
        var recheck = await getSessionIP('ppp' + id).catch(function() { return null; });
        if (recheck) continue; // Already recovered

        await tryRotateOnce(id);
    }
}

// Shuffle array in-place (Fisher–Yates)
function shuffle(arr) {
    for (var i = arr.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
}

// ---- Core Rotation (one-shot, no retry) ----

/**
 * Try to rotate a session ONCE.
 * Success or failure — always resolves, never throws.
 * Updates queue UI and session state.
 */
async function tryRotateOnce(id) {
    if (rotatingSet.has(id)) return false; // Already in progress

    rotatingSet.add(id);

    var iface = 'ppp' + id;
    var entry = {
        id: id,
        iface: iface,
        oldIp: '',
        newIp: '',
        requestedAt: Date.now(),
        status: 'in_progress',
        attempts: 1,
        lastAttemptAt: Date.now(),
        nextRetryAt: null,
        message: 'Đang xoay IP...'
    };
    queue.set(id, entry);
    emitQueueUpdate();
    emitSessionState(id, { status: 'rotating', step: 'start', message: 'Đang xoay IP...' });

    if (io) io.emit('rotate_log', { id: id, data: '🔄 ' + iface + ' — bắt đầu xoay IP\n' });

    var success = false;

    try {
        // Get old IP
        var oldIp = await getSessionIP(iface).catch(function() { return null; });
        entry.oldIp = oldIp || '';

        // Kill proxy
        entry.message = 'Dừng proxy...';
        emitQueueUpdate();
        emitSessionState(id, { ip: oldIp, status: 'rotating', step: 'kill_proxy', message: 'Dừng proxy...' });
        await killProxy(id).catch(function() {});

        // Clear from NestProxy
        await nestproxy.removeSessionProxies(id, 'rotating').catch(function() {});
        await nestproxy.notifyVmChangingIp(id).catch(function() {});

        // Disconnect pppd
        entry.message = 'Ngắt kết nối...';
        emitQueueUpdate();
        emitSessionState(id, { ip: '', status: 'rotating', step: 'disconnect', message: 'Ngắt kết nối...' });
        if (io) io.emit('rotate_log', { id: id, data: '   Disconnect pppd...\n' });
        await killPppd(id).catch(function() {});
        await sleep(1000);

        // Rebuild macvlan with new MAC
        entry.message = 'Tạo lại macvlan...';
        emitQueueUpdate();
        emitSessionState(id, { ip: '', status: 'rotating', step: 'rebuild_macvlan', message: 'Tạo lại macvlan...' });
        var mac = await rebuildMacvlan(id).catch(function() { return null; });
        if (mac && io) io.emit('rotate_log', { id: id, data: '   MAC mới: ' + mac + '\n' });

        // Connect PPPoE
        entry.message = 'Kết nối PPPoE...';
        emitQueueUpdate();
        emitSessionState(id, { ip: '', status: 'rotating', step: 'reconnect', message: 'Kết nối lại...' });
        if (io) io.emit('rotate_log', { id: id, data: '   Reconnect...\n' });
        var newIp = await connectPppoe(id).catch(function() { return null; });

        if (!newIp) {
            // No IP — skip
            await killPppd(id).catch(function() {});
            entry.status = 'failed';
            entry.message = '⚠️ Không có IP — bỏ qua';
            emitQueueUpdate();
            emitSessionState(id, { ip: '', status: 'stopped', step: '', message: '' });
            if (io) io.emit('rotate_log', { id: id, data: '⚠️ ' + iface + ' không nhận được IP — bỏ qua\n' });

        } else if (isPrivateIP(newIp)) {
            // CGNAT — skip
            await killPppd(id).catch(function() {});
            entry.status = 'failed';
            entry.message = '⚠️ IP CGNAT (' + newIp + ') — bỏ qua';
            emitQueueUpdate();
            emitSessionState(id, { ip: '', status: 'stopped', step: '', message: '' });
            if (io) io.emit('rotate_log', { id: id, data: '⚠️ ' + iface + ' CGNAT: ' + newIp + ' — bỏ qua\n' });

        } else {
            // Got a public IP → setup proxy
            entry.newIp = newIp;
            addUsedIP(newIp);

            entry.message = 'Cấu hình proxy...';
            emitQueueUpdate();
            emitSessionState(id, { ip: newIp, status: 'connected', step: 'proxy', message: 'Cấu hình proxy...' });
            if (io) io.emit('rotate_log', { id: id, data: '   IP mới: ' + newIp + '\n' });

            var result = await setupProxy(id, newIp);

            emitSessionState(id, {
                ip: newIp,
                vipPort: String(result.vipPort),
                ports: result.ports.map(String),
                status: 'connected',
                proxyStatus: 'running',
                step: 'done',
                message: ''
            });

            await nestproxy.pushSessionProxies(id, newIp, result.ports).catch(function() {});
            await nestproxy.notifyVmReady(id).catch(function() {});
            if (oldIp && newIp !== oldIp) {
                await nestproxy.notifyIpChange(id, oldIp, newIp).catch(function() {});
            }

            entry.status = 'success';
            entry.message = '✅ ' + (oldIp ? oldIp + ' → ' : '') + newIp;
            emitQueueUpdate();

            if (io) {
                io.emit('rotate_log', { id: id, data: '✅ ' + iface + ': ' + (oldIp || '?') + ' → ' + newIp + ' (VIP:' + result.vipPort + ')\n' });
                io.emit('session_update', { id: id, output: 'OK ' + newIp + ':' + result.vipPort, code: 0 });
            }
            success = true;
        }

    } catch (err) {
        await killPppd(id).catch(function() {});
        entry.status = 'failed';
        entry.message = '❌ Lỗi: ' + err.message + ' — bỏ qua';
        emitQueueUpdate();
        emitSessionState(id, { ip: '', status: 'stopped', step: 'error', message: '' });
        if (io) {
            io.emit('rotate_log', { id: id, data: '❌ ' + iface + ' lỗi: ' + err.message + ' — bỏ qua\n' });
            io.emit('session_update', { id: id, output: 'ERROR: ' + err.message, code: 1 });
        }

    } finally {
        rotatingSet.delete(id);

        var keepMs = success ? SUCCESS_KEEP_MS : FAIL_KEEP_MS;
        setTimeout(function() {
            if (queue.get(id) === entry) {
                queue.delete(id);
                emitQueueUpdate();
            }
        }, keepMs);

        emitQueueUpdate();
    }

    return success;
}

// ---- Public API ----

/**
 * setSweeper: enable or disable the sweeper globally.
 * Persists state to config.json.
 */
function setSweeper(enabled) {
    sweeperEnabled = !!enabled;
    // Persist to config
    try {
        var config = readConfig();
        config.sweeper = sweeperEnabled;
        require('./config').writeConfig(config);
    } catch (e) {
        console.error('[Rotation] setSweeper config write error:', e.message);
    }
    if (sweeperEnabled) {
        // Ensure sweepers are running (start if not already)
        startAllSweepers();
        console.log('[Rotation] Sweeper ENABLED');
    } else {
        console.log('[Rotation] Sweeper DISABLED (loops will idle until re-enabled)');
    }
    if (io) io.emit('sweeper_state', { enabled: sweeperEnabled });
}

function isSweeperEnabled() {
    return sweeperEnabled;
}

/**
 * addRequest: trigger an immediate one-shot rotation for a specific session.
 * Called by healthcheck auto-rotate or manual UI rotation.
 * Non-blocking — runs async.
 */
function addRequest(id) {
    var existing = queue.get(id);
    if (existing && existing.status === 'in_progress') return existing;

    // Fire-and-forget — sweeper and caller don't need to await
    tryRotateOnce(id);
    return queue.get(id) || { id: id, iface: 'ppp' + id, status: 'in_progress', message: 'Đang chờ...' };
}

/**
 * executeRotation: explicit one-shot rotation (called from routes).
 */
function executeRotation(id) {
    return tryRotateOnce(id);
}

/**
 * getAll: return queue entries for UI display.
 */
function getAll() {
    var result = [];
    queue.forEach(function(entry) {
        result.push({
            id:            entry.id,
            iface:         entry.iface,
            oldIp:         entry.oldIp,
            newIp:         entry.newIp,
            requestedAt:   entry.requestedAt,
            status:        entry.status,
            attempts:      entry.attempts,
            lastAttemptAt: entry.lastAttemptAt,
            nextRetryAt:   entry.nextRetryAt,
            message:       entry.message
        });
    });
    return result;
}

/**
 * removeRequest: cancel / remove from queue UI.
 */
function removeRequest(id) {
    queue.delete(id);
    emitQueueUpdate();
}

/**
 * clearAll: clear entire queue.
 */
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
    clearAll,
    setSweeper,
    isSweeperEnabled
};
