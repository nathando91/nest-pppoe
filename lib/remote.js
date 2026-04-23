const ioClient = require('socket.io-client');
const http = require('http');
const pty = require('node-pty');
const os = require('os');
const { BASE_DIR, readConfig } = require('./config');

let currentSocket = null;
let localIo = null;
let remoteTerm = null;
let localAuthCookie = '';

function initRemote(io) {
    localIo = io;

    // Hook into local IO to relay events to remote
    const originalEmit = localIo.emit;
    localIo.emit = function(event, payload) {
        originalEmit.apply(localIo, arguments);
        if (currentSocket && currentSocket.connected) {
            currentSocket.emit('worker_event', { event, payload });
        }
    };

    // Initial connection
    refreshRemoteConfig();
}

function refreshRemoteConfig() {
    const config = readConfig();
    const remoteUrl = config.remote_url || 'http://localhost:3001';
    const remoteEnabled = config.remote_enabled !== false; // Default to true for now if not set

    // Close existing connection if any
    if (currentSocket) {
        console.log('🔄 Closing existing remote hub connection...');
        currentSocket.disconnect();
        currentSocket = null;
    }

    if (remoteTerm) {
        remoteTerm.kill();
        remoteTerm = null;
    }

    if (!remoteEnabled) {
        console.log('⚪ Remote hub is disabled');
        return;
    }

    console.log(`🔗 Connecting to remote hub: ${remoteUrl}...`);
    
    const socket = ioClient(remoteUrl, {
        query: { 
            type: 'worker',
            machineId: config.machine_id || 0,
            hostname: os.hostname(),
            password: config.password || ''
        },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000
    });

    currentSocket = socket;

    socket.on('connect', () => {
        console.log('✅ Connected to remote hub as worker');
        autoLoginLocal(config.password || '');
    });

    socket.on('disconnect', () => {
        // console.debug('❌ Disconnected from remote hub');
    });

    // 1. API REQUEST PROXY: Hub -> Nest
    socket.on('api_request', (data) => {
        const { requestId, method, path, query, body, headers } = data;
        const queryString = query ? '?' + new URLSearchParams(query).toString() : '';
        
        const options = {
            hostname: 'localhost',
            port: 3000,
            path: path + queryString,
            method: method,
            headers: {
                ...headers,
                'cookie': localAuthCookie || headers.cookie || ''
            }
        };

        const req = http.request(options, (res) => {
            let resBody = '';
            res.on('data', (chunk) => resBody += chunk);
            res.on('end', () => {
                let parsedBody = resBody;
                try { parsedBody = JSON.parse(resBody); } catch(e) {}
                socket.emit('api_response', {
                    requestId,
                    status: res.statusCode,
                    body: parsedBody
                });
            });
        });

        req.on('error', (err) => {
            socket.emit('api_response', {
                requestId,
                status: 500,
                body: { error: 'Local request failed: ' + err.message }
            });
        });

        if (body && (method === 'POST' || method === 'PUT')) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });

    // 2. TERMINAL BRIDGE: Hub -> Nest (Separate PTY)
    socket.on('remote_terminal_open', (data) => {
        if (remoteTerm) remoteTerm.kill();
        
        const cols = (data && data.cols) || 120;
        const rows = (data && data.rows) || 30;
        
        remoteTerm = pty.spawn('bash', [], {
            name: 'xterm-256color',
            cols: cols,
            rows: rows,
            cwd: BASE_DIR,
            env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
        });

        remoteTerm.onData((data) => {
            socket.emit('terminal_output', data);
        });

        remoteTerm.onExit((ev) => {
            socket.emit('terminal_exit', { code: ev.exitCode });
            remoteTerm = null;
        });
        
        console.log('⚡ Remote PTY spawned (pid ' + remoteTerm.pid + ')');
    });

    socket.on('remote_terminal_input', (data) => {
        if (remoteTerm) remoteTerm.write(data);
    });

    socket.on('remote_terminal_resize', (data) => {
        if (remoteTerm && data && data.cols && data.rows) {
            try { remoteTerm.resize(data.cols, data.rows); } catch (e) {}
        }
    });
}

function autoLoginLocal(password) {
    const postData = JSON.stringify({ password: password || '' });
    const req = http.request({
        hostname: 'localhost',
        port: 3000,
        path: '/api/auth/login',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(postData)
        }
    }, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
            const setCookies = res.headers['set-cookie'] || [];
            for (const cookieStr of setCookies) {
                const match = cookieStr.match(/nest_token=([^;]+)/);
                if (match) {
                    localAuthCookie = 'nest_token=' + match[1];
                    console.log('🔑 Auto-login to local server successful');
                    return;
                }
            }
            try {
                const data = JSON.parse(body);
                if (data.success) console.log('🔑 Local server has no password — open access');
            } catch (e) {}
        });
    });
    req.on('error', (err) => {
        console.error('❌ Auto-login to local server failed:', err.message);
    });
    req.write(postData);
    req.end();
}

function updateHubPassword(newPassword) {
    if (currentSocket && currentSocket.connected) {
        currentSocket.emit('update_password', newPassword || '');
    }
    autoLoginLocal(newPassword);
}

module.exports = { initRemote, refreshRemoteConfig, updateHubPassword };
