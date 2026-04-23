const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { readConfig, PROXIES_FILE, getTotalSessions, getAccountForSession } = require('./config');
const { isPrivateIP } = require('./pppoe');

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
    const totalSessions = getTotalSessions(config);

    // Read proxies.txt for port mapping
    // Format: IP:VIP_PORT,PORT2,PORT3,PORT4,PORT5,PORT6
    let proxyLines = [];
    try {
        proxyLines = fs.readFileSync(PROXIES_FILE, 'utf8').trim().split('\n').filter(Boolean);
    } catch (err) { /* ignore */ }

    for (let i = 0; i < totalSessions; i++) {
        const iface = 'ppp' + i;
        const { account, accountIdx } = getAccountForSession(config, i);

        let ip = '';
        let status = 'stopped';
        let vipPort = '';
        let ports = [];
        let proxyStatus = 'stopped';

        // Check if ppp interface exists and has IP
        var isCgnat = false;
        try {
            ip = execSync("ip -4 addr show " + iface + " 2>/dev/null | grep -oP 'inet \\K[\\d.]+'", { encoding: 'utf8' }).trim();
            if (ip) {
                if (isPrivateIP(ip)) {
                    status = 'cgnat';
                    isCgnat = true;
                } else {
                    status = 'connected';
                }
            }
        } catch (err) {
            status = 'stopped';
        }

        // Parse proxy ports from proxies.txt (only if NOT CGNAT — proxy won't work with private IPs)
        if (!isCgnat && proxyLines[i]) {
            const parts = proxyLines[i].split(':');
            if (parts.length >= 2) {
                // Format: IP:port1,port2,port3,port4,port5,port6
                var portStr = parts.slice(1).join(':'); // rejoin in case IP has no extra colons
                ports = portStr.split(',').map(function(p) { return p.trim(); }).filter(Boolean);
                vipPort = ports[0] || '';
            }
        }

        // Check if 3proxy is running (check VIP port)
        if (vipPort) {
            try {
                const check = execSync('ss -tlnH "sport = :' + vipPort + '" 2>/dev/null | head -1', { encoding: 'utf8' }).trim();
                if (check) proxyStatus = 'running';
            } catch (err) { /* ignore */ }
        }

        // Get physical interface info
        let macvlan = account.interface || 'N/A';
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
            vipPort: vipPort,
            ports: ports,
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
    // Count actual connected sessions and running proxies (not raw OS processes)
    let pppdCount = 0, proxyCount = 0;
    try {
        var sessions = getPPPoEStatus();
        for (var s = 0; s < sessions.length; s++) {
            if (sessions[s].status === 'connected') pppdCount++;
            if (sessions[s].proxyStatus === 'running') proxyCount++;
        }
    } catch (err) {
        // Fallback to process count
        try { pppdCount = parseInt(execSync('pgrep -c pppd 2>/dev/null || echo 0', { encoding: 'utf8' }).trim()); } catch (e) {}
        try { proxyCount = parseInt(execSync('pgrep -c 3proxy 2>/dev/null || echo 0', { encoding: 'utf8' }).trim()); } catch (e) {}
    }

    // CPU usage
    let cpuPercent = 0;
    try {
        // Use top in batch mode for quick CPU snapshot
        var topOut = execSync("top -bn1 | grep '^%Cpu' | awk '{print $2+$4}'", { encoding: 'utf8', timeout: 3000 }).trim();
        cpuPercent = parseFloat(topOut) || 0;
    } catch (err) {
        // Fallback: calculate from os.loadavg
        cpuPercent = Math.min(100, (os.loadavg()[0] / os.cpus().length) * 100);
    }

    // Disk usage
    let diskTotal = 0, diskUsed = 0, diskPercent = 0;
    try {
        var dfOut = execSync("df / --output=size,used,pcent -B1 2>/dev/null | tail -1", { encoding: 'utf8' }).trim();
        var dfParts = dfOut.split(/\s+/);
        diskTotal = parseInt(dfParts[0]) || 0;
        diskUsed = parseInt(dfParts[1]) || 0;
        diskPercent = parseInt(dfParts[2]) || 0;
    } catch (err) { /* ignore */ }

    return {
        pppdCount: pppdCount,
        proxyCount: proxyCount,
        uptime: os.uptime(),
        loadAvg: os.loadavg(),
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        cpuCores: os.cpus().length,
        diskTotal: diskTotal,
        diskUsed: diskUsed,
        diskPercent: diskPercent
    };
}

module.exports = {
    getNetworkInterfaces,
    getPPPoEStatus,
    getSystemStats
};
