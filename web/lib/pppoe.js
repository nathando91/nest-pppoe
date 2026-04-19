const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const { PROXY_DIR, PROXIES_FILE, LOG_DIR, INTERFACE } = require('./config');

const execAsync = promisify(exec);

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

module.exports = {
    sleep,
    shellExec,
    getSessionIP,
    getProxyPort,
    killProxy,
    killPppd,
    rebuildMacvlan,
    connectPppoe,
    setupProxy
};
