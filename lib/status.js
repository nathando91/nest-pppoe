const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { readConfig, PROXIES_FILE, getTotalSessions, getAccountForSession } = require('./config');
const { isPrivateIP, getPppdPid, getProxyPid } = require('./pppoe');

// Helper to get all IPs in one command
function getAllIPs() {
    const ipMap = {};
    try {
        const output = execSync('ip -4 -o addr show', { encoding: 'utf8' });
        const lines = output.split('\n');
        for (const line of lines) {
            // Format: 5: ppp0    inet 1.2.3.4/32 ...
            const match = line.match(/^\d+:\s+([^\s]+)\s+inet\s+([\d.]+)/);
            if (match) {
                ipMap[match[1]] = match[2];
            }
        }
    } catch (e) {}
    return ipMap;
}

// Helper to get all interface states/macs from /sys/class/net
function getAllInterfaceDetails() {
    const details = {};
    try {
        const ifaces = fs.readdirSync('/sys/class/net');
        for (const name of ifaces) {
            try {
                const mac = fs.readFileSync(`/sys/class/net/${name}/address`, 'utf8').trim();
                const state = fs.readFileSync(`/sys/class/net/${name}/operstate`, 'utf8').trim();
                details[name] = { mac, state };
            } catch (e) {
                details[name] = { mac: 'N/A', state: 'unknown' };
            }
        }
    } catch (e) {}
    return details;
}

// Helper to get all listening ports in one command
function getListeningPorts() {
    const ports = new Set();
    try {
        const output = execSync('ss -tlnH', { encoding: 'utf8' });
        const lines = output.split('\n');
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 4) {
                const addr = parts[3];
                const portPart = addr.split(':').pop();
                if (portPart) ports.add(portPart);
            }
        }
    } catch (e) {}
    return ports;
}

function getNetworkInterfaces() {
    const ipMap = getAllIPs();
    const details = getAllInterfaceDetails();
    
    return Object.keys(details)
        .filter(name => !/lo|docker|veth|br-|macppp|ppp/.test(name))
        .map(name => ({
            name,
            mac: details[name].mac,
            state: details[name].state,
            ip: ipMap[name] || ''
        }));
}

function getPPPoEStatus() {
    const config = readConfig();
    const totalSessions = getTotalSessions(config);
    const ipMap = getAllIPs();
    const details = getAllInterfaceDetails();
    const listeningPorts = getListeningPorts();

    let proxyLines = [];
    try {
        proxyLines = fs.readFileSync(PROXIES_FILE, 'utf8').trim().split('\n').filter(Boolean);
    } catch (err) { /* ignore */ }

    const sessions = [];
    for (let i = 0; i < totalSessions; i++) {
        const iface = 'ppp' + i;
        const { account, accountIdx } = getAccountForSession(config, i);

        const ip = ipMap[iface] || '';
        let status = 'stopped';
        let isCgnat = false;
        
        if (ip) {
            if (isPrivateIP(ip)) {
                status = 'cgnat';
                isCgnat = true;
            } else {
                status = 'connected';
            }
        }

        let vipPort = '';
        let ports = [];
        let proxyStatus = 'stopped';

        if (!isCgnat) {
            // Read ports from _active.cfg (source of truth — always written fresh by setupProxy)
            // Falls back to proxies.txt only if active config is missing
            const { getProxyPorts } = require('./pppoe');
            const portInfo = getProxyPorts(i);
            if (portInfo && portInfo.ports && portInfo.ports.length > 0) {
                ports = portInfo.ports.map(String);
                vipPort = portInfo.vipPort || ports[0] || '';
            } else if (proxyLines[i]) {
                // Fallback: proxies.txt (may be stale but better than nothing)
                const parts = proxyLines[i].split(':');
                if (parts.length >= 2) {
                    const portStr = parts.slice(1).join(':');
                    ports = portStr.split(',').map(p => p.trim()).filter(Boolean);
                    vipPort = ports[0] || '';
                }
            }
        }

        // Check if 3proxy is actually running: ALL ports from active config must be listening
        // (not just vipPort, to catch partial-bind failures)
        if (vipPort && listeningPorts.has(vipPort)) {
            proxyStatus = 'running';
        }

        // Get physical interface info (from pre-fetched details)
        const macvlan = account.interface || 'N/A';
        const macvlanStatus = (details[macvlan] && details[macvlan].state) || 'down';

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
            accountIdx: accountIdx,
            pid: getPppdPid(i) || null,
            proxyPid: getProxyPid(i) || null
        });
    }

    return sessions;
}

function getSystemStats(providedSessions) {
    const sessions = providedSessions || getPPPoEStatus();
    let pppdCount = 0;
    let proxyCount = 0;

    for (let i = 0; i < sessions.length; i++) {
        if (sessions[i].status === 'connected') pppdCount++;
        if (sessions[i].proxyStatus === 'running') proxyCount++;
    }

    // CPU usage optimization: use quick logic
    let cpuPercent = 0;
    try {
        const topOut = execSync("top -bn1 | grep '^%Cpu' | awk '{print $2+$4}'", { encoding: 'utf8', timeout: 2000 }).trim();
        cpuPercent = parseFloat(topOut) || 0;
    } catch (err) {
        cpuPercent = Math.min(100, (os.loadavg()[0] / os.cpus().length) * 100);
    }

    // Disk usage
    let diskTotal = 0, diskUsed = 0, diskPercent = 0;
    try {
        const dfOut = execSync("df / --output=size,used,pcent -B1 2>/dev/null | tail -1", { encoding: 'utf8' }).trim();
        const dfParts = dfOut.split(/\s+/);
        diskTotal = parseInt(dfParts[0]) || 0;
        diskUsed = parseInt(dfParts[1]) || 0;
        diskPercent = parseInt(dfParts[2]) || 0;
    } catch (err) { /* ignore */ }

    return {
        pppdCount,
        proxyCount,
        uptime: os.uptime(),
        loadAvg: os.loadavg(),
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        cpuCores: os.cpus().length,
        diskTotal,
        diskUsed,
        diskPercent
    };
}

module.exports = {
    getNetworkInterfaces,
    getPPPoEStatus,
    getSystemStats
};

