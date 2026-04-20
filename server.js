const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { execSync } = require('child_process');
const path = require('path');

const { getPPPoEStatus, getSystemStats } = require('./lib/status');
const registerRoutes = require('./lib/routes');
const setupTerminal = require('./lib/terminal');
const rotationQueue = require('./lib/rotation');

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
    recoverProxies();
});

async function recoverProxies() {
    var { getTotalSessions, readConfig } = require('./lib/config');
    var { getSessionIP, setupProxy, sleep } = require('./lib/pppoe');

    var config = readConfig();
    var total = getTotalSessions(config);
    var recovered = 0;

    // Check if any 3proxy is already running
    try {
        var proxyCount = execSync('pgrep -c 3proxy 2>/dev/null || echo 0', { encoding: 'utf8' }).trim();
        if (parseInt(proxyCount) > 0) {
            console.log('✅ 3proxy already running (' + proxyCount + ' processes), skip recovery');
            return;
        }
    } catch (e) { /* ignore */ }

    console.log('🔄 Auto-recovering 3proxy for active sessions...');

    for (var i = 0; i < total; i++) {
        var iface = 'ppp' + i;
        var ip = await getSessionIP(iface);
        if (ip) {
            try {
                await setupProxy(i, ip);
                recovered++;
            } catch (e) {
                console.error('   ❌ ppp' + i + ' recovery failed:', e.message);
            }
        }
    }

    if (recovered > 0) {
        console.log('✅ Recovered 3proxy for ' + recovered + '/' + total + ' sessions');
        io.emit('refresh');
    } else {
        console.log('ℹ️  No active PPPoE sessions to recover');
    }
}
