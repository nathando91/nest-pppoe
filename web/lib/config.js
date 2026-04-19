const fs = require('fs');
const path = require('path');

const BASE_DIR = '/root/nest';
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const PROXIES_FILE = path.join(BASE_DIR, 'proxies.txt');
const PROXY_DIR = path.join(BASE_DIR, 'proxy');
const LOG_DIR = path.join(BASE_DIR, 'logs');
const INTERFACE = 'enp1s0f0';

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

module.exports = {
    BASE_DIR,
    CONFIG_FILE,
    PROXIES_FILE,
    PROXY_DIR,
    LOG_DIR,
    INTERFACE,
    readConfig,
    writeConfig
};
