const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const pty = require('node-pty');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

const PORT = 3000;
const BASE_DIR = '/root/nest';
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const PROXIES_FILE = path.join(BASE_DIR, 'proxies.txt');
const PROXY_DIR = path.join(BASE_DIR, 'proxy');
const LOG_DIR = path.join(BASE_DIR, 'logs');

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

// Start single PPPoE session
app.post('/api/session/:id/start', function(req, res) {
    var id = parseInt(req.params.id);
    res.json({ success: true, message: 'Starting ppp' + id + '...' });

    var script = [
        'PEER="nest_ppp' + id + '"',
        'IFACE="ppp' + id + '"',
        'pppd call "$PEER" &',
        'GOT_IP=""',
        'for w in $(seq 1 15); do',
        '    IP=$(ip -4 addr show "$IFACE" 2>/dev/null | grep -oP "inet \\K[\\d.]+")',
        '    if [ -n "$IP" ]; then',
        '        GOT_IP="$IP"',
        '        break',
        '    fi',
        '    sleep 1',
        'done',
        'if [ -n "$GOT_IP" ]; then',
        '    PORT=$(shuf -i 10000-60000 -n 1)',
        '    TABLE=$((100 + ' + id + '))',
        '    ip route replace default dev "$IFACE" table "$TABLE" 2>/dev/null',
        '    ip rule del from "$GOT_IP" 2>/dev/null || true',
        '    ip rule add from "$GOT_IP" table "$TABLE"',
        '    cat > "' + PROXY_DIR + '/3proxy_ppp' + id + '_active.cfg" << CFGEOF',
        'nserver 8.8.8.8',
        'nserver 8.8.4.4',
        'log ' + LOG_DIR + '/3proxy_ppp' + id + '.log D',
        'logformat "L%t %N:%p %E %C:%c %R:%r %O %I %h %T"',
        'timeouts 1 5 30 60 180 1800 15 60',
        'auth none',
        'allow *',
        'external $GOT_IP',
        'proxy -p$PORT -i0.0.0.0 -e$GOT_IP',
        'CFGEOF',
        '    3proxy "' + PROXY_DIR + '/3proxy_ppp' + id + '_active.cfg" &',
        '    LINE=$((' + id + ' + 1))',
        '    sed -i "${LINE}s/.*/${GOT_IP}:${PORT}/" "' + PROXIES_FILE + '" 2>/dev/null || echo "${GOT_IP}:${PORT}" >> "' + PROXIES_FILE + '"',
        '    echo "OK $GOT_IP:$PORT"',
        'else',
        '    echo "FAIL no IP"',
        'fi'
    ].join('\n');

    var child = spawn('bash', ['-c', script], { cwd: BASE_DIR });
    var output = '';
    child.stdout.on('data', function(d) { output += d.toString(); });
    child.stderr.on('data', function(d) { output += d.toString(); });
    child.on('close', function() {
        io.emit('session_update', { id: id, output: output });
        io.emit('refresh');
    });
});

// Stop single PPPoE session
app.post('/api/session/:id/stop', function(req, res) {
    var id = parseInt(req.params.id);
    res.json({ success: true, message: 'Stopping ppp' + id + '...' });

    var script = [
        'RUNTIME_CFG="' + PROXY_DIR + '/3proxy_ppp' + id + '_active.cfg"',
        'PORT=$(grep -oP "proxy -p\\K\\d+" "$RUNTIME_CFG" 2>/dev/null || echo "")',
        'if [ -n "$PORT" ]; then',
        '    PID=$(lsof -ti :$PORT 2>/dev/null || echo "")',
        '    [ -n "$PID" ] && kill $PID 2>/dev/null || true',
        'fi',
        'rm -f "$RUNTIME_CFG"',
        'PPPD_PID=$(cat "/var/run/ppp' + id + '.pid" 2>/dev/null || echo "")',
        'if [ -n "$PPPD_PID" ]; then',
        '    kill "$PPPD_PID" 2>/dev/null || true',
        '    sleep 2',
        '    kill -9 "$PPPD_PID" 2>/dev/null || true',
        'fi',
        'echo "Stopped ppp' + id + '"'
    ].join('\n');

    var child = spawn('bash', ['-c', script], { cwd: BASE_DIR });
    var output = '';
    child.stdout.on('data', function(d) { output += d.toString(); });
    child.stderr.on('data', function(d) { output += d.toString(); });
    child.on('close', function() {
        io.emit('session_update', { id: id, output: output });
        io.emit('refresh');
    });
});

// Rotate single PPPoE session
app.post('/api/session/:id/rotate', function(req, res) {
    var id = parseInt(req.params.id);
    res.json({ success: true, message: 'Rotating ppp' + id + '...' });

    var child = spawn('bash', [path.join(BASE_DIR, 'rotate_ip.sh'), id.toString()], {
        cwd: BASE_DIR,
        env: Object.assign({}, process.env, { PATH: process.env.PATH })
    });
    var output = '';
    child.stdout.on('data', function(d) {
        output += d.toString();
        io.emit('rotate_log', { id: id, data: d.toString() });
    });
    child.stderr.on('data', function(d) {
        output += d.toString();
        io.emit('rotate_log', { id: id, data: d.toString() });
    });
    child.on('close', function(code) {
        io.emit('session_update', { id: id, output: output, code: code });
        io.emit('refresh');
    });
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
