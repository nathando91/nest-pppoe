const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { readConfig, PROXIES_FILE } = require('./config');

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

module.exports = {
    getNetworkInterfaces,
    getPPPoEStatus,
    getSystemStats
};
