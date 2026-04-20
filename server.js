const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { execSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');

const { readConfig } = require('./lib/config');
const { getPPPoEStatus, getSystemStats } = require('./lib/status');
const registerRoutes = require('./lib/routes');
const setupTerminal = require('./lib/terminal');
const rotationQueue = require('./lib/rotation');
const healthCheck = require('./lib/healthcheck');

const PORT = 3000;

// ============ APP SETUP ============

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());

// ============ AUTH ============

// Simple session token store (in-memory, resets on restart)
var authTokens = new Set();

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

// Login endpoint — simple password check
app.post('/api/auth/login', function(req, res) {
    var password = (req.body.password || '').toString().trim();
    var config = readConfig();
    var configPw = (config.password || '').trim();

    if (!configPw) {
        // No password set → auto-grant access
        var token = crypto.randomBytes(32).toString('hex');
        authTokens.add(token);
        res.setHeader('Set-Cookie', 'nest_token=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
        return res.json({ success: true });
    }

    if (password === configPw) {
        var token = crypto.randomBytes(32).toString('hex');
        authTokens.add(token);
        res.setHeader('Set-Cookie', 'nest_token=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400');
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, error: 'Mật khẩu không đúng' });
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
healthCheck.init(io, rotationQueue);

// ============ AUTO REFRESH ============

setInterval(function() {
    try {
        var sessions = getPPPoEStatus();
        var stats = getSystemStats();
        io.emit('status_update', { sessions: sessions, stats: stats });
    } catch (e) {
        console.error('Status update error:', e.message);
    }
}, 5000);

// ============ START ============

server.listen(PORT, '0.0.0.0', function() {
    console.log('');
    console.log('🚀 Nest PPPoE Manager running at http://0.0.0.0:' + PORT);
    console.log('   Local: http://localhost:' + PORT);
    try {
        var lanIp = execSync("ip -4 addr show | grep -oP 'inet \\K192\\.168\\.[\\d.]+' | head -1", { encoding: 'utf8' }).trim();
        if (lanIp) console.log('   LAN:   http://' + lanIp + ':' + PORT);
    } catch (err) { /* ignore */ }
    console.log('');

    // Auto-recover: restart 3proxy for active PPPoE sessions
    recoverProxies().then(function() {
        // Check auto_start config
        var { readConfig } = require('./lib/config');
        var config = readConfig();
        if (config.auto_start) {
            console.log('🟢 Auto Start is ON — starting all sessions...');
            // Trigger start-all via internal HTTP call
            var autoReq = http.request({
                hostname: '127.0.0.1',
                port: PORT,
                path: '/api/start-all',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-internal-secret': INTERNAL_SECRET
                }
            });
            autoReq.on('error', function(e) {
                console.error('   Auto-start request failed:', e.message);
            });
            autoReq.end();
        } else {
            console.log('⚪ Auto Start is OFF — sessions will not auto-start');
        }
    });
});

async function recoverProxies() {
    var { getTotalSessions, readConfig } = require('./lib/config');
    var { getSessionIP, setupProxy, connectPppoe, sleep } = require('./lib/pppoe');

    var config = readConfig();
    var total = getTotalSessions(config);
    var recovered = 0;
    var downSessions = [];

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
            if (!alreadyRunning) {
                try {
                    await setupProxy(i, ip);
                    recovered++;
                } catch (e) {
                    console.error('   ❌ ppp' + i + ' recovery failed:', e.message);
                }
            }
        } else {
            // Session is down — collect for auto-start
            downSessions.push(i);
        }
    }

    if (!alreadyRunning && recovered > 0) {
        console.log('✅ Recovered 3proxy for ' + recovered + '/' + total + ' sessions');
        io.emit('refresh');
    }

    // Log down sessions (health check will handle auto-starting if needed)
    if (downSessions.length > 0) {
        console.log('ℹ️  ' + downSessions.length + ' sessions are down: ppp' + downSessions.join(', ppp'));
        console.log('   Health check will auto-start them if needed (after 30s delay)');
    }
}
