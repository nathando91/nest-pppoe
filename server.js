const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { execSync } = require('child_process');
const path = require('path');

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
                headers: { 'Content-Type': 'application/json' }
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
