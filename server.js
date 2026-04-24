const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const { readConfig } = require('./lib/config');
const { getPPPoEStatus, getSystemStats } = require('./lib/status');
const registerRoutes = require('./lib/routes');
const setupTerminal = require('./lib/terminal');
const rotationQueue = require('./lib/rotation');
const healthCheck = require('./lib/healthcheck');
const nestproxy = require('./lib/nestproxy');
const { initRemote } = require('./lib/remote');

const PORT = 3000;

// ============ GRACEFUL SHUTDOWN ============
// Save state on exit without killing pppd/3proxy children

function gracefulShutdown(signal) {
    console.log('\n⚡ Received ' + signal + ' — saving state (pppd/3proxy will keep running)...');
    try {
        // Save stopped sessions state
        healthCheck.saveState();
        console.log('   ✅ Health check state saved');
    } catch (e) {
        console.error('   ❌ Save state error:', e.message);
    }
    process.exit(0);
}

process.on('SIGINT', function() { gracefulShutdown('SIGINT'); });
process.on('SIGTERM', function() { gracefulShutdown('SIGTERM'); });

// ============ APP SETUP ============

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// ============ AUTH ============

// Simple session token store (in-memory, resets on restart)
var authTokens = new Set();

// Brute-force protection: track failed login attempts per IP
// { ip: { count: number, lastAttempt: number, lockedUntil: number } }
var loginAttempts = new Map();
var MAX_ATTEMPTS_BEFORE_LOCK = 5;
// Progressive lockout durations (in ms): after 5, 10, 15, 20+ failures
var LOCKOUT_TIERS = [
    { threshold: 5,  duration: 60 * 1000 },      // 1 minute
    { threshold: 10, duration: 5 * 60 * 1000 },   // 5 minutes
    { threshold: 15, duration: 15 * 60 * 1000 },  // 15 minutes
    { threshold: 20, duration: 30 * 60 * 1000 },  // 30 minutes
    { threshold: 30, duration: 24 * 60 * 60 * 1000 } // 24 hours (Hard block)
];

// In-memory security state (resets on restart)
var securityEvents = [];
var blockedIPs = new Map(); // ip -> { reason: string, since: number, count: number }

function logSecurityEvent(type, ip, message) {
    var event = {
        time: Date.now(),
        type: type, // 'success', 'failed', 'blocked', 'unblocked'
        ip: ip,
        message: message
    };
    securityEvents.push(event);
    if (securityEvents.length > 500) securityEvents.shift();
}

function getClientIP(req) {
    return req.headers['x-forwarded-for']
        ? req.headers['x-forwarded-for'].split(',')[0].trim()
        : req.connection.remoteAddress || req.ip || 'unknown';
}

function getLockoutDuration(failCount) {
    var duration = 0;
    for (var i = LOCKOUT_TIERS.length - 1; i >= 0; i--) {
        if (failCount >= LOCKOUT_TIERS[i].threshold) {
            duration = LOCKOUT_TIERS[i].duration;
            break;
        }
    }
    return duration;
}

function getNextLockThreshold(failCount) {
    for (var i = 0; i < LOCKOUT_TIERS.length; i++) {
        if (failCount < LOCKOUT_TIERS[i].threshold) {
            return LOCKOUT_TIERS[i].threshold;
        }
    }
    return LOCKOUT_TIERS[LOCKOUT_TIERS.length - 1].threshold;
}

// Clean up stale entries every 10 minutes
setInterval(function() {
    var now = Date.now();
    loginAttempts.forEach(function(info, ip) {
        // Remove entries that haven't had activity in 1 hour
        if (now - info.lastAttempt > 60 * 60 * 1000) {
            loginAttempts.delete(ip);
        }
    });
}, 10 * 60 * 1000);

function parseCookies(req) {
    var cookies = {};
    var header = req.headers.cookie || '';
    header.split(';').forEach(function(c) {
        var parts = c.trim().split('=');
        if (parts.length >= 2) cookies[parts[0]] = parts.slice(1).join('=');
    });
    return cookies;
}

function isAuthenticated(req) {
    var cookies = parseCookies(req);
    var token = cookies['nest_token'];
    return token && authTokens.has(token);
}

function isPasswordSet() {
    var config = readConfig();
    return !!(config.password && config.password.trim());
}

// Login endpoint with brute-force protection
app.post('/api/auth/login', function(req, res) {
    var clientIP = getClientIP(req);
    var now = Date.now();

    // Check if this IP is permanently blocked or in lockout
    var permanent = blockedIPs.get(clientIP);
    if (permanent) {
        return res.status(403).json({
            success: false,
            error: 'Địa chỉ IP của bạn bị khóa tạm thời do thử sai quá nhiều lần (' + permanent.count + ' lần).',
            blocked: true,
            reason: permanent.reason
        });
    }

    var attemptInfo = loginAttempts.get(clientIP);
    if (attemptInfo && attemptInfo.lockedUntil && now < attemptInfo.lockedUntil) {
        var remainingMs = attemptInfo.lockedUntil - now;
        var remainingSec = Math.ceil(remainingMs / 1000);
        return res.status(429).json({
            success: false,
            error: 'Quá nhiều lần thử. Vui lòng đợi ' + remainingSec + ' giây',
            locked: true,
            lockoutUntil: attemptInfo.lockedUntil,
            remainingSeconds: remainingSec
        });
    }

    var password = (req.body.password || '').toString().trim();
    var config = readConfig();
    var configPw = (config.password || '').trim();

    if (!configPw) {
        // No password set → auto-grant access
        var token = crypto.randomBytes(32).toString('hex');
        authTokens.add(token);
        res.setHeader('Set-Cookie', 'nest_token=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
        loginAttempts.delete(clientIP); // Clear on success
        return res.json({ success: true });
    }

    // Constant-time comparison to prevent timing attacks
    var inputBuf = Buffer.from(password);
    var configBuf = Buffer.from(configPw);
    var match = inputBuf.length === configBuf.length &&
                crypto.timingSafeEqual(inputBuf, configBuf);

    if (match) {
        // Success — clear failed attempts
        loginAttempts.delete(clientIP);
        logSecurityEvent('success', clientIP, 'Đăng nhập thành công');
        var token = crypto.randomBytes(32).toString('hex');
        authTokens.add(token);
        res.setHeader('Set-Cookie', 'nest_token=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
        res.json({ success: true });
    } else {
        // Failed attempt — increment counter
        if (!attemptInfo) {
            attemptInfo = { count: 0, lastAttempt: 0, lockedUntil: 0 };
        }
        attemptInfo.count++;
        attemptInfo.lastAttempt = now;

        // Check if lockout threshold is reached
        var lockDuration = getLockoutDuration(attemptInfo.count);
        if (lockDuration > 0) {
            attemptInfo.lockedUntil = now + lockDuration;
            loginAttempts.set(clientIP, attemptInfo);
            var lockSec = Math.ceil(lockDuration / 1000);
            console.log('🔒 Login locked for IP ' + clientIP + ' — ' + attemptInfo.count + ' failed attempts, locked for ' + lockSec + 's');
            return res.status(429).json({
                success: false,
                error: 'Quá nhiều lần thử sai. Bị khóa ' + lockSec + ' giây',
                locked: true,
                lockoutUntil: attemptInfo.lockedUntil,
                remainingSeconds: lockSec,
                failedAttempts: attemptInfo.count
            });
        }

        loginAttempts.set(clientIP, attemptInfo);
        logSecurityEvent('failed', clientIP, 'Thử mật khẩu sai (Lần ' + attemptInfo.count + ')');

        // Check if we should move to blockedIPs (e.g. after 30 attempts)
        if (attemptInfo.count >= 30) {
            blockedIPs.set(clientIP, {
                reason: 'Thử sai quá 30 lần',
                since: now,
                count: attemptInfo.count
            });
            logSecurityEvent('blocked', clientIP, 'IP bị khóa 24h do thử sai quá 30 lần');
        }

        // Calculate remaining attempts before next lockout
        var nextThreshold = getNextLockThreshold(attemptInfo.count);
        var remaining = nextThreshold - attemptInfo.count;

        console.log('⚠️  Failed login from IP ' + clientIP + ' — attempt #' + attemptInfo.count + ' (' + remaining + ' left before lock)');
        res.status(401).json({
            success: false,
            error: 'Mật khẩu không đúng',
            remainingAttempts: remaining,
            totalFailed: attemptInfo.count
        });
    }
});

// ============ SECURITY API ============

app.get('/api/security/status', function(req, res) {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });

    var blocked = [];
    blockedIPs.forEach((info, ip) => {
        blocked.push({ ip: ip, ...info });
    });

    res.json({
        events: securityEvents.slice().reverse(), // Newest first
        blocked: blocked
    });
});

app.post('/api/security/unblock', function(req, res) {
    if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
    var ip = req.body.ip;
    if (ip && blockedIPs.has(ip)) {
        blockedIPs.delete(ip);
        loginAttempts.delete(ip); // Reset counter
        logSecurityEvent('unblocked', ip, 'IP được mở khóa bởi người dùng');
        console.log('🔓 IP ' + ip + ' unblocked by user');
        res.json({ success: true });
    } else {
        res.status(400).json({ error: 'IP not found in blocklist' });
    }
});

// Check auth status (no auth required)
app.get('/api/auth/status', function(req, res) {
    var passwordConfigured = isPasswordSet();
    res.json({
        authenticated: !passwordConfigured || isAuthenticated(req),
        passwordSet: passwordConfigured
    });
});

// Logout endpoint
app.post('/api/auth/logout', function(req, res) {
    var cookies = parseCookies(req);
    var token = cookies['nest_token'];
    if (token) authTokens.delete(token);
    res.setHeader('Set-Cookie', 'nest_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.json({ success: true });
});

// Internal secret for server-to-server calls (auto-start on boot)
var INTERNAL_SECRET = crypto.randomBytes(16).toString('hex');

// Auth middleware — skip if no password configured
app.use('/api', function(req, res, next) {
    if (req.path.startsWith('/auth/')) return next();
    if (req.headers['x-internal-secret'] === INTERNAL_SECRET) return next();
    if (!isPasswordSet()) return next(); // No password → open access
    if (isAuthenticated(req)) return next();
    res.status(401).json({ error: 'Unauthorized' });
});

// Serve static files (no auth needed for HTML/CSS/JS)
app.use(express.static(path.join(__dirname, 'public')));

// ============ REGISTER MODULES ============

registerRoutes(app, io);
setupTerminal(io);
rotationQueue.init(io);
var _hcConfig = readConfig();
if (_hcConfig.health_check === true) {
    healthCheck.init(io, rotationQueue);
} else {
    console.log('⚪ Health check is DISABLED (set health_check: true in config to enable)');
}
nestproxy.init(io);
initRemote(io);

// ============ AUTO REFRESH ============

setInterval(function() {
    try {
        var sessions = getPPPoEStatus();
        var stats = getSystemStats(sessions);
        io.emit('status_update', { sessions: sessions, stats: stats });
    } catch (e) {
        console.error('Status update error:', e.message);
    }
}, 5000);

// ============ START ============

function startApp() {
    // Auto-recover: restart 3proxy for active PPPoE sessions
    recoverProxies().then(function() {
        // Check auto_start config
        var { readConfig } = require('./lib/config');
        var config = readConfig();
        if (config.auto_start) {
            console.log('🟢 Auto Start is ON — health check will auto-start down sessions (after 60s)');
        } else {
            console.log('⚪ Auto Start is OFF — sessions will not auto-start');
        }
    });
}

var _startConfig = readConfig();
if (_startConfig.local_enabled !== false) {
    server.listen(PORT, '0.0.0.0', function() {
        console.log('');
        console.log('🚀 Nest PPPoE Manager running at http://0.0.0.0:' + PORT);
        console.log('   Local: http://localhost:' + PORT);
        try {
            var lanIp = execSync("ip -4 addr show | grep -oP 'inet \\K192\\.168\\.[\\d.]+' | head -1", { encoding: 'utf8' }).trim();
            if (lanIp) console.log('   LAN:   http://' + lanIp + ':' + PORT);
        } catch (err) { /* ignore */ }
        console.log('');
        startApp();
    });
} else {
    console.log('');
    console.log('🚫 Local Web UI is DISABLED (local_enabled: false). Running in background mode.');
    console.log('');
    startApp();
}

async function recoverProxies() {
    var { getTotalSessions, readConfig } = require('./lib/config');
    var { getSessionIP, setupProxy, getProxyPorts, connectPppoe, sleep, isPrivateIP, scanExistingPids, scanExisting3proxyPids } = require('./lib/pppoe');
    var healthCheck = require('./lib/healthcheck');

    // Load persisted health check state (stopped sessions, etc.)
    healthCheck.loadState();

    // Scan existing pppd processes and track PIDs (kill duplicates only)
    await scanExistingPids();

    // Scan existing 3proxy processes and track PIDs
    await scanExisting3proxyPids();

    // Load existing proxy tracking from previous run (preserves server sync data)
    // Entries for dead sessions will be cleaned up below
    nestproxy.loadAndValidateTracking();

    var config = readConfig();
    var total = getTotalSessions(config);
    var recovered = 0;
    var downSessions = [];
    var waitingSessions = [];
    var cgnatSessions = [];
    var preservedSessions = []; // Sessions with valid tracking from previous run

    // Track healthy sessions for nestproxy sync (only those NOT already tracked)
    var healthySessions = [];

    // Check if any 3proxy is already running
    var alreadyRunning = false;
    try {
        var proxyCount = execSync('pgrep -c 3proxy 2>/dev/null || echo 0', { encoding: 'utf8' }).trim();
        if (parseInt(proxyCount) > 0) {
            alreadyRunning = true;
        }
    } catch (e) { /* ignore */ }

    if (!alreadyRunning) {
        console.log('🔄 Auto-recovering 3proxy for active sessions...');
    }

    for (var i = 0; i < total; i++) {
        var iface = 'ppp' + i;
        var ip = await getSessionIP(iface);
        if (ip) {
            // Has IP — setup proxy
            if (isPrivateIP(ip)) {
                cgnatSessions.push(i);
                console.log('   ⚠️ ppp' + i + ' has CGNAT IP (' + ip + '), skipping proxy setup');
                continue;
            }
            // Mark as started so health check monitors it
            healthCheck.markStarted(i);

            // Check if this session already has valid tracking from previous run
            var existingTracking = nestproxy.getSessionTracking(i);
            if (existingTracking && existingTracking.ip === ip && existingTracking.proxyIds && existingTracking.proxyIds.length > 0) {
                // Session still alive with same IP — skip re-sync
                preservedSessions.push(i);
                // Still ensure 3proxy is running for this session
                if (!alreadyRunning) {
                    try {
                        var result = await setupProxy(i, ip);
                        recovered++;
                    } catch (e) {
                        console.error('   ❌ ppp' + i + ' 3proxy recovery failed:', e.message);
                    }
                }
                continue;
            }

            if (!alreadyRunning) {
                try {
                    var result = await setupProxy(i, ip);
                    recovered++;
                    if (result && result.ports) {
                        healthySessions.push({ id: i, ip: ip, ports: result.ports });
                    }
                } catch (e) {
                    console.error('   ❌ ppp' + i + ' recovery failed:', e.message);
                }
            } else {
                // 3proxy already running — read existing port config
                var portInfo = getProxyPorts(i);
                if (portInfo && portInfo.ports && portInfo.ports.length > 0) {
                    healthySessions.push({ id: i, ip: ip, ports: portInfo.ports.map(Number) });
                }
            }
        } else {
            // No IP — check if pppd is running (waiting for PADO)
            var hasPppd = await require('./lib/pppoe').shellExec('pgrep -f "pppd call nest_ppp' + i + '$" 2>/dev/null');
            if (hasPppd) {
                // pppd running but no IP yet — give it time, don't kill
                waitingSessions.push(i);
                healthCheck.markStarted(i);
                console.log('   ⏳ ppp' + i + ' has pppd running, waiting for IP...');
            } else {
                // Truly down — no pppd at all
                downSessions.push(i);
            }
        }
    }

    // Log preserved sessions
    if (preservedSessions.length > 0) {
        console.log('🔒 Preserved ' + preservedSessions.length + ' session(s) from previous run: ppp' + preservedSessions.join(', ppp'));
    }

    if (!alreadyRunning && recovered > 0) {
        console.log('✅ Recovered 3proxy for ' + recovered + '/' + total + ' sessions');
        io.emit('refresh');
    }

    // Wait for sessions that have pppd but no IP yet
    if (waitingSessions.length > 0) {
        console.log('⏳ Waiting for ' + waitingSessions.length + ' session(s) with pppd (up to 20s)...');
        for (var w = 0; w < waitingSessions.length; w++) {
            var wId = waitingSessions[w];
            var wIface = 'ppp' + wId;
            var gotIp = false;
            for (var t = 0; t < 20; t++) {
                var wIp = await getSessionIP(wIface);
                if (wIp) {
                    if (!isPrivateIP(wIp)) {
                        var wResult = await setupProxy(wId, wIp);
                        if (wResult && wResult.ports) {
                            healthySessions.push({ id: wId, ip: wIp, ports: wResult.ports });
                        }
                        console.log('   ✅ ppp' + wId + ' got IP: ' + wIp);
                    } else {
                        console.log('   ⚠️ ppp' + wId + ' got CGNAT IP: ' + wIp);
                    }
                    gotIp = true;
                    break;
                }
                await sleep(1000);
            }
            if (!gotIp) {
                console.log('   ❌ ppp' + wId + ' timeout — will auto-retry via health check');
                downSessions.push(wId);
            }
        }
    }

    // Push healthy sessions to NestProxy server (only those not already tracked)
    if (healthySessions.length > 0 && nestproxy.isEnabled()) {
        console.log('🔄 Syncing ' + healthySessions.length + ' healthy session(s) to NestProxy server...');
        for (var h = 0; h < healthySessions.length; h++) {
            var hs = healthySessions[h];
            try {
                await nestproxy.syncSessionProxies(hs.id, hs.ip, hs.ports);
            } catch (e) {
                console.error('   ❌ Sync ppp' + hs.id + ' failed:', e.message);
            }
        }
        console.log('✅ NestProxy sync complete');
    }

    // Log down sessions (health check will handle auto-starting if needed)
    if (downSessions.length > 0) {
        console.log('ℹ️  ' + downSessions.length + ' sessions are truly down: ppp' + downSessions.join(', ppp'));
        console.log('   Health check will auto-start them if needed (after 60s delay)');
    }

}
