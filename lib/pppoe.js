const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { PROXY_DIR, PROXIES_FILE, BLACKLIST_FILE, LOG_DIR, DEFAULT_INTERFACE } = require('./config');

const execAsync = promisify(exec);

const PORTS_PER_SESSION = 6; // 1 VIP + 5 regular

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
    var peer = 'nest_ppp' + id;
    var iface = 'ppp' + id;

    // Force kill ALL pppd processes for this session (by EXACT peer name match)
    // IMPORTANT: Use $ anchor to prevent "nest_ppp1" from matching "nest_ppp10", "nest_ppp11", etc.
    await shellExec('pkill -9 -f "^pppd call ' + peer + '$" 2>/dev/null');

    // Also kill by PID file in case peer name didn't match
    var pidFile = '/var/run/' + iface + '.pid';
    try {
        var pid = fs.readFileSync(pidFile, 'utf8').trim();
        if (pid) await shellExec('kill -9 ' + pid + ' 2>/dev/null');
    } catch (e) { /* no pid file */ }

    // Wait for interface to go down
    for (var w = 0; w < 5; w++) {
        var exists = await shellExec('ip link show ' + iface + ' 2>/dev/null');
        if (!exists) break;
        await sleep(500);
    }
}

async function rebuildMacvlan(id, iface) {
    var nic = iface || DEFAULT_INTERFACE;
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
        await shellExec('ip link add link ' + nic + ' ' + macvlan + ' type macvlan mode bridge');
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
    isPrivateIP,
    PORTS_PER_SESSION
};
