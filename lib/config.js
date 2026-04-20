const fs = require('fs');
const path = require('path');

const BASE_DIR = path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const PROXIES_FILE = path.join(BASE_DIR, 'proxies.txt');
const IP_FILE = path.join(BASE_DIR, 'IP.txt');
const BLACKLIST_FILE = path.join(BASE_DIR, 'blacklist.txt');
const PROXY_DIR = path.join(BASE_DIR, 'proxy');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const DEFAULT_INTERFACE = 'enp1s0f0';

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

// Get total number of sessions from all accounts' max_session
function getTotalSessions(config) {
    if (!config) config = readConfig();
    if (!config.pppoe || config.pppoe.length === 0) return 0;
    var total = 0;
    for (var i = 0; i < config.pppoe.length; i++) {
        total += config.pppoe[i].max_session || 30;
    }
    return total;
}

// Get account info for a given session index
function getAccountForSession(config, sessionIdx) {
    if (!config.pppoe) return { account: {}, accountIdx: 0 };
    var offset = 0;
    for (var i = 0; i < config.pppoe.length; i++) {
        var maxSess = config.pppoe[i].max_session || 30;
        if (sessionIdx < offset + maxSess) {
            return { account: config.pppoe[i], accountIdx: i };
        }
        offset += maxSess;
    }
    return { account: {}, accountIdx: 0 };
}

// Get interface for a given session index
function getInterfaceForSession(config, sessionIdx) {
    var info = getAccountForSession(config, sessionIdx);
    return info.account.interface || DEFAULT_INTERFACE;
}

module.exports = {
    BASE_DIR,
    CONFIG_FILE,
    PROXIES_FILE,
    IP_FILE,
    BLACKLIST_FILE,
    PROXY_DIR,
    LOG_DIR,
    DEFAULT_INTERFACE,
    readConfig,
    writeConfig,
    getTotalSessions,
    getAccountForSession,
    getInterfaceForSession
};
