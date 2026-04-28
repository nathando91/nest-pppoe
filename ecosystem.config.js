module.exports = {
  apps: [{
    name: 'server',
    script: 'server.js',
    treekill: false,       // Do NOT kill child processes (3proxy, pppd) on restart
    kill_timeout: 3000,    // Wait 3s for graceful shutdown
    listen_timeout: 5000,
    max_memory_restart: '500M'
  }]
};
