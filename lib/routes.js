const path = require('path');
const fs = require('fs');
const { readConfig, writeConfig, BASE_DIR, PROXY_DIR, PROXIES_FILE, IP_FILE, BLACKLIST_FILE, LOG_DIR, DEFAULT_INTERFACE, getTotalSessions, getAccountForSession, getInterfaceForSession } = require('./config');
const { getNetworkInterfaces, getPPPoEStatus, getSystemStats } = require('./status');
const { connectPppoe, setupProxy, rewriteProxyConfig, killProxy, killPppd, rebuildMacvlan, getSessionIP, getProxyPort, getProxyPorts, sleep, shellExec, isPrivateIP } = require('./pppoe');
const healthCheck = require('./healthcheck');

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

    // ============ AUTO START TOGGLE ============

    app.post('/api/auto-start', function(req, res) {
        try {
            var config = readConfig();
            config.auto_start = !!req.body.enabled;
            writeConfig(config);
            res.json({ success: true, auto_start: config.auto_start });
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

    // Install status check
    app.get('/api/install-status', function(req, res) {
        try {
            var config = readConfig();
            var total = getTotalSessions(config);
            var PEER_DIR = '/etc/ppp/peers';

            var peerCount = 0;
            var macvlanCount = 0;
            var proxyConfigCount = 0;
            var credentialsOk = false;

            // Check peer files
            for (var i = 0; i < total; i++) {
                try { fs.accessSync(path.join(PEER_DIR, 'nest_ppp' + i)); peerCount++; } catch(e) {}
            }

            // Check macvlan interfaces (ppp1+ need macvlan)
            try {
                var links = require('child_process').execSync('ip link show 2>/dev/null || true', { encoding: 'utf8' });
                for (var m = 1; m < total; m++) {
                    if (links.indexOf('macppp' + m) !== -1) macvlanCount++;
                }
            } catch(e) {}

            // Check 3proxy config templates
            for (var c = 0; c < total; c++) {
                try { fs.accessSync(path.join(PROXY_DIR, '3proxy_ppp' + c + '.cfg')); proxyConfigCount++; } catch(e) {}
            }

            // Check credentials
            try {
                var chapContent = fs.readFileSync('/etc/ppp/chap-secrets', 'utf8');
                var numAccounts = config.pppoe ? config.pppoe.length : 0;
                credentialsOk = true;
                for (var a = 0; a < numAccounts; a++) {
                    if (chapContent.indexOf(config.pppoe[a].username) === -1) {
                        credentialsOk = false;
                        break;
                    }
                }
            } catch(e) {}

            var macvlanNeeded = Math.max(0, total - 1); // ppp0 uses real interface
            var installed = peerCount === total && macvlanCount === macvlanNeeded && proxyConfigCount === total && credentialsOk;

            res.json({
                installed: installed,
                total: total,
                peers: { count: peerCount, total: total },
                macvlan: { count: macvlanCount, total: macvlanNeeded },
                proxyConfigs: { count: proxyConfigCount, total: total },
                credentials: credentialsOk
            });
        } catch(e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Uninstall - remove all generated config files
    app.post('/api/uninstall', function(req, res) {
        res.json({ success: true, message: 'Uninstalling...' });

        (async function() {
            try {
                var config = readConfig();
                var total = getTotalSessions(config);
                var PEER_DIR = '/etc/ppp/peers';

                io.emit('install_log', '\n============================================\n');
                io.emit('install_log', '  🗑️  UNINSTALL - Removing configs\n');
                io.emit('install_log', '============================================\n\n');

                // Remove peer files
                io.emit('install_log', '[1/4] Xoá peer files...\n');
                var removedPeers = 0;
                for (var i = 0; i < total; i++) {
                    try { fs.unlinkSync(path.join(PEER_DIR, 'nest_ppp' + i)); removedPeers++; } catch(e) {}
                }
                io.emit('install_log', '    ✅ Đã xoá ' + removedPeers + ' peer files\n');

                // Remove macvlan interfaces
                io.emit('install_log', '[2/4] Xoá macvlan interfaces...\n');
                for (var m = 1; m < total; m++) {
                    await shellExec('ip link del macppp' + m + ' 2>/dev/null || true');
                }
                io.emit('install_log', '    ✅ Đã xoá macvlan interfaces\n');

                // Remove 3proxy configs
                io.emit('install_log', '[3/4] Xoá 3proxy configs...\n');
                var removedProxy = 0;
                for (var c = 0; c < total; c++) {
                    try { fs.unlinkSync(path.join(PROXY_DIR, '3proxy_ppp' + c + '.cfg')); removedProxy++; } catch(e) {}
                }
                io.emit('install_log', '    ✅ Đã xoá ' + removedProxy + ' proxy configs\n');

                // Remove credentials
                io.emit('install_log', '[4/4] Xoá credentials...\n');
                var secretFiles = ['/etc/ppp/chap-secrets', '/etc/ppp/pap-secrets'];
                var numAccounts = config.pppoe ? config.pppoe.length : 0;
                for (var sf = 0; sf < secretFiles.length; sf++) {
                    try {
                        var content = fs.readFileSync(secretFiles[sf], 'utf8');
                        var lines = content.split('\n');
                        for (var ra = 0; ra < numAccounts; ra++) {
                            var rUser = config.pppoe[ra].username;
                            lines = lines.filter(function(line) { return line.indexOf(rUser) === -1; });
                        }
                        fs.writeFileSync(secretFiles[sf], lines.join('\n'));
                    } catch(e) {}
                }
                io.emit('install_log', '    ✅ Đã xoá credentials\n');

                io.emit('install_log', '\n============================================\n');
                io.emit('install_log', '  ✅ UNINSTALL COMPLETE\n');
                io.emit('install_log', '============================================\n');
                io.emit('install_complete', { code: 0, output: 'Uninstall complete' });
                io.emit('refresh');
            } catch(err) {
                io.emit('install_log', '❌ Lỗi: ' + err.message + '\n');
                io.emit('install_complete', { code: 1, output: 'ERROR: ' + err.message });
            }
        })();
    });

    // Install (native Node.js) - multi-account support
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

                var NUM = getTotalSessions(config);
                var PEER_DIR = '/etc/ppp/peers';

                io.emit('install_log', '============================================\n');
                io.emit('install_log', '  INSTALL - ' + NUM + ' PPPoE Sessions (' + numAccounts + ' accounts)\n');
                io.emit('install_log', '============================================\n\n');

                for (var a = 0; a < numAccounts; a++) {
                    var acc = config.pppoe[a];
                    var accIface = acc.interface || DEFAULT_INTERFACE;
                    io.emit('install_log', '  Account ' + (a + 1) + ': ' + acc.username + ' [' + accIface + '] × ' + (acc.max_session || 30) + ' sessions\n');
                }
                io.emit('install_log', '\n');

                // --- 1. Create directories ---
                io.emit('install_log', '[1/5] Tạo thư mục...\n');
                await shellExec('mkdir -p "' + PROXY_DIR + '" "' + LOG_DIR + '" "' + PEER_DIR + '"');

                // --- 2. Configure credentials for all accounts ---
                io.emit('install_log', '[2/5] Cấu hình credentials...\n');
                var secretFiles = ['/etc/ppp/chap-secrets', '/etc/ppp/pap-secrets'];
                for (var sf = 0; sf < secretFiles.length; sf++) {
                    var secretFile = secretFiles[sf];
                    try {
                        var content = '';
                        try { content = fs.readFileSync(secretFile, 'utf8'); } catch (e) { /* new file */ }
                        var lines = content.split('\n');
                        // Remove old lines for all accounts
                        for (var ra = 0; ra < numAccounts; ra++) {
                            var rUser = config.pppoe[ra].username;
                            lines = lines.filter(function(line) { return line.indexOf(rUser) === -1; });
                        }
                        // Add new lines
                        for (var na = 0; na < numAccounts; na++) {
                            lines.push('"' + config.pppoe[na].username + '" * "' + config.pppoe[na].password + '" *');
                        }
                        fs.writeFileSync(secretFile, lines.join('\n') + '\n', { mode: 0o600 });
                    } catch (e) {
                        var allCreds = '';
                        for (var wc = 0; wc < numAccounts; wc++) {
                            allCreds += '"' + config.pppoe[wc].username + '" * "' + config.pppoe[wc].password + '" *\n';
                        }
                        fs.writeFileSync(secretFile, allCreds, { mode: 0o600 });
                    }
                }
                io.emit('install_log', '    ✅ chap-secrets & pap-secrets\n');

                // --- 3. Create macvlan interfaces ---
                io.emit('install_log', '[3/5] Tạo ' + NUM + ' macvlan interfaces...\n');
                for (var i = 1; i < NUM; i++) {
                    var macvlan = 'macppp' + i;
                    var macIface = getInterfaceForSession(config, i);
                    await shellExec('ip link del "' + macvlan + '" 2>/dev/null');
                    await shellExec('ip link add link "' + macIface + '" "' + macvlan + '" type macvlan mode bridge');
                    var hexI = ('0' + Math.floor(i / 256).toString(16)).slice(-2) + ':' +
                               ('0' + (i % 256).toString(16)).slice(-2);
                    await shellExec('ip link set "' + macvlan + '" address "02:00:00:00:' + hexI + '"');
                    await shellExec('ip link set "' + macvlan + '" up');
                }
                io.emit('install_log', '    ✅ macppp1 - macppp' + (NUM - 1) + ' created\n');

                // --- 4. Create peer files ---
                io.emit('install_log', '[4/5] Tạo ' + NUM + ' peer files...\n');
                for (var p = 0; p < NUM; p++) {
                    var peerAcc = getAccountForSession(config, p);
                    var peerIface = p === 0 ? (peerAcc.account.interface || DEFAULT_INTERFACE) : 'macppp' + p;
                    var peerContent = [
                        'plugin pppoe.so',
                        'nic-' + peerIface,
                        'user "' + peerAcc.account.username + '"',
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
                        'auth iponly',
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
                var totalSessions = getTotalSessions(config);

                // Clear rotation queue first to prevent re-scheduling
                var rotationQueue = require('./rotation');
                rotationQueue.clearAll();

                // Mark all sessions as manually stopped (prevents health check auto-restart)
                healthCheck.markAllStopped(totalSessions);

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

    // ============ START ALL (smart - skip healthy sessions) ============

    app.post('/api/start-all', function(req, res) {
        res.json({ success: true, message: 'Smart starting all sessions...' });

        (async function() {
            try {
                var config = readConfig();
                var totalSessions = getTotalSessions(config);

                io.emit('start_log', '============================================\n');
                io.emit('start_log', '  SMART START - ' + totalSessions + ' PPPoE sessions\n');
                io.emit('start_log', '============================================\n\n');

                // Clear all stopped marks before starting
                healthCheck.clearAllStopped();

                // Clear rotation queue to prevent conflicts with start-all
                var rotationQueue = require('./rotation');
                rotationQueue.clearAll();

                // --- Phase 1: Check which sessions are already healthy ---
                io.emit('start_log', '[1/3] Kiểm tra trạng thái các phiên...\n');

                var healthyIds = [];    // Sessions that are OK — skip
                var brokenIds = [];     // Sessions that need restart
                var downIds = [];       // Sessions that are completely down

                for (var c = 0; c < totalSessions; c++) {
                    var cIface = 'ppp' + c;
                    var cIp = await getSessionIP(cIface);

                    if (!cIp) {
                        // No IP — session is down
                        downIds.push(c);
                        io.emit('start_log', '  ⬇ ppp' + c + '  — không có IP\n');
                        continue;
                    }

                    // Has IP — check for CGNAT/private IP first
                    if (isPrivateIP(cIp)) {
                        brokenIds.push(c);
                        io.emit('start_log', '  ⚠️ ppp' + c + '  IP CGNAT: ' + cIp + ' — cần xoay lại\\n');
                        continue;
                    }

                    // Has IP, check proxy
                    var cPortInfo = getProxyPorts(c);
                    if (!cPortInfo || !cPortInfo.vipPort) {
                        // Has IP but no proxy config
                        brokenIds.push(c);
                        io.emit('start_log', '  ⚠ ppp' + c + '  ' + cIp + ' — không có proxy\n');
                        continue;
                    }

                    // Has IP + proxy config, test connectivity
                    var cCheck = await checkProxyTcp(parseInt(cPortInfo.vipPort), 5000);
                    if (cCheck.ok) {
                        // Fully healthy — skip!
                        healthyIds.push(c);
                        io.emit('start_log', '  ✅ ppp' + c + '  ' + cIp + ' — OK (' + cCheck.latency + 'ms) → bỏ qua\n');
                    } else {
                        // Has IP + proxy but connection is broken
                        brokenIds.push(c);
                        io.emit('start_log', '  ❌ ppp' + c + '  ' + cIp + ' — proxy lỗi (' + (cCheck.error || 'no response') + ')\n');
                    }
                }

                io.emit('start_log', '\n  📊 Tổng kết: ' + healthyIds.length + ' OK, ' + brokenIds.length + ' lỗi, ' + downIds.length + ' chưa kết nối\n');

                var needStart = brokenIds.concat(downIds);

                if (needStart.length === 0) {
                    io.emit('start_log', '\n  🎉 Tất cả phiên đều hoạt động tốt! Không cần làm gì.\n');
                    io.emit('start_log', '\n============================================\n');
                    io.emit('start_log', '  PPPoE connected: ' + totalSessions + '/' + totalSessions + '\n');
                    io.emit('start_log', '============================================\n');
                    io.emit('start_complete', { code: 0, output: totalSessions + '/' + totalSessions + ' connected' });
                    io.emit('refresh');
                    return;
                }

                // --- Phase 2: Stop broken sessions only ---
                io.emit('start_log', '\n[2/3] Dừng ' + brokenIds.length + ' phiên lỗi...\n');

                for (var b = 0; b < brokenIds.length; b++) {
                    var bId = brokenIds[b];
                    emitSessionState(io, bId, { status: 'stopping', step: 'cleanup', message: 'Đang dọn dẹp...' });
                    await killProxy(bId);
                    await killPppd(bId);
                    // Clean ip rules for this session
                    await shellExec('ip route flush table ' + (100 + bId) + ' 2>/dev/null');
                    io.emit('start_log', '  ⏹ ppp' + bId + ' đã dừng\n');
                }

                // --- Phase 3: Start broken + down sessions ---
                io.emit('start_log', '\n[3/3] Khởi động ' + needStart.length + ' phiên...\n\n');

                var connected = healthyIds.length;

                for (var n = 0; n < needStart.length; n++) {
                    var nId = needStart[n];
                    var nIface = 'ppp' + nId;

                    // Mark session as started
                    healthCheck.markStarted(nId);

                    emitSessionState(io, nId, { status: 'connecting', step: 'starting', message: 'Đang kết nối...' });

                    var nIp = await connectPppoe(nId);

                    if (nIp) {
                        // Check CGNAT before setting up proxy
                        if (isPrivateIP(nIp)) {
                            emitSessionState(io, nId, { ip: nIp, status: 'cgnat', step: 'cgnat', message: 'IP CGNAT (' + nIp + ')' });
                            io.emit('start_log', '  ⚠️ ' + nIface + '  IP CGNAT: ' + nIp + ' (ISP cấp IP nội bộ, sẽ tự xoay lại)\n');
                            continue;
                        }

                        emitSessionState(io, nId, { ip: nIp, status: 'connected', step: 'proxy', message: 'Đang cấu hình proxy...' });

                        var nResult = await setupProxy(nId, nIp);

                        // Register IP
                        try { fs.appendFileSync(IP_FILE, nIp + '|' + Date.now() + '\n'); } catch(e) {}

                        emitSessionState(io, nId, { ip: nIp, vipPort: String(nResult.vipPort), ports: nResult.ports.map(String), status: 'connected', proxyStatus: 'running', step: 'done', message: '' });
                        io.emit('start_log', '  ✅ ' + nIface + '  ' + nIp + ' → VIP:' + nResult.vipPort + ' (+' + (nResult.ports.length - 1) + ' ports)\n');

                        connected++;
                    } else {
                        emitSessionState(io, nId, { status: 'stopped', step: 'failed', message: 'Không nhận được IP' });
                        io.emit('start_log', '  ❌ ' + nIface + '  no IP (timeout)\n');
                    }

                    // Delay between sessions
                    if (n < needStart.length - 1) {
                        await sleep(2000);
                    }
                }

                await sleep(1000);

                // Summary
                var proxyCount = await shellExec('pgrep -c 3proxy 2>/dev/null || echo 0');
                io.emit('start_log', '\n============================================\n');
                io.emit('start_log', '  PPPoE connected: ' + connected + '/' + totalSessions + '\n');
                io.emit('start_log', '  Đã bỏ qua:      ' + healthyIds.length + ' phiên OK\n');
                io.emit('start_log', '  Đã khởi động:    ' + needStart.length + ' phiên\n');
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
                // Mark session as started (remove from stopped set)
                healthCheck.markStarted(id);

                // Clear any stale rotation queue entry (prevents double-rotation)
                var rotationQueue = require('./rotation');
                rotationQueue.removeRequest(id);

                emitSessionState(io, id, { status: 'connecting', step: 'starting', message: 'Đang kết nối PPPoE...' });
                io.emit('rotate_log', { id: id, data: '▶ Khởi động ' + iface + '...\n' });

                var ip = await connectPppoe(id);
                if (!ip) {
                    emitSessionState(io, id, { status: 'stopped', step: 'failed', message: 'Không nhận được IP' });
                    io.emit('rotate_log', { id: id, data: '❌ ' + iface + ' không nhận được IP\n' });
                    io.emit('session_update', { id: id, output: 'FAIL no IP', code: 1 });
                    return;
                }

                // Check CGNAT before setting up proxy
                if (isPrivateIP(ip)) {
                    emitSessionState(io, id, { ip: ip, status: 'cgnat', step: 'cgnat', message: 'IP CGNAT (' + ip + ')' });
                    io.emit('rotate_log', { id: id, data: '⚠️ ' + iface + ' IP CGNAT: ' + ip + ' (ISP cấp IP nội bộ, không setup proxy)\n' });
                    io.emit('session_update', { id: id, output: 'CGNAT ' + ip, code: 1 });
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
                // Mark session as manually stopped (health check will skip it)
                healthCheck.markStopped(id);

                // Also remove from rotation queue
                var rotationQueue = require('./rotation');
                rotationQueue.removeRequest(id);

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
        var totalSessions = getTotalSessions(config);

        // Run ALL checks in parallel
        var promises = [];
        for (var i = 0; i < totalSessions; i++) {
            (function(idx) {
                promises.push((async function() {
                    var iface = 'ppp' + idx;
                    var ip = await getSessionIP(iface);
                    if (!ip) {
                        var r = { id: idx, ok: false, error: 'no IP' };
                        io.emit('check_progress', { done: idx + 1, total: totalSessions, results: [r] });
                        return r;
                    }
                    var portInfo = getProxyPorts(idx);
                    if (!portInfo || !portInfo.vipPort) {
                        var r = { id: idx, ok: false, error: 'no proxy port' };
                        io.emit('check_progress', { done: idx + 1, total: totalSessions, results: [r] });
                        return r;
                    }
                    var result = await checkProxyTcp(parseInt(portInfo.vipPort));
                    var r = { id: idx, ok: result.ok, latency: result.latency, error: result.error || null, ip: ip, port: portInfo.vipPort };
                    io.emit('check_progress', { done: idx + 1, total: totalSessions, results: [r] });
                    return r;
                })());
            })(i);
        }

        var results = await Promise.all(promises);
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

    // Reload all active 3proxy configs with updated blacklist (keeps same ports)
    function reloadAllBlacklist(io) {
        var config = readConfig();
        var total = getTotalSessions(config);

        var reloaded = 0;
        for (var i = 0; i < total; i++) {
            if (rewriteProxyConfig(i)) reloaded++;
        }

        io.emit('rotate_log', { id: -1, data: '✅ Đã cập nhật blacklist cho ' + reloaded + ' proxy\n' });
    }

    // ============ IP LIST API ============

    app.get('/api/iplist', function(req, res) {
        try {
            var content = fs.readFileSync(IP_FILE, 'utf8');
            var lines = content.split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
            var entries = lines.map(function(line) {
                var parts = line.split('|');
                return {
                    ip: parts[0] || '',
                    timestamp: parts[1] ? parseInt(parts[1]) : 0
                };
            });
            res.json({ count: entries.length, entries: entries });
        } catch (e) {
            res.json({ count: 0, entries: [] });
        }
    });

    app.delete('/api/iplist', function(req, res) {
        try {
            fs.writeFileSync(IP_FILE, '');
            res.json({ success: true, count: 0 });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // ============ PER-FARM (ACCOUNT GROUP) APIS ============

    // Get session range for a given account index
    function getFarmRange(config, farmIdx) {
        if (!config.pppoe || farmIdx >= config.pppoe.length) return { start: 0, end: 0 };
        var start = 0;
        for (var i = 0; i < farmIdx; i++) {
            start += config.pppoe[i].max_session || 30;
        }
        var count = config.pppoe[farmIdx].max_session || 30;
        return { start: start, end: start + count };
    }

    // Stop a single farm
    app.post('/api/farm/:idx/stop', function(req, res) {
        var farmIdx = parseInt(req.params.idx);
        res.json({ success: true });

        (async function() {
            var config = readConfig();
            var range = getFarmRange(config, farmIdx);
            io.emit('start_log', '[*] Stopping farm ' + farmIdx + ' (ppp' + range.start + '-ppp' + (range.end - 1) + ')...\n');

            for (var i = range.start; i < range.end; i++) {
                // Mark each session as manually stopped
                healthCheck.markStopped(i);
                var rotQ = require('./rotation');
                rotQ.removeRequest(i);

                await killProxy(i);
                await killPppd(i);
                emitSessionState(io, i, { status: 'stopped', step: 'done', message: '' });
            }
            io.emit('start_log', '[✓] Farm ' + farmIdx + ' stopped\n');
            io.emit('refresh');
        })();
    });

    // Start a single farm (smart - skip healthy sessions)
    app.post('/api/farm/:idx/start', function(req, res) {
        var farmIdx = parseInt(req.params.idx);
        res.json({ success: true });

        (async function() {
            var config = readConfig();
            var range = getFarmRange(config, farmIdx);
            var acc = config.pppoe[farmIdx];
            var farmTotal = range.end - range.start;
            io.emit('start_log', '[*] Smart starting farm ' + farmIdx + ' (' + acc.username + ', ppp' + range.start + '-ppp' + (range.end - 1) + ')...\n');

            // Phase 1: Check health of each session
            var healthyIds = [];
            var brokenIds = [];
            var downIds = [];

            for (var c = range.start; c < range.end; c++) {
                var cIface = 'ppp' + c;
                var cIp = await getSessionIP(cIface);

                if (!cIp) {
                    downIds.push(c);
                    continue;
                }

                var cPortInfo = getProxyPorts(c);
                if (!cPortInfo || !cPortInfo.vipPort) {
                    brokenIds.push(c);
                    continue;
                }

                var cCheck = await checkProxyTcp(parseInt(cPortInfo.vipPort), 5000);
                if (cCheck.ok) {
                    healthyIds.push(c);
                    io.emit('start_log', '  ✅ ppp' + c + ' OK → bỏ qua\n');
                } else {
                    brokenIds.push(c);
                }
            }

            var needStart = brokenIds.concat(downIds);
            io.emit('start_log', '  📊 ' + healthyIds.length + ' OK, ' + brokenIds.length + ' lỗi, ' + downIds.length + ' chưa kết nối\n');

            if (needStart.length === 0) {
                io.emit('start_log', '[✓] Farm ' + farmIdx + ': tất cả ' + farmTotal + ' phiên đều OK!\n');
                io.emit('refresh');
                return;
            }

            // Phase 2: Stop broken sessions
            for (var b = 0; b < brokenIds.length; b++) {
                var bId = brokenIds[b];
                await killProxy(bId);
                await killPppd(bId);
                await shellExec('ip route flush table ' + (100 + bId) + ' 2>/dev/null');
            }

            // Phase 3: Start broken + down sessions
            var connected = healthyIds.length;
            for (var n = 0; n < needStart.length; n++) {
                var nId = needStart[n];
                healthCheck.markStarted(nId);

                emitSessionState(io, nId, { status: 'connecting', step: 'starting', message: 'Đang kết nối...' });
                var ip = await connectPppoe(nId);
                if (ip) {
                    var result = await setupProxy(nId, ip);
                    try { fs.appendFileSync(IP_FILE, ip + '|' + Date.now() + '\n'); } catch(e) {}
                    emitSessionState(io, nId, { ip: ip, vipPort: String(result.vipPort), ports: result.ports.map(String), status: 'connected', proxyStatus: 'running', step: 'done', message: '' });
                    connected++;
                } else {
                    emitSessionState(io, nId, { status: 'stopped', step: 'failed', message: 'Không nhận được IP' });
                }
                if (n < needStart.length - 1) await sleep(2000);
            }
            io.emit('start_log', '[✓] Farm ' + farmIdx + ': ' + connected + '/' + farmTotal + ' connected (bỏ qua ' + healthyIds.length + ' phiên OK)\n');
            io.emit('refresh');
        })();
    });

    // Check all sessions in a farm
    app.get('/api/farm/:idx/check', async function(req, res) {
        var farmIdx = parseInt(req.params.idx);
        var config = readConfig();
        var range = getFarmRange(config, farmIdx);

        var promises = [];
        for (var i = range.start; i < range.end; i++) {
            (function(idx) {
                promises.push((async function() {
                    var iface = 'ppp' + idx;
                    var ip = await getSessionIP(iface);
                    if (!ip) return { id: idx, ok: false, error: 'no IP' };
                    var portInfo = getProxyPorts(idx);
                    if (!portInfo || !portInfo.vipPort) return { id: idx, ok: false, error: 'no proxy port' };
                    var result = await checkProxyTcp(parseInt(portInfo.vipPort));
                    return { id: idx, ok: result.ok, latency: result.latency, error: result.error || null, ip: ip, port: portInfo.vipPort };
                })());
            })(i);
        }

        var results = await Promise.all(promises);
        var passed = results.filter(function(r) { return r.ok; }).length;
        res.json({ passed: passed, total: range.end - range.start, results: results });
    });
}

module.exports = registerRoutes;
