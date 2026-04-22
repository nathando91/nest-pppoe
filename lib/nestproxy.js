/**
 * NestProxy Server Sync Module
 * 
 * Handles communication with the NestProxy API server to push proxy data
 * (IP:port) for each PPPoE session. Mirrors the C# farm controller logic.
 * 
 * API Endpoints used:
 *   - POST /api/dev/proxy/add          — Add a proxy entry (VIP or regular)
 *   - POST /api/dev/proxy/remove       — Remove a proxy entry by ID
 *   - POST /api/dev/proxy/clear        — Clear proxies for a VM + Machine
 *   - POST /api/dev/proxy/machine/clear-all — Clear ALL proxies for a machine
 *   - GET  /api/dev/proxy/list/status  — Get status of all proxies for machine
 *   - GET  /api/dev/machine/detail     — Heartbeat / ping
 *   - GET  /api/dev/configuration      — Get server configuration
 *   - POST /api/dev/virtual_machine/status    — Update VM status
 *   - POST /api/dev/virtual_machine/ip_address — Update VM IP
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { readConfig, writeConfig, getAccountForSession, getTotalSessions } = require('./config');

// ---- State ----

var io = null;

// Track proxy IDs returned by server for each ppp session
// Map<pppId, { vmId, proxyIds: [id1, id2, ...], ip, ports: [...] }>
// Key = ppp index (ppp0=0, ppp1=1, ...) which maps to VM ID = pppId + 1
// Persisted to proxy_tracking.json so it survives restarts
var sessionProxies = new Map();
var TRACKING_FILE = path.join(__dirname, '..', 'proxy_tracking.json');

// Server proxy status data (mirrors C# ServerProxyData)
// Map<proxyId, status>  e.g. { "123": "WAITING", "124": "USED", "125": "DONE" }
var serverStatusData = new Map();

// Timers
var heartbeatTimer = null;
var statusPollTimer = null;

// Connection state
var lastHeartbeatOk = false;
var lastHeartbeatTime = 0;
var lastStatusPollTime = 0;

// ---- Tracking Persistence ----

function saveTracking() {
    try {
        var data = {};
        sessionProxies.forEach(function(v, k) { data[k] = v; });
        fs.writeFileSync(TRACKING_FILE, JSON.stringify(data, null, 2));
    } catch (e) {
        log('saveTracking error: ' + e.message);
    }
}

function clearTracking() {
    sessionProxies.clear();
    saveTracking();
}

function loadTracking() {
    try {
        if (!fs.existsSync(TRACKING_FILE)) return;
        var raw = fs.readFileSync(TRACKING_FILE, 'utf8');
        var data = JSON.parse(raw);
        for (var k in data) {
            sessionProxies.set(parseInt(k), data[k]);
        }
        log('Loaded proxy tracking for ' + sessionProxies.size + ' sessions from file');
    } catch (e) {
        log('loadTracking error: ' + e.message);
    }
}

/**
 * Load tracking from file but validate against actual running sessions.
 * Keeps entries for sessions that have an active ppp interface with an IP.
 * Removes entries for sessions that are truly dead (no pppd, no IP).
 */
async function loadAndValidateTracking() {
    // First, load all saved tracking
    loadTracking();

    if (sessionProxies.size === 0) {
        log('No saved tracking to validate');
        return;
    }

    var { getSessionIP } = require('./pppoe');
    var removed = 0;
    var kept = 0;

    // Collect keys to check (can't modify Map during iteration)
    var keys = Array.from(sessionProxies.keys());
    for (var i = 0; i < keys.length; i++) {
        var sessionId = keys[i];
        var iface = 'ppp' + sessionId;
        var ip = await getSessionIP(iface);

        if (!ip) {
            // Session is dead — remove stale tracking
            sessionProxies.delete(sessionId);
            removed++;
        } else {
            // Session is alive — keep tracking
            // But validate the IP matches (session may have rotated)
            var data = sessionProxies.get(sessionId);
            if (data && data.ip !== ip) {
                // IP changed since last run — clear stale tracking
                // recoverProxies will re-sync this session
                sessionProxies.delete(sessionId);
                removed++;
                log('  ppp' + sessionId + ' IP changed (' + data.ip + ' → ' + ip + '), clearing stale tracking');
            } else {
                kept++;
            }
        }
    }

    if (removed > 0) {
        saveTracking();
    }
    log('Tracking validated: kept ' + kept + ', removed ' + removed + ' stale entries');
}

/**
 * Get tracking data for a specific session.
 * Used by recoverProxies to check if a session already has valid tracking.
 */
function getSessionTracking(sessionId) {
    return sessionProxies.get(sessionId) || null;
}

// ---- HTTP Helper ----

/**
 * Make an HTTP request (GET or POST with form-urlencoded body)
 * Mirrors C# Engine.loadUrl()
 */
function apiRequest(method, urlStr, params) {
    return new Promise(function(resolve) {
        try {
            var config = readConfig();
            var serverUrl = (config.server_url || '').replace(/\/+$/, '');
            if (!serverUrl) {
                resolve({ error: 'No server URL configured' });
                return;
            }

            var fullUrl = serverUrl + urlStr;

            // Add api_key to params
            var apiKey = config.server_api_key || '';
            if (!apiKey) {
                resolve({ error: 'No API key configured' });
                return;
            }

            if (method === 'GET') {
                // Append params to URL query string
                var separator = fullUrl.indexOf('?') === -1 ? '?' : '&';
                fullUrl += separator + 'api_key=' + encodeURIComponent(apiKey);
                if (params) {
                    fullUrl += '&' + params;
                }
            }

            var parsed = new URL(fullUrl);
            var isHttps = parsed.protocol === 'https:';
            var httpModule = isHttps ? https : http;

            var options = {
                hostname: parsed.hostname,
                port: parsed.port || (isHttps ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: method,
                headers: {
                    'User-Agent': 'NestPPPoE/1.0',
                    'x-api-key': apiKey
                },
                timeout: 15000
            };

            var postData = '';
            if (method === 'POST') {
                postData = 'api_key=' + encodeURIComponent(apiKey);
                if (params) {
                    postData += '&' + params;
                }
                options.headers['Content-Type'] = 'application/x-www-form-urlencoded';
                options.headers['Content-Length'] = Buffer.byteLength(postData);
            }

            var req = httpModule.request(options, function(res) {
                var data = '';
                res.on('data', function(chunk) { data += chunk; });
                res.on('end', function() {
                    try {
                        var json = JSON.parse(data);
                        resolve(json);
                    } catch (e) {
                        resolve({ error: 'Invalid JSON response', raw: data.substring(0, 200) });
                    }
                });
            });

            req.on('error', function(err) {
                resolve({ error: err.message });
            });

            req.on('timeout', function() {
                req.destroy();
                resolve({ error: 'Request timeout' });
            });

            if (method === 'POST') {
                req.write(postData);
            }
            req.end();

        } catch (err) {
            resolve({ error: err.message });
        }
    });
}

// ---- Config Helpers ----

function isEnabled() {
    var config = readConfig();
    return !!(config.server_enabled && config.server_url && config.server_api_key);
}

function getMachineId() {
    var config = readConfig();
    return config.machine_id || 0;
}

/**
 * Get virtual_machine_id for a session.
 * Each PPPoE session is a "virtual machine" on the server.
 * VM ID = session index + 1 (1-based, like the C# controller)
 */
function getVmId(sessionId) {
    return sessionId + 1;
}

// ---- API Methods ----

/**
 * POST /api/dev/proxy/add
 * Add a proxy entry to the server.
 * 
 * @param {number} vmId - Virtual machine ID
 * @param {number} machineId - Machine ID
 * @param {string} proxy - IP:PORT string
 * @param {number} vip - 1 for VIP, 0 for regular
 * @returns {Promise<{id: number}|null>} proxy ID or null on failure
 */
async function addProxy(vmId, machineId, proxy, vip) {
    var params = 'virtual_machine_id=' + vmId +
                 '&machine_id=' + machineId +
                 '&proxy=' + encodeURIComponent(proxy) +
                 '&vip=' + (vip || 0);

    var result = await apiRequest('POST', '/api/dev/proxy/add', params);
    if (result && result.status === 'OK' && result.data) {
        return result.data;
    }
    log('proxy/add failed: ' + JSON.stringify(result));
    return null;
}

/**
 * POST /api/dev/proxy/remove
 * Remove a proxy entry by its ID.
 */
async function removeProxy(proxyId) {
    var params = 'proxy_id=' + proxyId;
    var result = await apiRequest('POST', '/api/dev/proxy/remove', params);
    return result && result.status === 'OK';
}

/**
 * POST /api/dev/proxy/clear
 * Clear all proxies for a specific VM + Machine combo.
 */
async function clearVmProxies(vmId, machineId) {
    var params = 'virtual_machine_id=' + vmId +
                 '&machine_id=' + machineId;
    var result = await apiRequest('POST', '/api/dev/proxy/clear', params);
    return result && result.status === 'OK';
}

/**
 * POST /api/dev/proxy/machine/clear-all
 * Clear ALL proxies for the entire machine.
 */
async function clearAllMachineProxies(machineId) {
    var params = 'machine_id=' + machineId;
    var result = await apiRequest('POST', '/api/dev/proxy/machine/clear-all', params);
    return result && result.status === 'OK';
}

/**
 * GET /api/dev/proxy/list/status
 * Get status of all proxies for a machine.
 * Returns map of { proxyId: "WAITING"|"USED"|"DONE" }
 */
async function getProxyStatusList(machineId) {
    var params = 'machine_id=' + machineId;
    var result = await apiRequest('GET', '/api/dev/proxy/list/status', params);
    if (result && result.status === 'OK' && result.data) {
        return result.data;
    }
    return {};
}

/**
 * GET /api/dev/machine/detail
 * Heartbeat / ping to keep machine online.
 */
async function heartbeat(machineId) {
    var params = 'machine_id=' + machineId;
    var result = await apiRequest('GET', '/api/dev/machine/detail', params);
    return result && result.status === 'OK';
}

/**
 * POST /api/dev/virtual_machine/status
 * Update VM status (1 = changing IP, 0 = ready)
 */
async function updateVmStatus(vmId, machineId, status) {
    var params = 'virtual_machine_id=' + vmId +
                 '&machine_id=' + machineId +
                 '&status=' + status;
    var result = await apiRequest('POST', '/api/dev/virtual_machine/status', params);
    return result && result.status === 'OK';
}

/**
 * POST /api/dev/virtual_machine/ip_address
 * Notify server about IP change for a VM.
 */
async function updateVmIp(vmId, machineId, oldIp, newIp) {
    var params = 'virtual_machine_id=' + vmId +
                 '&machine_id=' + machineId +
                 '&old_ip=' + encodeURIComponent(oldIp || '') +
                 '&new_ip=' + encodeURIComponent(newIp || '');
    var result = await apiRequest('POST', '/api/dev/virtual_machine/ip_address', params);
    return result && result.status === 'OK';
}

/**
 * GET /api/dev/configuration
 * Get server configuration (resetTime, maxUser, etc.)
 */
async function getServerConfiguration() {
    var result = await apiRequest('GET', '/api/dev/configuration');
    if (result && result.status === 'OK' && result.data) {
        return result.data;
    }
    return null;
}

// ---- High-level Session Sync ----

/**
 * Push all proxy ports for a session to the server.
 * Flow: clear VM → add VIP port → add 5 regular ports
 * 
 * Mirrors C# Controller.run() logic:
 *   1. proxy/clear (clear old proxies for this VM)
 *   2. proxy/add with vip=1 for VIP port
 *   3. proxy/add with vip=0 for each regular port
 * 
 * @param {number} sessionId - PPPoE session index (0-based)
 * @param {string} ip - Session's public IP
 * @param {number[]} ports - Array of proxy ports [VIP, port2, port3, port4, port5, port6]
 */
async function pushSessionProxies(sessionId, ip, ports) {
    if (!isEnabled()) return;

    var machineId = getMachineId();
    var vmId = getVmId(sessionId);

    log('pushSessionProxies: session=' + sessionId + ' VM=' + vmId + ' IP=' + ip + ' ports=' + ports.join(','));

    // Step 1: Clear old proxies for this VM
    await clearVmProxies(vmId, machineId);

    // Clean up local tracking
    sessionProxies.delete(sessionId);
    saveTracking();

    // Step 2: Add VIP port first (required by server)
    var proxyIds = [];
    if (ports.length > 0) {
        var vipProxy = ip + ':' + ports[0];
        var vipResult = await addProxy(vmId, machineId, vipProxy, 1);
        if (vipResult && vipResult.id) {
            proxyIds.push(vipResult.id);
            log('  VIP added: ' + vipProxy + ' → ID=' + vipResult.id);
        } else {
            log('  VIP add FAILED: ' + vipProxy + ' — skipping regular ports');
            emitSyncStatus();
            return;
        }
    }

    // Step 3: Add regular ports (vip=0) — only if VIP succeeded
    for (var i = 1; i < ports.length; i++) {
        var regProxy = ip + ':' + ports[i];
        var regResult = await addProxy(vmId, machineId, regProxy, 0);
        if (regResult && regResult.id) {
            proxyIds.push(regResult.id);
            log('  Port added: ' + regProxy + ' → ID=' + regResult.id);
        } else {
            log('  Port add FAILED: ' + regProxy);
        }
    }

    // Track locally
    sessionProxies.set(sessionId, {
        vmId: vmId,
        proxyIds: proxyIds,
        ip: ip,
        ports: ports
    });
    saveTracking();

    // Emit sync status to UI
    emitSyncStatus();
}

/**
 * Sync existing session proxies to the server on startup.
 * Unlike pushSessionProxies, does NOT clear existing proxies first.
 * Server will return existing proxy ID if IP:port already exists (no duplicate).
 */
async function syncSessionProxies(sessionId, ip, ports) {
    if (!isEnabled()) return;

    var machineId = getMachineId();
    var vmId = getVmId(sessionId);

    // Add VIP port first (required by server before regular ports)
    var proxyIds = [];
    if (ports.length > 0) {
        var vipProxy = ip + ':' + ports[0];
        var vipResult = await addProxy(vmId, machineId, vipProxy, 1);
        if (vipResult && vipResult.id) {
            proxyIds.push(vipResult.id);
        } else {
            log('syncSession: ppp' + sessionId + ' VIP add failed, skipping regular ports');
            return;
        }
    }

    // Add regular ports (vip=0) — only if VIP succeeded
    for (var i = 1; i < ports.length; i++) {
        var regProxy = ip + ':' + ports[i];
        var regResult = await addProxy(vmId, machineId, regProxy, 0);
        if (regResult && regResult.id) {
            proxyIds.push(regResult.id);
        }
    }

    log('syncSession: ppp' + sessionId + ' VM=' + vmId + ' → ' + proxyIds.length + ' proxies synced');

    // Track locally
    sessionProxies.set(sessionId, {
        vmId: vmId,
        proxyIds: proxyIds,
        ip: ip,
        ports: ports
    });
    saveTracking();

    emitSyncStatus();
}

/**
 * Remove all proxies for a session from the server.
 * Called when stopping a session.
 */
async function removeSessionProxies(sessionId) {
    if (!isEnabled()) return;

    var machineId = getMachineId();
    var vmId = getVmId(sessionId);

    // Use clearVmProxies (more reliable than removing individually)
    await clearVmProxies(vmId, machineId);

    // Clean up local tracking
    sessionProxies.delete(sessionId);
    saveTracking();

    log('removeSessionProxies: session=' + sessionId + ' VM=' + vmId);
    emitSyncStatus();
}

/**
 * Clear all proxies for the machine on the server.
 * Called on stop-all or before start-all.
 */
async function clearAllProxies() {
    if (!isEnabled()) return;

    var machineId = getMachineId();
    await clearAllMachineProxies(machineId);
    sessionProxies.clear();
    saveTracking();

    log('clearAllProxies: machineId=' + machineId);
    emitSyncStatus();
}

/**
 * Notify server that a VM is changing IP (status=1)
 */
async function notifyVmChangingIp(sessionId) {
    if (!isEnabled()) return;
    var machineId = getMachineId();
    var vmId = getVmId(sessionId);
    await updateVmStatus(vmId, machineId, 1);
}

/**
 * Notify server that a VM has finished changing IP (status=0)
 */
async function notifyVmReady(sessionId) {
    if (!isEnabled()) return;
    var machineId = getMachineId();
    var vmId = getVmId(sessionId);
    await updateVmStatus(vmId, machineId, 0);
}

/**
 * Notify server about IP change
 */
async function notifyIpChange(sessionId, oldIp, newIp) {
    if (!isEnabled()) return;
    var machineId = getMachineId();
    var vmId = getVmId(sessionId);
    await updateVmIp(vmId, machineId, oldIp, newIp);
}

// ---- Status Polling ----

/**
 * Check proxy status list from server.
 * Mirrors C# ServerProxyData.updateData()
 * 
 * Checks if all proxies for a session are DONE.
 * If all DONE for a session → that session can be rotated.
 */
async function pollProxyStatus() {
    if (!isEnabled()) return;

    var machineId = getMachineId();
    try {
        var statusData = await getProxyStatusList(machineId);
        if (statusData && typeof statusData === 'object') {
            // Update local status map
            serverStatusData.clear();
            var keys = Object.keys(statusData);
            for (var k = 0; k < keys.length; k++) {
                serverStatusData.set(keys[k], statusData[keys[k]]);
            }
            lastStatusPollTime = Date.now();

            // Check for locally tracked sessions whose proxies are missing on server
            // If proxy IDs not found in server status → re-push them
            await checkAndRepushMissing(statusData);

            // Block individual DONE ports in 3proxy
            blockDonePorts();

            // Check each session: if ALL its proxyIds are DONE → emit event
            checkAllDone();

            // Emit to UI
            emitSyncStatus();
        }
    } catch (err) {
        log('pollProxyStatus error: ' + err.message);
    }
}

// Track sessions currently being re-pushed to avoid duplicate pushes
var repushingSet = new Set();

/**
 * Check locally tracked and active sessions against server status data.
 * If a session has proxy IDs that are ALL missing from the server,
 * or if a healthy session is not tracked locally, re-push it.
 */
async function checkAndRepushMissing(statusData) {
    var serverProxyIds = new Set(Object.keys(statusData));
    
    var config = readConfig();
    var total = getTotalSessions(config);
    var { getSessionIP, getProxyPorts } = require('./pppoe');

    // Collect sessions to re-push
    var sessionsToRepush = [];

    for (var i = 0; i < total; i++) {
        if (repushingSet.has(i)) continue; // already re-pushing

        var data = sessionProxies.get(i);
        if (data) {
            // Tracked locally — check if missing on server
            if (!data.proxyIds || data.proxyIds.length === 0) {
                // Tracked but no IDs? Should re-push
                sessionsToRepush.push({ sessionId: i, ip: data.ip, ports: data.ports });
                continue;
            }

            var foundOnServer = false;
            for (var p = 0; p < data.proxyIds.length; p++) {
                if (serverProxyIds.has(String(data.proxyIds[p]))) {
                    foundOnServer = true;
                    break;
                }
            }

            if (!foundOnServer) {
                sessionsToRepush.push({ sessionId: i, ip: data.ip, ports: data.ports });
            }
        } else {
            // NOT tracked locally — check if it's healthy and needs sync
            var iface = 'ppp' + i;
            var ip = await getSessionIP(iface);
            if (ip) {
                var portInfo = getProxyPorts(i);
                if (portInfo && portInfo.ports && portInfo.ports.length > 0) {
                    // Session is healthy but not tracked — push it
                    sessionsToRepush.push({ sessionId: i, ip: ip, ports: portInfo.ports.map(Number) });
                }
            }
        }
    }

    // Re-push missing sessions
    for (var i = 0; i < sessionsToRepush.length; i++) {
        var s = sessionsToRepush[i];
        repushingSet.add(s.sessionId);
        log('⚠️ Session ppp' + s.sessionId + ' proxies NOT found on server — re-pushing...');
        try {
            await pushSessionProxies(s.sessionId, s.ip, s.ports);
            log('✅ Re-pushed ppp' + s.sessionId + ' proxies to server');
        } catch (e) {
            log('❌ Re-push ppp' + s.sessionId + ' failed: ' + e.message);
        }
        repushingSet.delete(s.sessionId);
    }
}

// Track which ports are marked DONE on server
// Set<"sessionId:port">
var donePortsSet = new Set();

/**
 * Track individual DONE ports (no blocking in 3proxy).
 * 3proxy keeps all ports open — health check and proxy still work.
 * Only when ALL ports are DONE → kill + rotate.
 */
function blockDonePorts() {
    sessionProxies.forEach(function(data, sessionId) {
        if (!data.proxyIds || !data.ports) return;

        for (var i = 0; i < data.proxyIds.length; i++) {
            var pid = String(data.proxyIds[i]);
            var status = serverStatusData.get(pid);
            var port = data.ports[i];

            if (status && status.toUpperCase() === 'DONE' && port) {
                var key = sessionId + ':' + port;
                if (!donePortsSet.has(key)) {
                    donePortsSet.add(key);
                    log('  ✓ Port ' + port + ' DONE on server (ppp' + sessionId + ')');
                }
            }
        }
    });
}

// Clear DONE ports tracking for a session (when session rotates)
function clearBlockedPorts(sessionId) {
    var prefix = sessionId + ':';
    donePortsSet.forEach(function(key) {
        if (key.indexOf(prefix) === 0) {
            donePortsSet.delete(key);
        }
    });
}

/**
 * Check if all proxies for each session are DONE.
 * If ALL proxies of a session are DONE, emit 'nestproxy_session_done' event.
 * 
 * Mirrors C# ControllerManager.run() logic:
 *   while working: check allCompete → if all done, clear proxy + rotate
 */
function checkAllDone() {
    // Collect sessions to process (can't delete during forEach)
    var doneSessionIds = [];

    sessionProxies.forEach(function(data, sessionId) {
        if (!data.proxyIds || data.proxyIds.length === 0) return;

        var allDone = true;
        for (var i = 0; i < data.proxyIds.length; i++) {
            var pid = String(data.proxyIds[i]);
            var status = serverStatusData.get(pid);
            if (!status || status.toUpperCase() !== 'DONE') {
                allDone = false;
                break;
            }
        }

        if (allDone) {
            doneSessionIds.push(sessionId);
        }
    });

    // Process done sessions outside forEach
    for (var d = 0; d < doneSessionIds.length; d++) {
        var sessionId = doneSessionIds[d];
        var data = sessionProxies.get(sessionId);
        if (!data) continue;

        log('Session ' + sessionId + ' ALL proxies DONE — kill pppd & requesting rotation');

        // Clear per-port block tracking for this session
        clearBlockedPorts(sessionId);

        // Kill proxy + pppd immediately (don't hold ISP session)
        var { killProxy, killPppd } = require('./pppoe');
        (async function() {
            try {
                await killProxy(sessionId);
                await killPppd(sessionId);
                log('  Killed proxy + pppd for ppp' + sessionId);
            } catch (e) {
                log('  Kill error: ' + e.message);
            }
        })();

        // Clear this VM's proxies on server (they're all consumed)
        var machineId = getMachineId();
        clearVmProxies(data.vmId, machineId).catch(function(e) {
            log('clearVmProxies error for VM=' + data.vmId + ': ' + e.message);
        });

        // Remove local tracking
        sessionProxies.delete(sessionId);
        saveTracking();

        // Notify UI
        if (io) {
            io.emit('nestproxy_session_done', { sessionId: sessionId });
        }

        // Trigger rotation via rotation module
        try {
            var rotation = require('./rotation');
            rotation.addRequest(sessionId, 'nestproxy_done');
            log('  Rotation request queued for ppp' + sessionId);
        } catch (e) {
            log('  Failed to queue rotation: ' + e.message);
        }
    }
}

/**
 * Get proxy status for a specific proxy ID from cached data
 */
function getStatus(proxyId) {
    var pid = String(proxyId);
    return serverStatusData.has(pid) ? serverStatusData.get(pid) : 'unknown';
}

// ---- Background Tasks ----

/**
 * Send heartbeat to server.
 * Mirrors C# Form1.pingSV()
 */
async function doHeartbeat() {
    if (!isEnabled()) {
        lastHeartbeatOk = false;
        return;
    }

    var machineId = getMachineId();

    // Auto-create machine on first connect (machine_id = 0)
    if (!machineId) {
        try {
            log('machine_id is 0, auto-registering with server...');
            // Use a temp ID to trigger auto-create on server
            // The server upserts and returns the machine record
            var result = await apiRequest('GET', '/api/dev/machine/detail', 'machine_id=0');
            if (result && result.status === 'OK' && result.data && result.data.id) {
                machineId = result.data.id;
                var config = readConfig();
                config.machine_id = machineId;
                writeConfig(config);
                log('Auto-registered: machine_id = ' + machineId);
                lastHeartbeatOk = true;
                lastHeartbeatTime = Date.now();
                emitSyncStatus();
                return;
            } else {
                log('Auto-register failed: ' + JSON.stringify(result));
                lastHeartbeatOk = false;
                emitSyncStatus();
                return;
            }
        } catch (err) {
            log('Auto-register error: ' + err.message);
            lastHeartbeatOk = false;
            emitSyncStatus();
            return;
        }
    }

    try {
        var ok = await heartbeat(machineId);
        lastHeartbeatOk = ok;
        lastHeartbeatTime = Date.now();
    } catch (err) {
        lastHeartbeatOk = false;
        log('heartbeat error: ' + err.message);
    }

    emitSyncStatus();
}

// ---- Init ----

function init(socketIo) {
    io = socketIo;

    // DON'T load stale tracking — recoverProxies will sync fresh proxy data
    // loadTracking();  // Removed: causes false DONE on restart

    // Start heartbeat (every 30s)
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(doHeartbeat, 30000);

    // Delay polling to give recoverProxies time to sync fresh proxy IDs
    if (statusPollTimer) clearInterval(statusPollTimer);
    setTimeout(function() {
        statusPollTimer = setInterval(pollProxyStatus, 4000);
        log('Status polling started (4s interval)');
    }, 30000); // 30s delay

    // Immediate first heartbeat
    setTimeout(doHeartbeat, 5000);

    // Listen for 'nestproxy_session_done' to trigger rotation
    if (io) {
        io.on('connection', function(socket) {
            // Send current sync status when client connects
            socket.emit('nestproxy_status', getSyncStatus());
        });
    }

    log('NestProxy module initialized');
}

// ---- Status / UI ----

function getSyncStatus() {
    var config = readConfig();
    var enabled = isEnabled();

    // Count proxy statuses
    var waiting = 0, used = 0, done = 0, total = 0;
    serverStatusData.forEach(function(status) {
        total++;
        var s = (status || '').toUpperCase();
        if (s === 'WAITING') waiting++;
        else if (s === 'USED') used++;
        else if (s === 'DONE') done++;
    });

    // Per-session sync status as array for UI
    var sessions = [];
    sessionProxies.forEach(function(data, sid) {
        var allDone = true;
        var anyUsed = false;
        for (var i = 0; i < data.proxyIds.length; i++) {
            var pid = String(data.proxyIds[i]);
            var st = (serverStatusData.get(pid) || '').toUpperCase();
            if (st !== 'DONE') allDone = false;
            if (st === 'USED') anyUsed = true;
        }
        var sessionStatus = 'ready';
        if (allDone && data.proxyIds.length > 0) sessionStatus = 'done';
        else if (anyUsed) sessionStatus = 'in_use';

        sessions.push({
            id: sid,
            vmId: data.vmId,
            ip: data.ip,
            proxyCount: data.proxyIds.length,
            status: sessionStatus
        });
    });

    // Sort sessions by id
    sessions.sort(function(a, b) { return a.id - b.id; });

    return {
        enabled: enabled,
        serverUrl: config.server_url || '',
        machineId: config.machine_id || 0,
        connected: lastHeartbeatOk,
        lastHeartbeat: lastHeartbeatTime,
        lastStatusPoll: lastStatusPollTime,
        proxyStats: { total: total, waiting: waiting, used: used, done: done },
        sessions: sessions
    };
}

function emitSyncStatus() {
    if (io) {
        io.emit('nestproxy_status', getSyncStatus());
    }
}

// ---- Logging ----

function log(msg) {
    console.log('[NestProxy] ' + msg);
}

// ---- Module Exports ----

module.exports = {
    init,
    isEnabled,
    pushSessionProxies,
    syncSessionProxies,
    removeSessionProxies,
    clearAllProxies,
    clearTracking,
    loadAndValidateTracking,
    getSessionTracking,
    clearVmProxies: function(sessionId) {
        if (!isEnabled()) return Promise.resolve();
        var machineId = getMachineId();
        var vmId = getVmId(sessionId);
        return clearVmProxies(vmId, machineId);
    },
    notifyVmChangingIp,
    notifyVmReady,
    notifyIpChange,
    pollProxyStatus,
    getSyncStatus,
    getStatus,
    getVmId,
    getMachineId
};
