const pty = require('node-pty');
const { BASE_DIR } = require('./config');

function setupTerminal(io) {
    io.on('connection', function(socket) {
        console.log('Client connected');

        var term = null;

        socket.on('terminal_open', function(data) {
            if (term) {
                term.kill();
            }
            var cols = (data && data.cols) || 120;
            var rows = (data && data.rows) || 30;
            term = pty.spawn('bash', [], {
                name: 'xterm-256color',
                cols: cols,
                rows: rows,
                cwd: BASE_DIR,
                env: Object.assign({}, process.env, {
                    TERM: 'xterm-256color',
                    COLORTERM: 'truecolor'
                })
            });

            term.onData(function(data) {
                socket.emit('terminal_output', data);
            });

            term.onExit(function(ev) {
                socket.emit('terminal_exit', { code: ev.exitCode });
                term = null;
            });

            console.log('PTY spawned (pid ' + term.pid + ')');
        });

        socket.on('terminal_input', function(data) {
            if (term) {
                term.write(data);
            }
        });

        socket.on('terminal_resize', function(data) {
            if (term && data && data.cols && data.rows) {
                try {
                    term.resize(data.cols, data.rows);
                } catch (e) { /* ignore resize errors */ }
            }
        });

        socket.on('disconnect', function() {
            console.log('Client disconnected');
            if (term) {
                term.kill();
                term = null;
            }
        });
    });
}

module.exports = setupTerminal;
