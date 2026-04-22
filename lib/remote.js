const ioClient = require('socket.io-client');
const http = require('http');
const pty = require('node-pty');
const { BASE_DIR, readConfig } = require('./config');

let currentSocket = null;
let localIo = null;
let remoteTerm = null;

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
        query: { type: 'worker' },
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 2000
    });

    currentSocket = socket;

    socket.on('connect', () => {
        console.log('✅ Connected to remote hub as worker');
    });

    socket.on('disconnect', () => {
        console.warn('❌ Disconnected from remote hub');
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
                'x-internal-secret': 'remote-proxy'
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

module.exports = { initRemote, refreshRemoteConfig };
