const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { readConfig, writeConfig, BASE_DIR, PROXY_DIR, PROXIES_FILE } = require('./config');
const { getNetworkInterfaces, getPPPoEStatus, getSystemStats } = require('./status');
const { connectPppoe, setupProxy, killProxy, killPppd, rebuildMacvlan, getSessionIP, getProxyPort, sleep, shellExec } = require('./pppoe');

// Emit real-time session state to the UI
function emitSessionState(io, id, updates) {
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

function registerRoutes(app, io) {

    // ============ CONFIG ============

    app.get('/api/config', function(req, res) {
        res.json(readConfig());
    });

    app.post('/api/config', function(req, res) {
        try {
            writeConfig(req.body);
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ============ STATUS ============

    app.get('/api/interfaces', function(req, res) {
        res.json(getNetworkInterfaces());
    });

    app.get('/api/sessions', function(req, res) {
        res.json(getPPPoEStatus());
    });

    app.get('/api/stats', function(req, res) {
        res.json(getSystemStats());
    });

    // ============ BULK ACTIONS ============

    // Install still uses shell script (system-level setup: macvlan, peer files, credentials)
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

    // ============ STOP ALL (native) ============

    app.post('/api/stop-all', function(req, res) {
        res.json({ success: true, message: 'Stopping all sessions...' });

        (async function() {
            try {
                var config = readConfig();
                var numAccounts = config.pppoe ? config.pppoe.length : 0;
                var totalSessions = numAccounts * 30;

                io.emit('stop_log', '[*] Stopping 3proxy...\n');

                // Kill all 3proxy processes
                await shellExec('pkill -f "3proxy.*3proxy_ppp" 2>/dev/null');
                await shellExec('pkill 3proxy 2>/dev/null');
                // Kill legacy processes
                await shellExec('pkill -f log_proxy.py 2>/dev/null');
                await shellExec('pkill tinyproxy 2>/dev/null');

                io.emit('stop_log', '[*] Stopping pppd...\n');

                // Kill all pppd processes
                await shellExec('pkill pppd 2>/dev/null');
                await sleep(2000);

                // Remove runtime configs
                await shellExec('rm -f ' + PROXY_DIR + '/3proxy_ppp*_active.cfg 2>/dev/null');

                // Force kill remaining
                var pppdLeft = await shellExec('pgrep -c pppd 2>/dev/null || echo 0');
                var proxyLeft = await shellExec('pgrep -c 3proxy 2>/dev/null || echo 0');

                if (parseInt(pppdLeft) > 0 || parseInt(proxyLeft) > 0) {
                    io.emit('stop_log', '[*] Force killing...\n');
                    await shellExec('pkill -9 pppd 2>/dev/null');
                    await shellExec('pkill -9 3proxy 2>/dev/null');
                    await shellExec('pkill -9 -f log_proxy.py 2>/dev/null');
                    await sleep(1000);
                }

                // Update all session cards to stopped
                for (var i = 0; i < totalSessions; i++) {
                    emitSessionState(io, i, { status: 'stopped', step: 'done', message: '' });
                }

                var finalPppd = await shellExec('pgrep -c pppd 2>/dev/null || echo 0');
                var finalProxy = await shellExec('pgrep -c 3proxy 2>/dev/null || echo 0');
                io.emit('stop_log', '[✓] All stopped (pppd: ' + finalPppd + ', 3proxy: ' + finalProxy + ')\n');

                io.emit('stop_complete', { code: 0, output: 'All stopped' });
                io.emit('refresh');
            } catch (err) {
                io.emit('stop_log', '❌ Lỗi: ' + err.message + '\n');
                io.emit('stop_complete', { code: 1, output: 'ERROR: ' + err.message });
            }
        })();
    });

    // ============ START ALL (native) ============

    app.post('/api/start-all', function(req, res) {
        res.json({ success: true, message: 'Starting all sessions...' });

        (async function() {
            try {
                var config = readConfig();
                var numAccounts = config.pppoe ? config.pppoe.length : 0;
                var totalSessions = numAccounts * 30;

                io.emit('start_log', '============================================\n');
                io.emit('start_log', '  START - ' + totalSessions + ' PPPoE + 3proxy\n');
                io.emit('start_log', '============================================\n\n');

                // --- Cleanup ---
                io.emit('start_log', '[*] Dừng các phiên cũ...\n');
                await shellExec('pkill -f "3proxy.*3proxy_ppp" 2>/dev/null');
                await shellExec('pkill -f log_proxy.py 2>/dev/null');
                await shellExec('pkill tinyproxy 2>/dev/null');
                await shellExec('pkill pppd 2>/dev/null');
                await sleep(3000);

                // Clean ip rules
                for (var t = 100; t < 100 + totalSessions; t++) {
                    await shellExec('ip route flush table ' + t + ' 2>/dev/null');
                }
                var rules = await shellExec("ip rule show | grep -oP 'from \\S+ lookup \\d+'");
                if (rules) {
                    var ruleLines = rules.split('\n').filter(Boolean);
                    for (var r = 0; r < ruleLines.length; r++) {
                        await shellExec('ip rule del ' + ruleLines[r] + ' 2>/dev/null');
                    }
                }

                // Reset proxies file
                fs.writeFileSync(PROXIES_FILE, '');

                // Mark all sessions as stopped initially
                for (var s = 0; s < totalSessions; s++) {
                    emitSessionState(io, s, { status: 'stopped', step: '', message: '' });
                }

                // --- Start PPPoE sequentially ---
                io.emit('start_log', '[*] Khởi động PPPoE tuần tự...\n\n');

                var connected = 0;
                var proxyLines = [];

                for (var i = 0; i < totalSessions; i++) {
                    var iface = 'ppp' + i;

                    emitSessionState(io, i, { status: 'connecting', step: 'starting', message: 'Đang kết nối...' });

                    var ip = await connectPppoe(i);

                    if (ip) {
                        emitSessionState(io, i, { ip: ip, status: 'connected', step: 'proxy', message: 'Đang cấu hình proxy...' });

                        var port = await setupProxy(i, ip);

                        emitSessionState(io, i, { ip: ip, port: String(port), status: 'connected', proxyStatus: 'running', step: 'done', message: '' });
                        io.emit('start_log', '  ✅ ' + iface + '  ' + ip + ' → :' + port + '\n');

                        proxyLines.push(ip + ':' + port);
                        connected++;
                    } else {
                        emitSessionState(io, i, { status: 'stopped', step: 'failed', message: 'Không nhận được IP' });
                        io.emit('start_log', '  ❌ ' + iface + '  no IP (timeout)\n');
                        proxyLines.push('');
                    }

                    // Delay between sessions
                    if (i < totalSessions - 1) {
                        await sleep(2000);
                    }
                }

                // Write final proxies.txt
                fs.writeFileSync(PROXIES_FILE, proxyLines.join('\n') + '\n');

                await sleep(1000);

                // Summary
                var proxyCount = await shellExec('pgrep -c 3proxy 2>/dev/null || echo 0');
                io.emit('start_log', '\n============================================\n');
                io.emit('start_log', '  PPPoE connected: ' + connected + '/' + totalSessions + '\n');
                io.emit('start_log', '  3proxy running:  ' + proxyCount + '\n');
                io.emit('start_log', '============================================\n');

                io.emit('start_complete', { code: 0, output: connected + '/' + totalSessions + ' connected' });
                io.emit('refresh');
            } catch (err) {
                io.emit('start_log', '❌ Lỗi: ' + err.message + '\n');
                io.emit('start_complete', { code: 1, output: 'ERROR: ' + err.message });
            }
        })();
    });

    // ============ SINGLE SESSION: START ============

    app.post('/api/session/:id/start', function(req, res) {
        var id = parseInt(req.params.id);
        res.json({ success: true, message: 'Starting ppp' + id + '...' });

        (async function() {
            var iface = 'ppp' + id;
            try {
                emitSessionState(io, id, { status: 'connecting', step: 'starting', message: 'Đang kết nối PPPoE...' });
                io.emit('rotate_log', { id: id, data: '▶ Khởi động ' + iface + '...\n' });

                var ip = await connectPppoe(id);
                if (!ip) {
                    emitSessionState(io, id, { status: 'stopped', step: 'failed', message: 'Không nhận được IP' });
                    io.emit('rotate_log', { id: id, data: '❌ ' + iface + ' không nhận được IP\n' });
                    io.emit('session_update', { id: id, output: 'FAIL no IP', code: 1 });
                    return;
                }

                emitSessionState(io, id, { ip: ip, status: 'connected', step: 'proxy', message: 'Đang cấu hình proxy...' });
                io.emit('rotate_log', { id: id, data: '   IP: ' + ip + '\n' });

                var port = await setupProxy(id, ip);

                emitSessionState(io, id, { ip: ip, port: String(port), status: 'connected', proxyStatus: 'running', step: 'done', message: 'Hoàn tất' });
                io.emit('rotate_log', { id: id, data: '✅ ' + iface + ' → ' + ip + ':' + port + '\n' });
                io.emit('session_update', { id: id, output: 'OK ' + ip + ':' + port, code: 0 });
            } catch (err) {
                io.emit('rotate_log', { id: id, data: '❌ Lỗi: ' + err.message + '\n' });
                io.emit('session_update', { id: id, output: 'ERROR: ' + err.message, code: 1 });
            }
        })();
    });

    // ============ SINGLE SESSION: STOP ============

    app.post('/api/session/:id/stop', function(req, res) {
        var id = parseInt(req.params.id);
        res.json({ success: true, message: 'Stopping ppp' + id + '...' });

        (async function() {
            try {
                emitSessionState(io, id, { status: 'stopping', step: 'proxy', message: 'Đang dừng proxy...' });
                io.emit('rotate_log', { id: id, data: '⏹ Đang dừng ppp' + id + '...\n' });

                await killProxy(id);
                var cfgFile = path.join(PROXY_DIR, '3proxy_ppp' + id + '_active.cfg');
                try { fs.unlinkSync(cfgFile); } catch (e) { /* ignore */ }

                emitSessionState(io, id, { status: 'stopping', step: 'pppd', message: 'Đang dừng PPPoE...' });
                await killPppd(id);

                emitSessionState(io, id, { status: 'stopped', step: 'done', message: 'Đã dừng' });
                io.emit('rotate_log', { id: id, data: '✅ Đã dừng ppp' + id + '\n' });
                io.emit('session_update', { id: id, output: 'Stopped ppp' + id, code: 0 });
            } catch (err) {
                io.emit('rotate_log', { id: id, data: '❌ Lỗi: ' + err.message + '\n' });
                io.emit('session_update', { id: id, output: 'ERROR: ' + err.message, code: 1 });
            }
        })();
    });

    // ============ SINGLE SESSION: ROTATE ============

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
                emitSessionState(io, id, { ip: oldIp, port: oldPort, status: 'rotating', step: 'kill_proxy', message: 'Đang dừng proxy...' });

                // Kill old proxy
                await killProxy(id);

                // Step 1: Disconnect pppd (keep macvlan)
                emitSessionState(io, id, { ip: '', port: '', status: 'rotating', step: 'disconnect', message: 'Đang ngắt kết nối...' });
                io.emit('rotate_log', { id: id, data: '   Disconnect pppd...\n' });
                await killPppd(id);
                await sleep(2000);

                // Step 2: Reconnect
                emitSessionState(io, id, { ip: '', port: '', status: 'rotating', step: 'reconnect', message: 'Đang kết nối lại...' });
                io.emit('rotate_log', { id: id, data: '   Reconnect...\n' });
                var newIp = await connectPppoe(id);

                // If no IP, try rebuilding macvlan
                if (!newIp) {
                    emitSessionState(io, id, { status: 'rotating', step: 'rebuild_macvlan', message: 'Tạo lại macvlan...' });
                    io.emit('rotate_log', { id: id, data: '   ⚠️ Không nhận được IP, thử tạo lại macvlan...\n' });
                    var mac = await rebuildMacvlan(id);
                    if (mac) io.emit('rotate_log', { id: id, data: '   Tạo lại macvlan (MAC: ' + mac + ')\n' });
                    newIp = await connectPppoe(id);
                }

                if (!newIp) {
                    emitSessionState(io, id, { status: 'stopped', step: 'failed', message: 'Không nhận được IP' });
                    io.emit('rotate_log', { id: id, data: '❌ ' + iface + ' không nhận được IP\n' });
                    io.emit('session_update', { id: id, output: 'FAIL no IP', code: 1 });
                    return;
                }

                // Step 3: If same IP, rebuild macvlan and retry
                if (oldIp && newIp === oldIp) {
                    emitSessionState(io, id, { ip: newIp, status: 'rotating', step: 'same_ip_rebuild', message: 'IP trùng, tạo lại macvlan...' });
                    io.emit('rotate_log', { id: id, data: '   ⚠️ Vẫn IP cũ (' + newIp + '), huỷ macvlan tạo lại...\n' });
                    await killPppd(id);
                    var mac2 = await rebuildMacvlan(id);
                    if (mac2) io.emit('rotate_log', { id: id, data: '   Tạo lại macvlan (MAC: ' + mac2 + ')\n' });

                    emitSessionState(io, id, { ip: '', status: 'rotating', step: 'reconnect2', message: 'Đang kết nối lại (lần 2)...' });
                    newIp = await connectPppoe(id);
                    if (!newIp) {
                        emitSessionState(io, id, { status: 'stopped', step: 'failed', message: 'Không nhận được IP sau khi tạo lại macvlan' });
                        io.emit('rotate_log', { id: id, data: '❌ ' + iface + ' không nhận được IP sau khi tạo lại macvlan\n' });
                        io.emit('session_update', { id: id, output: 'FAIL no IP after macvlan rebuild', code: 1 });
                        return;
                    }
                }

                // Step 4: Setup proxy
                emitSessionState(io, id, { ip: newIp, status: 'connected', step: 'proxy', message: 'Đang cấu hình proxy...' });
                io.emit('rotate_log', { id: id, data: '   IP mới: ' + newIp + '\n' });
                var newPort = await setupProxy(id, newIp);

                // Done!
                emitSessionState(io, id, { ip: newIp, port: String(newPort), status: 'connected', proxyStatus: 'running', step: 'done', message: 'Hoàn tất' });

                if (oldIp && newIp !== oldIp) {
                    io.emit('rotate_log', { id: id, data: '✅ Đổi IP thành công: ' + oldIp + ' → ' + newIp + ' (port ' + newPort + ')\n' });
                } else if (!oldIp) {
                    io.emit('rotate_log', { id: id, data: '✅ Khôi phục session: ' + newIp + ' (port ' + newPort + ')\n' });
                } else {
                    io.emit('rotate_log', { id: id, data: '⚠️ IP không đổi: ' + newIp + ' (port ' + newPort + ')\n' });
                }

                io.emit('session_update', { id: id, output: 'OK ' + newIp + ':' + newPort, code: 0 });
            } catch (err) {
                emitSessionState(io, id, { status: 'stopped', step: 'error', message: 'Lỗi: ' + err.message });
                io.emit('rotate_log', { id: id, data: '❌ Lỗi: ' + err.message + '\n' });
                io.emit('session_update', { id: id, output: 'ERROR: ' + err.message, code: 1 });
            }
        })();
    });
}

module.exports = registerRoutes;
