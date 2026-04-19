const path = require('path');
const fs = require('fs');
const { readConfig, writeConfig, BASE_DIR, PROXY_DIR, PROXIES_FILE, IP_FILE, BLACKLIST_FILE, LOG_DIR, INTERFACE } = require('./config');
const { getNetworkInterfaces, getPPPoEStatus, getSystemStats } = require('./status');
const { connectPppoe, setupProxy, killProxy, killPppd, rebuildMacvlan, getSessionIP, getProxyPort, getProxyPorts, sleep, shellExec } = require('./pppoe');

// Emit real-time session state to the UI
function emitSessionState(io, id, updates) {
    var iface = 'ppp' + id;
    var session = {
        id: id,
        iface: iface,
        ip: updates.ip || '',
        vipPort: updates.vipPort || '',
        ports: updates.ports || [],
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

    // Install (native Node.js)
    app.post('/api/install', function(req, res) {
        res.json({ success: true, message: 'Installing...' });

        (async function() {
            try {
                var config = readConfig();
                var numAccounts = config.pppoe ? config.pppoe.length : 0;
                if (numAccounts === 0) {
                    io.emit('install_log', '❌ Chưa có account PPPoE nào trong config!\n');
                    io.emit('install_complete', { code: 1, output: 'No accounts' });
                    return;
                }

                var NUM = numAccounts * 30;
                var PEER_DIR = '/etc/ppp/peers';
                var username = config.pppoe[0].username;
                var password = config.pppoe[0].password;

                io.emit('install_log', '============================================\n');
                io.emit('install_log', '  INSTALL - ' + NUM + ' PPPoE Sessions + 3proxy\n');
                io.emit('install_log', '============================================\n\n');
                io.emit('install_log', '[*] Account: ' + username + '\n');
                io.emit('install_log', '[*] Interface: ' + INTERFACE + '\n\n');

                // --- 1. Create directories ---
                io.emit('install_log', '[1/5] Tạo thư mục...\n');
                await shellExec('mkdir -p "' + PROXY_DIR + '" "' + LOG_DIR + '" "' + PEER_DIR + '"');

                // --- 2. Configure credentials ---
                io.emit('install_log', '[2/5] Cấu hình credentials...\n');
                var credLine = '"' + username + '" * "' + password + '" *';
                var secretFiles = ['/etc/ppp/chap-secrets', '/etc/ppp/pap-secrets'];
                for (var sf = 0; sf < secretFiles.length; sf++) {
                    var secretFile = secretFiles[sf];
                    try {
                        var content = '';
                        try { content = fs.readFileSync(secretFile, 'utf8'); } catch (e) { /* new file */ }
                        // Remove old lines for this username
                        var lines = content.split('\n').filter(function(line) {
                            return line.indexOf(username) === -1;
                        });
                        lines.push(credLine);
                        fs.writeFileSync(secretFile, lines.join('\n') + '\n', { mode: 0o600 });
                    } catch (e) {
                        fs.writeFileSync(secretFile, credLine + '\n', { mode: 0o600 });
                    }
                }
                io.emit('install_log', '    ✅ chap-secrets & pap-secrets\n');

                // --- 3. Create macvlan interfaces ---
                io.emit('install_log', '[3/5] Tạo ' + NUM + ' macvlan interfaces...\n');
                // ppp0 uses enp1s0f0 directly, ppp1+ use macvlan
                for (var i = 1; i < NUM; i++) {
                    var macvlan = 'macppp' + i;
                    await shellExec('ip link del "' + macvlan + '" 2>/dev/null');
                    await shellExec('ip link add link "' + INTERFACE + '" "' + macvlan + '" type macvlan mode bridge');
                    var hexI = ('0' + Math.floor(i / 256).toString(16)).slice(-2) + ':' +
                               ('0' + (i % 256).toString(16)).slice(-2);
                    await shellExec('ip link set "' + macvlan + '" address "02:00:00:00:' + hexI + '"');
                    await shellExec('ip link set "' + macvlan + '" up');
                }
                io.emit('install_log', '    ✅ macppp1 - macppp' + (NUM - 1) + ' created\n');

                // --- 4. Create peer files ---
                io.emit('install_log', '[4/5] Tạo ' + NUM + ' peer files...\n');
                for (var p = 0; p < NUM; p++) {
                    var nic = p === 0 ? INTERFACE : 'macppp' + p;
                    var peerContent = [
                        'plugin pppoe.so',
                        'nic-' + nic,
                        'user "' + username + '"',
                        'unit ' + p,
                        'noipdefault',
                        'nodefaultroute',
                        'hide-password',
                        'noauth',
                        'persist',
                        'maxfail 5',
                        'holdoff 5',
                        'mtu 1492',
                        'mru 1492',
                        'lcp-echo-interval 20',
                        'lcp-echo-failure 3',
                        'usepeerdns'
                    ].join('\n') + '\n';
                    fs.writeFileSync(path.join(PEER_DIR, 'nest_ppp' + p), peerContent);
                }
                io.emit('install_log', '    ✅ nest_ppp0 - nest_ppp' + (NUM - 1) + '\n');

                // --- 5. Create 3proxy config templates ---
                io.emit('install_log', '[5/5] Tạo ' + NUM + ' 3proxy configs (template)...\n');
                var BASE_PORT = 8081;
                for (var c = 0; c < NUM; c++) {
                    var tplPort = BASE_PORT + c;
                    var tplContent = [
                        '# 3proxy config for ppp' + c,
                        '# __PPP_IP__ sẽ được thay thế khi start',
                        '',
                        'nserver 8.8.8.8',
                        'nserver 8.8.4.4',
                        '',
                        'log ' + LOG_DIR + '/3proxy_ppp' + c + '.log D',
                        'logformat "L%t %N:%p %E %C:%c %R:%r %O %I %h %T"',
                        '',
                        'timeouts 1 5 30 60 180 1800 15 60',
                        '',
                        'auth none',
                        'allow *',
                        '',
                        'external __PPP_IP__',
                        'proxy -p__PORT__ -i0.0.0.0 -e__PPP_IP__'
                    ].join('\n') + '\n';
                    fs.writeFileSync(path.join(PROXY_DIR, '3proxy_ppp' + c + '.cfg'), tplContent);
                }

                io.emit('install_log', '    ✅ 3proxy configs ppp0-ppp' + (NUM - 1) + '\n');

                io.emit('install_log', '\n============================================\n');
                io.emit('install_log', '  ✅ INSTALL COMPLETE\n');
                io.emit('install_log', '============================================\n');
                io.emit('install_log', '  Peer files : ' + PEER_DIR + '/nest_ppp{0..' + (NUM - 1) + '}\n');
                io.emit('install_log', '  Macvlan    : macppp{1..' + (NUM - 1) + '}\n');
                io.emit('install_log', '  3proxy conf: ' + PROXY_DIR + '/3proxy_ppp{0..' + (NUM - 1) + '}.cfg\n');
                io.emit('install_log', '============================================\n');

                io.emit('install_complete', { code: 0, output: 'Install complete' });
                io.emit('refresh');
            } catch (err) {
                io.emit('install_log', '❌ Lỗi: ' + err.message + '\n');
                io.emit('install_complete', { code: 1, output: 'ERROR: ' + err.message });
            }
        })();
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

                        var result = await setupProxy(i, ip);

                        // Register IP
                try { fs.appendFileSync(IP_FILE, ip + '|' + Date.now() + '\n'); } catch(e) {}

                        emitSessionState(io, i, { ip: ip, vipPort: String(result.vipPort), ports: result.ports.map(String), status: 'connected', proxyStatus: 'running', step: 'done', message: '' });
                        io.emit('start_log', '  ✅ ' + iface + '  ' + ip + ' → VIP:' + result.vipPort + ' (+' + (result.ports.length - 1) + ' ports)\n');

                        proxyLines.push(ip + ':' + result.ports.join(','));
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

                var result = await setupProxy(id, ip);

                // Register IP in IP.txt
                try { fs.appendFileSync(IP_FILE, ip + '|' + Date.now() + '\n'); } catch(e) {}

                emitSessionState(io, id, { ip: ip, vipPort: String(result.vipPort), ports: result.ports.map(String), status: 'connected', proxyStatus: 'running', step: 'done', message: 'Hoàn tất' });
                io.emit('rotate_log', { id: id, data: '✅ ' + iface + ' → ' + ip + ' VIP:' + result.vipPort + '\n' });
                io.emit('session_update', { id: id, output: 'OK ' + ip + ':' + result.vipPort, code: 0 });
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

    // ============ SINGLE SESSION: ROTATE (via rotation queue) ============

    var rotationQueue = require('./rotation');

    app.post('/api/session/:id/rotate', function(req, res) {
        var id = parseInt(req.params.id);
        var entry = rotationQueue.addRequest(id);
        res.json({ success: true, message: 'Rotating ppp' + id + '...', queueEntry: entry });

        // Start execution
        rotationQueue.executeRotation(id);
    });

    // ============ ROTATION QUEUE API ============

    app.get('/api/rotation-queue', function(req, res) {
        res.json(rotationQueue.getAll());
    });

    app.delete('/api/rotation-queue/:id', function(req, res) {
        var id = parseInt(req.params.id);
        rotationQueue.removeRequest(id);
        res.json({ success: true });
    });

    app.delete('/api/rotation-queue', function(req, res) {
        rotationQueue.clearAll();
        res.json({ success: true });
    });

    // ============ TCP CHECK ============

    var net = require('net');

    function checkProxyTcp(proxyPort, timeout) {
        timeout = timeout || 8000;
        return new Promise(function(resolve) {
            var socket = new net.Socket();
            var resolved = false;
            var startTime = Date.now();

            socket.setTimeout(timeout);

            socket.connect(proxyPort, '127.0.0.1', function() {
                // Send HTTP CONNECT to test outbound via the proxy
                socket.write('CONNECT google.com:80 HTTP/1.1\r\nHost: google.com:80\r\n\r\n');
            });

            socket.on('data', function(data) {
                if (resolved) return;
                resolved = true;
                var response = data.toString();
                var ok = response.indexOf('200') !== -1;
                var latency = Date.now() - startTime;
                socket.destroy();
                resolve({ ok: ok, latency: latency });
            });

            socket.on('timeout', function() {
                if (resolved) return;
                resolved = true;
                socket.destroy();
                resolve({ ok: false, latency: timeout, error: 'timeout' });
            });

            socket.on('error', function(err) {
                if (resolved) return;
                resolved = true;
                socket.destroy();
                resolve({ ok: false, latency: Date.now() - startTime, error: err.message });
            });
        });
    }

    app.get('/api/session/:id/check', async function(req, res) {
        var id = parseInt(req.params.id);
        var iface = 'ppp' + id;
        var ip = await getSessionIP(iface);
        if (!ip) {
            return res.json({ id: id, ok: false, error: 'no IP' });
        }
        var portInfo = getProxyPorts(id);
        if (!portInfo || !portInfo.vipPort) {
            return res.json({ id: id, ok: false, error: 'no proxy port' });
        }
        var result = await checkProxyTcp(parseInt(portInfo.vipPort));
        res.json({ id: id, ok: result.ok, latency: result.latency, error: result.error || null, ip: ip, port: portInfo.vipPort });
    });

    app.get('/api/check-all', async function(req, res) {
        var config = readConfig();
        var numAccounts = config.pppoe ? config.pppoe.length : 0;
        var totalSessions = numAccounts * 30;
        var results = [];

        // Run checks in parallel batches of 10
        var batchSize = 10;
        for (var b = 0; b < totalSessions; b += batchSize) {
            var batch = [];
            for (var i = b; i < Math.min(b + batchSize, totalSessions); i++) {
                (function(idx) {
                    batch.push((async function() {
                        var iface = 'ppp' + idx;
                        var ip = await getSessionIP(iface);
                        if (!ip) {
                            return { id: idx, ok: false, error: 'no IP' };
                        }
                        var portInfo = getProxyPorts(idx);
                        if (!portInfo || !portInfo.vipPort) {
                            return { id: idx, ok: false, error: 'no proxy port' };
                        }
                        var result = await checkProxyTcp(parseInt(portInfo.vipPort));
                        return { id: idx, ok: result.ok, latency: result.latency, error: result.error || null, ip: ip, port: portInfo.vipPort };
                    })());
                })(i);
            }
            var batchResults = await Promise.all(batch);
            results = results.concat(batchResults);
            // Emit progress
            io.emit('check_progress', { done: results.length, total: totalSessions, results: batchResults });
        }

        var passed = results.filter(function(r) { return r.ok; }).length;
        io.emit('check_complete', { passed: passed, total: totalSessions, results: results });
        res.json({ passed: passed, total: totalSessions, results: results });
    });

    // ============ BLACKLIST API ============

    function loadBlacklist() {
        try {
            return fs.readFileSync(BLACKLIST_FILE, 'utf8').split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
        } catch (e) {
            return [];
        }
    }

    app.get('/api/blacklist', function(req, res) {
        res.json(loadBlacklist());
    });

    app.post('/api/blacklist', function(req, res) {
        var domains = req.body.domains;
        if (!domains || !Array.isArray(domains)) {
            return res.status(400).json({ error: 'domains array required' });
        }
        // Clean and deduplicate
        var clean = domains.map(function(d) { return d.trim().toLowerCase(); }).filter(Boolean);
        var existing = loadBlacklist();
        var merged = existing.slice();
        for (var i = 0; i < clean.length; i++) {
            if (merged.indexOf(clean[i]) === -1) {
                merged.push(clean[i]);
            }
        }
        fs.writeFileSync(BLACKLIST_FILE, merged.join('\n') + '\n');
        res.json({ success: true, count: merged.length, domains: merged });

        // Auto-reload all proxies
        reloadAllBlacklist(io);
    });

    app.delete('/api/blacklist', function(req, res) {
        var domains = req.body.domains;
        if (domains && Array.isArray(domains)) {
            // Remove specific domains
            var existing = loadBlacklist();
            var toRemove = domains.map(function(d) { return d.trim().toLowerCase(); });
            var filtered = existing.filter(function(d) { return toRemove.indexOf(d) === -1; });
            fs.writeFileSync(BLACKLIST_FILE, filtered.join('\n') + (filtered.length ? '\n' : ''));
            res.json({ success: true, count: filtered.length, domains: filtered });
        } else {
            // Clear all
            fs.writeFileSync(BLACKLIST_FILE, '');
            res.json({ success: true, count: 0, domains: [] });
        }

        // Auto-reload all proxies
        reloadAllBlacklist(io);
    });

    // Reload all active 3proxy configs with updated blacklist
    async function reloadAllBlacklist(io) {
        var config = readConfig();
        var totalAccounts = config.pppoe ? config.pppoe.length : 0;
        var total = totalAccounts * 30;

        io.emit('rotate_log', { id: -1, data: '🔄 Đang cập nhật blacklist cho tất cả proxy...\n' });

        var reloaded = 0;
        for (var i = 0; i < total; i++) {
            var iface = 'ppp' + i;
            var ip = await getSessionIP(iface);
            if (ip) {
                try {
                    await killProxy(i);
                    await setupProxy(i, ip);
                    reloaded++;
                } catch (e) { /* skip failed */ }
            }
        }

        io.emit('rotate_log', { id: -1, data: '✅ Đã cập nhật blacklist cho ' + reloaded + ' proxy\n' });
    }
}

module.exports = registerRoutes;
