const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');
const { promisify } = require('util');
const execAsync = promisify(exec);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = 3000;
const BASE_DIR = '/root/nest';
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const PROXIES_FILE = path.join(BASE_DIR, 'proxies.txt');
const PROXY_DIR = path.join(BASE_DIR, 'proxy');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const INTERFACE = 'enp1s0f0';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============ HELPERS ============

function readConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    } catch (e) {
        return { device_code: '', pppoe: [] };
    }
}

function writeConfig(config) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 4));
}

function getNetworkInterfaces() {
    try {
        const output = execSync(
            "ip -o link show | grep -v 'lo\\|docker\\|veth\\|br-\\|macppp\\|ppp' | awk '{print $2}' | sed 's/://' | sed 's/@.*//'",
            { encoding: 'utf8' }
        ).trim();
        const ifaces = output.split('\n').filter(Boolean);
        return ifaces.map(name => {
            try {
                const mac = execSync(`cat /sys/class/net/${name}/address 2>/dev/null || echo "N/A"`, { encoding: 'utf8' }).trim();
                const state = execSync(`cat /sys/class/net/${name}/operstate 2>/dev/null || echo "unknown"`, { encoding: 'utf8' }).trim();
                const ip = execSync(`ip -4 addr show ${name} 2>/dev/null | grep -oP 'inet \\K[\\d.]+' || echo ""`, { encoding: 'utf8' }).trim();
                return { name, mac, state, ip };
            } catch (err) {
                return { name, mac: 'N/A', state: 'unknown', ip: '' };
            }
        });
    } catch (err) {
        return [];
    }
}

function getPPPoEStatus() {
    const sessions = [];
    const config = readConfig();
    const numAccounts = config.pppoe ? config.pppoe.length : 0;
    const totalSessions = numAccounts * 30;

    // Read proxies.txt for port mapping
    let proxyLines = [];
    try {
        proxyLines = fs.readFileSync(PROXIES_FILE, 'utf8').trim().split('\n').filter(Boolean);
    } catch (err) { /* ignore */ }

    for (let i = 0; i < totalSessions; i++) {
        const iface = 'ppp' + i;
        const accountIdx = Math.floor(i / 30);
        const account = config.pppoe[accountIdx] || {};

        let ip = '';
        let status = 'stopped';
        let port = '';
        let proxyStatus = 'stopped';

        // Check if ppp interface exists and has IP
        try {
            ip = execSync("ip -4 addr show " + iface + " 2>/dev/null | grep -oP 'inet \\K[\\d.]+'", { encoding: 'utf8' }).trim();
            if (ip) status = 'connected';
        } catch (err) {
            status = 'stopped';
        }

        // Check proxy from proxies.txt
        if (proxyLines[i]) {
            const parts = proxyLines[i].split(':');
            if (parts.length >= 2) {
                port = parts[parts.length - 1];
            }
        }

        // Check if 3proxy is running for this session
        if (port) {
            try {
                const check = execSync('ss -tlnH "sport = :' + port + '" 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
                if (check) proxyStatus = 'running';
            } catch (err) { /* ignore */ }
        }

        // Get macvlan info
        let macvlan = i === 0 ? 'enp1s0f0' : 'macppp' + i;
        let macvlanStatus = 'unknown';
        try {
            const macState = execSync('cat /sys/class/net/' + macvlan + '/operstate 2>/dev/null || echo "down"', { encoding: 'utf8' }).trim();
            macvlanStatus = macState;
        } catch (err) {
            macvlanStatus = 'down';
        }

        sessions.push({
            id: i,
            iface: iface,
            username: account.username || 'N/A',
            ip: ip,
            port: port,
            status: status,
            proxyStatus: proxyStatus,
            macvlan: macvlan,
            macvlanStatus: macvlanStatus,
            accountIdx: accountIdx
        });
    }

    return sessions;
}

function getSystemStats() {
    let pppdCount = 0, proxyCount = 0;
    try { pppdCount = parseInt(execSync('pgrep -c pppd 2>/dev/null || echo 0', { encoding: 'utf8' }).trim()); } catch (err) { /* ignore */ }
    try { proxyCount = parseInt(execSync('pgrep -c 3proxy 2>/dev/null || echo 0', { encoding: 'utf8' }).trim()); } catch (err) { /* ignore */ }

    return {
        pppdCount: pppdCount,
        proxyCount: proxyCount,
        uptime: os.uptime(),
        loadAvg: os.loadavg(),
        totalMem: os.totalmem(),
        freeMem: os.freemem()
    };
}

// ============ API ROUTES ============

// Get config
app.get('/api/config', function(req, res) {
    res.json(readConfig());
});

// Save config
app.post('/api/config', function(req, res) {
    try {
        writeConfig(req.body);
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Get network interfaces
app.get('/api/interfaces', function(req, res) {
    res.json(getNetworkInterfaces());
});

// Get all PPPoE session status
app.get('/api/sessions', function(req, res) {
    res.json(getPPPoEStatus());
});

// Get system stats
app.get('/api/stats', function(req, res) {
    res.json(getSystemStats());
});

// Run Install
app.post('/api/install', function(req, res) {
    res.json({ success: true, message: 'Installing...' });
    var child = spawn('bash', [path.join(BASE_DIR, 'install.sh')], {
        cwd: BASE_DIR,
        env: Object.assign({}, process.env, { PATH: process.env.PATH })
    });
    var output = '';
    child.stdout.on('data', function(data) {
        output += data.toString();
        io.emit('install_log', data.toString());
    });
    child.stderr.on('data', function(data) {
        output += data.toString();
        io.emit('install_log', data.toString());
    });
    child.on('close', function(code) {
        io.emit('install_complete', { code: code, output: output });
        io.emit('refresh');
    });
});

// Start All
app.post('/api/start-all', function(req, res) {
    res.json({ success: true, message: 'Starting all sessions...' });
    var child = spawn('bash', [path.join(BASE_DIR, 'start_all.sh')], {
        cwd: BASE_DIR,
        env: Object.assign({}, process.env, { PATH: process.env.PATH })
    });
    var output = '';
    child.stdout.on('data', function(data) {
        output += data.toString();
        io.emit('start_log', data.toString());
    });
    child.stderr.on('data', function(data) {
        output += data.toString();
        io.emit('start_log', data.toString());
    });
    child.on('close', function(code) {
        io.emit('start_complete', { code: code, output: output });
        io.emit('refresh');
    });
});

// Stop All
app.post('/api/stop-all', function(req, res) {
    res.json({ success: true, message: 'Stopping all sessions...' });
    var child = spawn('bash', [path.join(BASE_DIR, 'stop_all.sh')], {
        cwd: BASE_DIR,
        env: Object.assign({}, process.env, { PATH: process.env.PATH })
    });
    var output = '';
    child.stdout.on('data', function(data) {
        output += data.toString();
        io.emit('stop_log', data.toString());
    });
    child.stderr.on('data', function(data) {
        output += data.toString();
        io.emit('stop_log', data.toString());
    });
    child.on('close', function(code) {
        io.emit('stop_complete', { code: code, output: output });
        io.emit('refresh');
    });
});

// ============ NATIVE PPPoE HELPERS ============

function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

function shellExec(cmd) {
    return execAsync(cmd, { encoding: 'utf8', timeout: 30000 }).then(
        function(result) { return result.stdout.trim(); },
        function() { return ''; }
    );
}

function getSessionIP(iface) {
    return shellExec("ip -4 addr show " + iface + " 2>/dev/null | grep -oP 'inet \\K[\\d.]+'");
}

function getProxyPort(id) {
    var cfgFile = path.join(PROXY_DIR, '3proxy_ppp' + id + '_active.cfg');
    try {
        var content = fs.readFileSync(cfgFile, 'utf8');
        var match = content.match(/proxy -p(\d+)/);
        return match ? match[1] : '';
    } catch (e) {
        return '';
    }
}

function randomPort() {
    return Math.floor(Math.random() * 50001) + 10000; // 10000-60000
}

async function findFreePort() {
    for (var attempt = 0; attempt < 20; attempt++) {
        var port = randomPort();
        var inUse = await shellExec('ss -tlnH "sport = :' + port + '" 2>/dev/null | head -1');
        if (!inUse) return port;
    }
    return randomPort(); // fallback
}

async function killProxy(id) {
    var port = getProxyPort(id);
    if (port) {
        var pid = await shellExec('lsof -ti :' + port + ' 2>/dev/null');
        if (pid) {
            await shellExec('kill ' + pid + ' 2>/dev/null');
        }
    }
}

async function killPppd(id) {
    var pidFile = '/var/run/ppp' + id + '.pid';
    try {
        var pid = fs.readFileSync(pidFile, 'utf8').trim();
        if (pid) {
            await shellExec('kill ' + pid + ' 2>/dev/null');
            // Wait for process to die
            for (var i = 0; i < 5; i++) {
                var alive = await shellExec('kill -0 ' + pid + ' 2>/dev/null && echo alive');
                if (!alive) break;
                await sleep(1000);
            }
            await shellExec('kill -9 ' + pid + ' 2>/dev/null');
        }
    } catch (e) { /* no pid file */ }
    // Wait for interface to go down
    var iface = 'ppp' + id;
    for (var w = 0; w < 5; w++) {
        var exists = await shellExec('ip link show ' + iface + ' 2>/dev/null');
        if (!exists) break;
        await sleep(1000);
    }
}

async function rebuildMacvlan(id) {
    if (id > 0) {
        var macvlan = 'macppp' + id;
        var mac = '02:' +
            ('0' + (Math.floor(Math.random() * 256)).toString(16)).slice(-2) + ':' +
            ('0' + (Math.floor(Math.random() * 256)).toString(16)).slice(-2) + ':' +
            ('0' + (Math.floor(Math.random() * 256)).toString(16)).slice(-2) + ':' +
            ('0' + (Math.floor(Math.random() * 256)).toString(16)).slice(-2) + ':' +
            ('0' + (Math.floor(Math.random() * 256)).toString(16)).slice(-2);
        await shellExec('ip link set ' + macvlan + ' down 2>/dev/null');
        await shellExec('ip link del ' + macvlan + ' 2>/dev/null');
        await shellExec('ip link add link ' + INTERFACE + ' ' + macvlan + ' type macvlan mode bridge');
        await shellExec('ip link set ' + macvlan + ' address ' + mac);
        await shellExec('ip link set ' + macvlan + ' up');
        await sleep(1000);
        return mac;
    } else {
        await sleep(8000);
        return null;
    }
}

async function connectPppoe(id) {
    var peer = 'nest_ppp' + id;
    var iface = 'ppp' + id;
    spawn('pppd', ['call', peer], { detached: true, stdio: 'ignore' }).unref();
    for (var w = 0; w < 20; w++) {
        var ip = await getSessionIP(iface);
        if (ip) return ip;
        await sleep(1000);
    }
    return '';
}

async function setupProxy(id, ip) {
    var iface = 'ppp' + id;
    var table = 100 + id;
    var cfgFile = path.join(PROXY_DIR, '3proxy_ppp' + id + '_active.cfg');
    var lineNum = id + 1;

    // Policy routing
    await shellExec('ip route replace default dev ' + iface + ' table ' + table + ' 2>/dev/null');
    await shellExec('ip rule del from ' + ip + ' 2>/dev/null');
    await shellExec('ip rule add from ' + ip + ' table ' + table);

    // Find free port
    var port = await findFreePort();

    // Write 3proxy config
    var cfg = [
        '# 3proxy runtime config for ppp' + id,
        '# IP: ' + ip + ' Port: ' + port,
        '',
        'nserver 8.8.8.8',
        'nserver 8.8.4.4',
        '',
        'log ' + LOG_DIR + '/3proxy_ppp' + id + '.log D',
        'logformat "L%t %N:%p %E %C:%c %R:%r %O %I %h %T"',
        '',
        'timeouts 1 5 30 60 180 1800 15 60',
        '',
        'auth none',
        'allow *',
        '',
        'external ' + ip,
        'proxy -p' + port + ' -i0.0.0.0 -e' + ip
    ].join('\n');
    fs.writeFileSync(cfgFile, cfg);

    // Start 3proxy
    spawn('3proxy', [cfgFile], { detached: true, stdio: 'ignore' }).unref();

    // Update proxies.txt
    try {
        var lines = fs.readFileSync(PROXIES_FILE, 'utf8').split('\n');
        while (lines.length < lineNum) lines.push('');
        lines[lineNum - 1] = ip + ':' + port;
        fs.writeFileSync(PROXIES_FILE, lines.join('\n'));
    } catch (e) {
        fs.appendFileSync(PROXIES_FILE, ip + ':' + port + '\n');
    }

    return port;
}

// Emit real-time session state to the UI
function emitSessionState(id, updates) {
    // Fetch current session data and merge with updates
    var iface = 'ppp' + id;
    var session = {
        id: id,
        iface: iface,
        ip: updates.ip || '',
        port: updates.port || '',
        status: updates.status || 'stopped',
        proxyStatus: updates.proxyStatus || 'stopped',
        step: updates.step || '',
        message: updates.message || ''
    };
    io.emit('session_live_update', session);
}

// ============ NATIVE SESSION ENDPOINTS ============

// Start single PPPoE session
app.post('/api/session/:id/start', function(req, res) {
    var id = parseInt(req.params.id);
    res.json({ success: true, message: 'Starting ppp' + id + '...' });

    (async function() {
        var iface = 'ppp' + id;
        try {
            emitSessionState(id, { status: 'connecting', step: 'starting', message: 'Đang kết nối PPPoE...' });
            io.emit('rotate_log', { id: id, data: '▶ Khởi động ' + iface + '...\n' });

            var ip = await connectPppoe(id);
            if (!ip) {
                emitSessionState(id, { status: 'stopped', step: 'failed', message: 'Không nhận được IP' });
                io.emit('rotate_log', { id: id, data: '❌ ' + iface + ' không nhận được IP\n' });
                io.emit('session_update', { id: id, output: 'FAIL no IP', code: 1 });
                return;
            }

            emitSessionState(id, { ip: ip, status: 'connected', step: 'proxy', message: 'Đang cấu hình proxy...' });
            io.emit('rotate_log', { id: id, data: '   IP: ' + ip + '\n' });

            var port = await setupProxy(id, ip);

            emitSessionState(id, { ip: ip, port: String(port), status: 'connected', proxyStatus: 'running', step: 'done', message: 'Hoàn tất' });
            io.emit('rotate_log', { id: id, data: '✅ ' + iface + ' → ' + ip + ':' + port + '\n' });
            io.emit('session_update', { id: id, output: 'OK ' + ip + ':' + port, code: 0 });
        } catch (err) {
            io.emit('rotate_log', { id: id, data: '❌ Lỗi: ' + err.message + '\n' });
            io.emit('session_update', { id: id, output: 'ERROR: ' + err.message, code: 1 });
        }
    })();
});

// Stop single PPPoE session
app.post('/api/session/:id/stop', function(req, res) {
    var id = parseInt(req.params.id);
    res.json({ success: true, message: 'Stopping ppp' + id + '...' });

    (async function() {
        try {
            emitSessionState(id, { status: 'stopping', step: 'proxy', message: 'Đang dừng proxy...' });
            io.emit('rotate_log', { id: id, data: '⏹ Đang dừng ppp' + id + '...\n' });

            await killProxy(id);
            var cfgFile = path.join(PROXY_DIR, '3proxy_ppp' + id + '_active.cfg');
            try { fs.unlinkSync(cfgFile); } catch (e) { /* ignore */ }

            emitSessionState(id, { status: 'stopping', step: 'pppd', message: 'Đang dừng PPPoE...' });
            await killPppd(id);

            emitSessionState(id, { status: 'stopped', step: 'done', message: 'Đã dừng' });
            io.emit('rotate_log', { id: id, data: '✅ Đã dừng ppp' + id + '\n' });
            io.emit('session_update', { id: id, output: 'Stopped ppp' + id, code: 0 });
        } catch (err) {
            io.emit('rotate_log', { id: id, data: '❌ Lỗi: ' + err.message + '\n' });
            io.emit('session_update', { id: id, output: 'ERROR: ' + err.message, code: 1 });
        }
    })();
});

// Rotate single PPPoE session
app.post('/api/session/:id/rotate', function(req, res) {
    var id = parseInt(req.params.id);
    res.json({ success: true, message: 'Rotating ppp' + id + '...' });

    (async function() {
        var iface = 'ppp' + id;
        try {
            // Get old IP
            var oldIp = await getSessionIP(iface);
            var oldPort = getProxyPort(id);

            io.emit('rotate_log', { id: id, data: '🔄 Xoay IP cho ' + iface + '\n' });
            if (oldIp) {
                io.emit('rotate_log', { id: id, data: '   IP cũ: ' + oldIp + ' (port ' + oldPort + ')\n' });
            } else {
                io.emit('rotate_log', { id: id, data: '   ⚠️ Session đã chết, khởi tạo lại...\n' });
            }
            emitSessionState(id, { ip: oldIp, port: oldPort, status: 'rotating', step: 'kill_proxy', message: 'Đang dừng proxy...' });

            // Kill old proxy
            await killProxy(id);

            // Step 1: Disconnect pppd (keep macvlan)
            emitSessionState(id, { ip: '', port: '', status: 'rotating', step: 'disconnect', message: 'Đang ngắt kết nối...' });
            io.emit('rotate_log', { id: id, data: '   Disconnect pppd...\n' });
            await killPppd(id);
            await sleep(2000);

            // Step 2: Reconnect
            emitSessionState(id, { ip: '', port: '', status: 'rotating', step: 'reconnect', message: 'Đang kết nối lại...' });
            io.emit('rotate_log', { id: id, data: '   Reconnect...\n' });
            var newIp = await connectPppoe(id);

            // If no IP, try rebuilding macvlan
            if (!newIp) {
                emitSessionState(id, { status: 'rotating', step: 'rebuild_macvlan', message: 'Tạo lại macvlan...' });
                io.emit('rotate_log', { id: id, data: '   ⚠️ Không nhận được IP, thử tạo lại macvlan...\n' });
                var mac = await rebuildMacvlan(id);
                if (mac) io.emit('rotate_log', { id: id, data: '   Tạo lại macvlan (MAC: ' + mac + ')\n' });
                newIp = await connectPppoe(id);
            }

            if (!newIp) {
                emitSessionState(id, { status: 'stopped', step: 'failed', message: 'Không nhận được IP' });
                io.emit('rotate_log', { id: id, data: '❌ ' + iface + ' không nhận được IP\n' });
                io.emit('session_update', { id: id, output: 'FAIL no IP', code: 1 });
                return;
            }

            // Step 3: If same IP, rebuild macvlan and retry
            if (oldIp && newIp === oldIp) {
                emitSessionState(id, { ip: newIp, status: 'rotating', step: 'same_ip_rebuild', message: 'IP trùng, tạo lại macvlan...' });
                io.emit('rotate_log', { id: id, data: '   ⚠️ Vẫn IP cũ (' + newIp + '), huỷ macvlan tạo lại...\n' });
                await killPppd(id);
                var mac = await rebuildMacvlan(id);
                if (mac) io.emit('rotate_log', { id: id, data: '   Tạo lại macvlan (MAC: ' + mac + ')\n' });

                emitSessionState(id, { ip: '', status: 'rotating', step: 'reconnect2', message: 'Đang kết nối lại (lần 2)...' });
                newIp = await connectPppoe(id);
                if (!newIp) {
                    emitSessionState(id, { status: 'stopped', step: 'failed', message: 'Không nhận được IP sau khi tạo lại macvlan' });
                    io.emit('rotate_log', { id: id, data: '❌ ' + iface + ' không nhận được IP sau khi tạo lại macvlan\n' });
                    io.emit('session_update', { id: id, output: 'FAIL no IP after macvlan rebuild', code: 1 });
                    return;
                }
            }

            // Step 4: Setup proxy
            emitSessionState(id, { ip: newIp, status: 'connected', step: 'proxy', message: 'Đang cấu hình proxy...' });
            io.emit('rotate_log', { id: id, data: '   IP mới: ' + newIp + '\n' });
            var newPort = await setupProxy(id, newIp);

            // Done!
            emitSessionState(id, { ip: newIp, port: String(newPort), status: 'connected', proxyStatus: 'running', step: 'done', message: 'Hoàn tất' });

            if (oldIp && newIp !== oldIp) {
                io.emit('rotate_log', { id: id, data: '✅ Đổi IP thành công: ' + oldIp + ' → ' + newIp + ' (port ' + newPort + ')\n' });
            } else if (!oldIp) {
                io.emit('rotate_log', { id: id, data: '✅ Khôi phục session: ' + newIp + ' (port ' + newPort + ')\n' });
            } else {
                io.emit('rotate_log', { id: id, data: '⚠️ IP không đổi: ' + newIp + ' (port ' + newPort + ')\n' });
            }

            io.emit('session_update', { id: id, output: 'OK ' + newIp + ':' + newPort, code: 0 });
        } catch (err) {
            emitSessionState(id, { status: 'stopped', step: 'error', message: 'Lỗi: ' + err.message });
            io.emit('rotate_log', { id: id, data: '❌ Lỗi: ' + err.message + '\n' });
            io.emit('session_update', { id: id, output: 'ERROR: ' + err.message, code: 1 });
        }
    })();
});

// ============ SOCKET.IO ============

io.on('connection', function(socket) {
    console.log('Client connected');

    // ---- Interactive Terminal (PTY) ----
    var term = null;

    socket.on('terminal_open', function(data) {
        if (term) {
            term.kill();
        }
        var cols = (data && data.cols) || 120;
        var rows = (data && data.rows) || 30;
        term = pty.spawn('bash', [], {
            name: 'xterm-256color',
            cols: cols,
            rows: rows,
            cwd: BASE_DIR,
            env: Object.assign({}, process.env, {
                TERM: 'xterm-256color',
                COLORTERM: 'truecolor'
            })
        });

        term.onData(function(data) {
            socket.emit('terminal_output', data);
        });

        term.onExit(function(ev) {
            socket.emit('terminal_exit', { code: ev.exitCode });
            term = null;
        });

        console.log('PTY spawned (pid ' + term.pid + ')');
    });

    socket.on('terminal_input', function(data) {
        if (term) {
            term.write(data);
        }
    });

    socket.on('terminal_resize', function(data) {
        if (term && data && data.cols && data.rows) {
            try {
                term.resize(data.cols, data.rows);
            } catch (e) { /* ignore resize errors */ }
        }
    });

    socket.on('disconnect', function() {
        console.log('Client disconnected');
        if (term) {
            term.kill();
            term = null;
        }
    });
});

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
});
