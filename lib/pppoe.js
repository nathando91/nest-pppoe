const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { PROXY_DIR, PROXIES_FILE, BLACKLIST_FILE, LOG_DIR, DEFAULT_INTERFACE, readConfig, getAccountForSession } = require('./config');

const execAsync = promisify(exec);

const PORTS_PER_SESSION = 6; // 1 VIP + 5 regular

// Track pppd PIDs: Map<sessionId, pid>
var pppdPids = new Map();

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

// Detect CGNAT / private IPs that don't have real internet access
// CGNAT: 100.64.0.0/10 (100.64-127.x.x)
// Private: 10.0.0.0/8, 172.16.0.0/12 (172.16-31.x.x), 192.168.0.0/16
function isPrivateIP(ip) {
    if (!ip) return false;
    var parts = ip.split('.');
    if (parts.length !== 4) return false;
    var a = parseInt(parts[0]);
    var b = parseInt(parts[1]);
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12 (CGNAT tu ISP)
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true;   // 100.64.0.0/10 (CGNAT RFC 6598)
    return false;
}

// Returns { vipPort, ports: [all 6 ports] } or null
function getProxyPorts(id) {
    var cfgFile = path.join(PROXY_DIR, '3proxy_ppp' + id + '_active.cfg');
    try {
        var content = fs.readFileSync(cfgFile, 'utf8');
        var matches = content.match(/proxy -p(\d+)/g);
        if (!matches || matches.length === 0) return null;
        var ports = matches.map(function(m) {
            return m.replace('proxy -p', '');
        });
        return { vipPort: ports[0], ports: ports };
    } catch (e) {
        return null;
    }
}

// Legacy single-port getter (for backward compat)
function getProxyPort(id) {
    var info = getProxyPorts(id);
    return info ? info.vipPort : '';
}

function randomPort() {
    return Math.floor(Math.random() * 50001) + 10000; // 10000-60000
}

async function findFreePort(usedPorts) {
    for (var attempt = 0; attempt < 50; attempt++) {
        var port = randomPort();
        if (usedPorts && usedPorts.indexOf(port) !== -1) continue;
        var inUse = await shellExec('ss -tlnH "sport = :' + port + '" 2>/dev/null | head -1');
        if (!inUse) return port;
    }
    return randomPort(); // fallback
}

async function findFreePorts(count) {
    var ports = [];
    for (var i = 0; i < count; i++) {
        var port = await findFreePort(ports);
        ports.push(port);
    }
    return ports;
}

async function killProxy(id) {
    // Kill by config file pattern (catches all related 3proxy instances)
    await shellExec('pkill -9 -f "3proxy_ppp' + id + '_active" 2>/dev/null');

    // Also kill by port (fallback)
    var info = getProxyPorts(id);
    if (info && info.ports.length > 0) {
        for (var i = 0; i < info.ports.length; i++) {
            var pid = await shellExec('lsof -ti :' + info.ports[i] + ' 2>/dev/null');
            if (pid) {
                var pids = pid.split('\n').filter(Boolean);
                for (var p = 0; p < pids.length; p++) {
                    await shellExec('kill -9 ' + pids[p] + ' 2>/dev/null');
                }
            }
        }
    }
}

async function killPppd(id) {
    var iface = 'ppp' + id;

    // Collect all PIDs to kill
    var pidsToKill = [];

    // 1) Tracked PID
    var trackedPid = pppdPids.get(id);
    if (trackedPid) {
        pidsToKill.push(trackedPid);
        pppdPids.delete(id);
    }

    // 2) Find orphan pppd by cmdline match
    // Matches both new format (pppd plugin pppoe.so ... unit N ...)
    // and legacy format (pppd call nest_pppN)
    var allPids = await shellExec('pgrep -a pppd 2>/dev/null');
    if (allPids) {
        var lines = allPids.split('\n').filter(Boolean);
        for (var p = 0; p < lines.length; p++) {
            var parts = lines[p].split(' ');
            var pid = parseInt(parts[0]);
            var cmd = parts.slice(1).join(' ');
            // Match by unit number (new format) or peer name (legacy)
            var unitMatch = cmd.match(/\bunit\s+(\d+)\b/);
            var peerMatch = cmd.match(/^pppd call nest_ppp(\d+)$/);
            var matchedId = -1;
            if (unitMatch) matchedId = parseInt(unitMatch[1]);
            else if (peerMatch) matchedId = parseInt(peerMatch[1]);
            if (matchedId === id && pidsToKill.indexOf(pid) === -1) {
                pidsToKill.push(pid);
            }
        }
    }

    // 3) PID file
    var pidFile = '/var/run/' + iface + '.pid';
    try {
        var filePid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        if (filePid && pidsToKill.indexOf(filePid) === -1) {
            pidsToKill.push(filePid);
        }
    } catch (e) { /* no pid file */ }

    if (pidsToKill.length === 0) return;

    // Graceful: SIGTERM first → pppd sends LCP Terminate-Request to ISP
    for (var t = 0; t < pidsToKill.length; t++) {
        await shellExec('kill -15 ' + pidsToKill[t] + ' 2>/dev/null');
    }

    // Wait up to 3s for graceful shutdown
    for (var w = 0; w < 6; w++) {
        await sleep(500);
        var stillAlive = false;
        for (var c = 0; c < pidsToKill.length; c++) {
            var alive = await shellExec('kill -0 ' + pidsToKill[c] + ' 2>/dev/null && echo alive');
            if (alive && alive.indexOf('alive') !== -1) {
                stillAlive = true;
                break;
            }
        }
        if (!stillAlive) break;
    }

    // Force kill any survivors
    for (var k = 0; k < pidsToKill.length; k++) {
        await shellExec('kill -9 ' + pidsToKill[k] + ' 2>/dev/null');
    }

    // Wait for interface down
    for (var iw = 0; iw < 10; iw++) {
        var exists = await shellExec('ip link show ' + iface + ' 2>/dev/null');
        if (!exists) break;
        await sleep(300);
    }
}

async function rebuildMacvlan(id, iface) {
    var config = readConfig();
    var info = getAccountForSession(config, id);
    var nic = iface || info.account.interface || DEFAULT_INTERFACE;
    
    // session 0 or the first session of any account uses the real interface, no macvlan needed
    if (id === info.offset) {
        return null;
    }

    var macvlan = 'macppp' + id;
    var mac = '02:' +
        ('0' + (Math.floor(Math.random() * 256)).toString(16)).slice(-2) + ':' +
        ('0' + (Math.floor(Math.random() * 256)).toString(16)).slice(-2) + ':' +
        ('0' + (Math.floor(Math.random() * 256)).toString(16)).slice(-2) + ':' +
        ('0' + (Math.floor(Math.random() * 256)).toString(16)).slice(-2) + ':' +
        ('0' + (Math.floor(Math.random() * 256)).toString(16)).slice(-2);
    await shellExec('ip link set ' + macvlan + ' down 2>/dev/null');
    await shellExec('ip link del ' + macvlan + ' 2>/dev/null');
    await shellExec('ip link add link ' + nic + ' ' + macvlan + ' type macvlan mode bridge');
    await shellExec('ip link set ' + macvlan + ' address ' + mac);
    await shellExec('ip link set ' + macvlan + ' up');
    await sleep(1000);
    return mac;
}

async function connectPppoe(id) {
    var iface = 'ppp' + id;

    // ALWAYS kill existing pppd for this session first (guarantee 1-1 mapping)
    await killPppd(id);

    // Build pppd args dynamically — no peer file needed
    // Password is read from chap-secrets (already configured during install)
    // This avoids exposing password in `ps aux` output
    var config = readConfig();
    var info = getAccountForSession(config, id);
    var account = info.account;
    var nic = id === info.offset ? (account.interface || DEFAULT_INTERFACE) : 'macppp' + id;

    var args = [
        'plugin', 'pppoe.so',
        'nic-' + nic,
        'user', account.username,
        'unit', String(id),
        'noipdefault',
        'nodefaultroute',
        'hide-password',
        'noauth',
        'nopersist',
        'maxfail', '1',
        'mtu', '1492',
        'mru', '1492',
        'lcp-echo-interval', '20',
        'lcp-echo-failure', '3'
        // NO usepeerdns — prevents race condition on /etc/resolv.conf
    ];

    var child = spawn('pppd', args, { detached: true, stdio: 'ignore' });
    pppdPids.set(id, child.pid);
    child.unref();

    // Wait up to 30s for IP, but exit early if pppd dies (PADO timeout = ~19s)
    for (var w = 0; w < 30; w++) {
        var ip = await getSessionIP(iface);
        if (ip) return ip;

        // Check if pppd is still alive — if it exited, no point waiting
        var alive = await shellExec('kill -0 ' + child.pid + ' 2>/dev/null && echo y');
        if (!alive) {
            // pppd exited (PADO timeout or auth failure) — fail fast
            pppdPids.delete(id);
            return '';
        }
        await sleep(1000);
    }
    // Timeout — kill the pppd we just spawned (don't leave zombie)
    await shellExec('kill -15 ' + child.pid + ' 2>/dev/null');
    await sleep(500);
    await shellExec('kill -9 ' + child.pid + ' 2>/dev/null');
    pppdPids.delete(id);
    return '';
}

// Scan running pppd processes and populate pppdPids map (call on startup)
async function scanExistingPids() {
    var allPids = await shellExec('pgrep -a pppd 2>/dev/null');
    if (!allPids) return;
    var lines = allPids.split('\n').filter(Boolean);
    for (var i = 0; i < lines.length; i++) {
        var parts = lines[i].split(' ');
        var pid = parseInt(parts[0]);
        var cmd = parts.slice(1).join(' ');
        // Extract session ID from cmdline:
        //   New format: "pppd plugin pppoe.so nic-macpppN ... unit N ..."
        //   Legacy format: "pppd call nest_pppN"
        var unitMatch = cmd.match(/\bunit\s+(\d+)\b/);
        var peerMatch = cmd.match(/^pppd call nest_ppp(\d+)$/);
        var sessionId = -1;
        if (unitMatch) sessionId = parseInt(unitMatch[1]);
        else if (peerMatch) sessionId = parseInt(peerMatch[1]);
        if (sessionId >= 0) {
            // Only track if not already tracked (keep first PID, kill duplicates)
            if (pppdPids.has(sessionId)) {
                // Duplicate! Kill it
                await shellExec('kill -9 ' + pid + ' 2>/dev/null');
            } else {
                pppdPids.set(sessionId, pid);
            }
        }
    }
}

// Setup 6 proxy ports (1 VIP + 5 regular) for a session
// Returns { vipPort, ports: [6 ports] }
async function setupProxy(id, ip) {
    var iface = 'ppp' + id;
    var table = 100 + id;
    var cfgFile = path.join(PROXY_DIR, '3proxy_ppp' + id + '_active.cfg');
    var lineNum = id + 1;

    // Policy routing
    await shellExec('ip route replace default dev ' + iface + ' table ' + table + ' 2>/dev/null');
    await shellExec('ip rule del from ' + ip + ' 2>/dev/null');
    await shellExec('ip rule add from ' + ip + ' table ' + table);

    // Find 6 free ports
    var ports = await findFreePorts(PORTS_PER_SESSION);

    // Build proxy lines for 3proxy config
    var proxyLines = ports.map(function(port) {
        return 'proxy -p' + port + ' -i0.0.0.0 -e' + ip;
    });

    var denyRules = loadDenyRules();

    // Write 3proxy config with all 6 proxy lines
    var cfg = [
        '# 3proxy runtime config for ppp' + id,
        '# IP: ' + ip,
        '# VIP Port: ' + ports[0],
        '# Ports: ' + ports.join(','),
        '',
        'nserver 8.8.8.8',
        'nserver 8.8.4.4',
        '',
        'log ' + LOG_DIR + '/3proxy_ppp' + id + '.log D',
        'logformat "L%t %N:%p %E %C:%c %R:%r %O %I %h %T"',
        '',
        'timeouts 1 5 30 60 180 1800 15 60',
        '',
        'auth iponly'
    ].concat(denyRules.length > 0 ? [''].concat(denyRules) : []).concat([
        'allow *',
        '',
        'external ' + ip,
        ''
    ]).concat(proxyLines).join('\n');
    fs.writeFileSync(cfgFile, cfg);

    // Start 3proxy
    spawn('3proxy', [cfgFile], { detached: true, stdio: 'ignore' }).unref();

    // Update proxies.txt: format = IP:VIP_PORT,PORT2,PORT3,PORT4,PORT5,PORT6
    var proxyEntry = ip + ':' + ports.join(',');
    try {
        var lines = fs.readFileSync(PROXIES_FILE, 'utf8').split('\n');
        while (lines.length < lineNum) lines.push('');
        lines[lineNum - 1] = proxyEntry;
        fs.writeFileSync(PROXIES_FILE, lines.join('\n'));
    } catch (e) {
        fs.appendFileSync(PROXIES_FILE, proxyEntry + '\n');
    }

    return { vipPort: ports[0], ports: ports };
}

// Build deny rules from blacklist file
function loadDenyRules() {
    var denyRules = [];
    try {
        var blocked = fs.readFileSync(BLACKLIST_FILE, 'utf8').split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
        if (blocked.length > 0) {
            // 3proxy 0.9.6: wildcards don't work for HTTP proxy ACL
            // Use exact domains with common subdomain variants instead
            var allDomains = [];
            for (var b = 0; b < blocked.length; b++) {
                var domain = blocked[b].replace(/^\*\.?/, ''); // strip leading * or *.
                allDomains.push(domain);
                // Add common subdomain variants
                if (domain.indexOf('www.') !== 0) allDomains.push('www.' + domain);
                if (domain.indexOf('m.') !== 0) allDomains.push('m.' + domain);
                if (domain.indexOf('mobile.') !== 0) allDomains.push('mobile.' + domain);
                if (domain.indexOf('api.') !== 0) allDomains.push('api.' + domain);
            }
            // Deduplicate
            var unique = [];
            for (var u = 0; u < allDomains.length; u++) {
                if (unique.indexOf(allDomains[u]) === -1) unique.push(allDomains[u]);
            }
            denyRules.push('deny * * ' + unique.join(','));
        }
    } catch (e) { /* no blacklist file */ }
    return denyRules;
}

// Rewrite 3proxy config with updated blacklist — keeps same ports/IP, only changes deny rules
// Returns true if successful, false if no active config exists
function rewriteProxyConfig(id) {
    var cfgFile = path.join(PROXY_DIR, '3proxy_ppp' + id + '_active.cfg');
    try {
        var content = fs.readFileSync(cfgFile, 'utf8');
    } catch (e) {
        return false; // no active config
    }

    // Parse existing IP and ports from config
    var ipMatch = content.match(/^# IP: (.+)$/m);
    var portsMatch = content.match(/^# Ports: (.+)$/m);
    if (!ipMatch || !portsMatch) return false;

    var ip = ipMatch[1].trim();
    var ports = portsMatch[1].trim().split(',');
    var denyRules = loadDenyRules();

    // Build proxy lines (same ports)
    var proxyLines = ports.map(function(port) {
        return 'proxy -p' + port.trim() + ' -i0.0.0.0 -e' + ip;
    });

    // Rewrite config with same ports but updated deny rules
    var cfg = [
        '# 3proxy runtime config for ppp' + id,
        '# IP: ' + ip,
        '# VIP Port: ' + ports[0],
        '# Ports: ' + ports.join(','),
        '',
        'nserver 8.8.8.8',
        'nserver 8.8.4.4',
        '',
        'log ' + LOG_DIR + '/3proxy_ppp' + id + '.log D',
        'logformat "L%t %N:%p %E %C:%c %R:%r %O %I %h %T"',
        '',
        'timeouts 1 5 30 60 180 1800 15 60',
        '',
        'auth iponly'
    ].concat(denyRules.length > 0 ? [''].concat(denyRules) : []).concat([
        'allow *',
        '',
        'external ' + ip,
        ''
    ]).concat(proxyLines).join('\n');
    fs.writeFileSync(cfgFile, cfg);

    // Kill old 3proxy and start with updated config
    // killProxy is async, but we can just pkill synchronously here for speed
    try {
        require('child_process').execSync('pkill -9 -f "3proxy_ppp' + id + '_active" 2>/dev/null', { timeout: 5000 });
    } catch (e) { /* ignore */ }

    spawn('3proxy', [cfgFile], { detached: true, stdio: 'ignore' }).unref();
    return true;
}

// Disable a specific port from 3proxy config (port is DONE on server)
// Rewrites config without that port line, then reloads 3proxy
function disableProxyPort(id, port) {
    var cfgFile = path.join(PROXY_DIR, '3proxy_ppp' + id + '_active.cfg');
    try {
        var content = fs.readFileSync(cfgFile, 'utf8');
    } catch (e) {
        return false;
    }

    var portStr = String(port);
    var lines = content.split('\n');
    var proxyLine = 'proxy -p' + portStr + ' ';
    var hasPort = false;

    // Filter out the proxy line for this port
    var newLines = lines.filter(function(line) {
        if (line.indexOf(proxyLine) === 0) {
            hasPort = true;
            return false; // Remove this line
        }
        return true;
    });

    if (!hasPort) return false; // Port not found in config

    // Also update the # Ports: header
    newLines = newLines.map(function(line) {
        if (line.indexOf('# Ports: ') === 0) {
            var currentPorts = line.replace('# Ports: ', '').split(',').map(function(p) { return p.trim(); });
            var filtered = currentPorts.filter(function(p) { return p !== portStr; });
            return '# Ports: ' + filtered.join(',');
        }
        return line;
    });

    fs.writeFileSync(cfgFile, newLines.join('\n'));

    // Reload 3proxy with updated config
    try {
        require('child_process').execSync('pkill -9 -f "3proxy_ppp' + id + '_active" 2>/dev/null', { timeout: 5000 });
    } catch (e) { /* ignore */ }

    // Only restart if there are still proxy lines left
    var hasProxyLines = newLines.some(function(l) { return l.indexOf('proxy -p') === 0; });
    if (hasProxyLines) {
        spawn('3proxy', [cfgFile], { detached: true, stdio: 'ignore' }).unref();
    }

    return true;
}

module.exports = {
    sleep,
    shellExec,
    getSessionIP,
    getProxyPort,
    getProxyPorts,
    killProxy,
    killPppd,
    rebuildMacvlan,
    connectPppoe,
    setupProxy,
    rewriteProxyConfig,
    disableProxyPort,
    isPrivateIP,
    scanExistingPids,
    PORTS_PER_SESSION
};
