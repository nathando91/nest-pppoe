// ============================================
// Nest PPPoE Manager - Frontend Application
// ============================================

const socket = io();

let currentFilter = 'all';
let sessionsData = [];
let busyActions = new Map(); // Track buttons in loading state: key -> timestamp
const BUSY_TIMEOUT_MS = 60000; // Auto-clear loading after 60 seconds

function setBusy(key) {
    busyActions.set(key, Date.now());
}

function clearBusy(key) {
    busyActions.delete(key);
}

function isBusy(key) {
    if (!busyActions.has(key)) return false;
    // Auto-expire stale entries
    if (Date.now() - busyActions.get(key) > BUSY_TIMEOUT_MS) {
        busyActions.delete(key);
        return false;
    }
    return true;
}

function cleanStaleBusy() {
    var now = Date.now();
    busyActions.forEach(function(ts, key) {
        if (now - ts > BUSY_TIMEOUT_MS) {
            busyActions.delete(key);
        }
    });
}

// ============ INITIALIZATION ============

document.addEventListener('DOMContentLoaded', () => {
    loadConfig();
    loadInterfaces();
    refreshStatus();
    setupTabs();
});

// ============ TAB NAVIGATION ============

function setupTabs() {
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            tab.classList.add('active');
            document.getElementById(`${target}Tab`).classList.add('active');
        });
    });
}

// ============ CONFIG ============

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const config = await res.json();
        document.getElementById('configDeviceCode').value = config.device_code || '';
        document.getElementById('deviceCode').textContent = config.device_code || 'N/A';
        renderAccounts(config.pppoe || []);
    } catch (e) {
        console.error('Load config error:', e);
    }
}

function renderAccounts(accounts) {
    const container = document.getElementById('accountsList');
    if (accounts.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding:30px">
                <div class="empty-state-icon">📋</div>
                <h3>Chưa có account nào</h3>
                <p>Thêm account PPPoE để bắt đầu.</p>
            </div>`;
        return;
    }

    container.innerHTML = accounts.map((acc, idx) => `
        <div class="account-card" id="account-${idx}">
            <div class="account-idx">${idx + 1}</div>
            <div class="account-fields">
                <input type="text" class="account-input" placeholder="Username" value="${escapeHtml(acc.username || '')}" 
                    data-field="username" data-idx="${idx}">
                <input type="text" class="account-input" placeholder="Password" value="${escapeHtml(acc.password || '')}"
                    data-field="password" data-idx="${idx}">
            </div>
            <div class="account-info">→ 30 sessions</div>
            <button class="account-delete" onclick="removeAccount(${idx})" title="Xóa account">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');
}

function addAccount() {
    const accounts = getAccountsFromForm();
    accounts.push({ username: '', password: '' });
    renderAccounts(accounts);
    // Focus new username input
    setTimeout(() => {
        const inputs = document.querySelectorAll('.account-input[data-field="username"]');
        if (inputs.length > 0) inputs[inputs.length - 1].focus();
    }, 100);
}

function removeAccount(idx) {
    const accounts = getAccountsFromForm();
    accounts.splice(idx, 1);
    renderAccounts(accounts);
}

function getAccountsFromForm() {
    const accounts = [];
    document.querySelectorAll('.account-card').forEach(card => {
        const username = card.querySelector('[data-field="username"]').value;
        const password = card.querySelector('[data-field="password"]').value;
        accounts.push({ username, password });
    });
    return accounts;
}

async function saveConfig() {
    const config = {
        device_code: document.getElementById('configDeviceCode').value,
        pppoe: getAccountsFromForm()
    };

    try {
        const res = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        const data = await res.json();
        if (data.success) {
            showToast('Đã lưu cấu hình thành công!', 'success');
            document.getElementById('deviceCode').textContent = config.device_code;
        } else {
            showToast('Lỗi lưu cấu hình: ' + (data.error || ''), 'error');
        }
    } catch (e) {
        showToast('Lỗi kết nối server', 'error');
    }
}

function importConfig() {
    const textarea = document.getElementById('configJson');
    try {
        const config = JSON.parse(textarea.value);
        if (!config.pppoe || !Array.isArray(config.pppoe)) {
            showToast('JSON không hợp lệ: thiếu mảng pppoe', 'error');
            return;
        }
        document.getElementById('configDeviceCode').value = config.device_code || '';
        renderAccounts(config.pppoe);
        showToast(`Đã import ${config.pppoe.length} account`, 'success');
        textarea.value = '';
    } catch (e) {
        showToast('JSON không hợp lệ: ' + e.message, 'error');
    }
}

async function saveAndInstall() {
    await saveConfig();
    setTimeout(() => runInstall(), 500);
}

// ============ NETWORK INTERFACES ============

async function loadInterfaces() {
    try {
        const res = await fetch('/api/interfaces');
        const ifaces = await res.json();
        renderInterfaces(ifaces);
    } catch (e) {
        console.error('Load interfaces error:', e);
    }
}

function renderInterfaces(ifaces) {
    const grid = document.getElementById('nicGrid');
    if (ifaces.length === 0) {
        grid.innerHTML = '<div class="empty-state"><p>Không tìm thấy network interfaces</p></div>';
        return;
    }

    grid.innerHTML = ifaces.map(nic => `
        <div class="nic-card">
            <div class="nic-icon ${nic.state === 'up' ? 'up' : 'down'}">
                ${nic.state === 'up' ? '🟢' : '🔴'}
            </div>
            <div class="nic-info">
                <div class="nic-name">${escapeHtml(nic.name)}</div>
                <div class="nic-detail">${escapeHtml(nic.mac)}</div>
                ${nic.ip ? `<div class="nic-detail" style="color:var(--green-400)">${escapeHtml(nic.ip)}</div>` : ''}
            </div>
            <span class="nic-status ${nic.state === 'up' ? 'up' : 'down'}">${nic.state}</span>
        </div>
    `).join('');
}

// ============ SESSIONS ============

async function refreshStatus() {
    try {
        const [sessionsRes, statsRes] = await Promise.all([
            fetch('/api/sessions'),
            fetch('/api/stats')
        ]);
        sessionsData = await sessionsRes.json();
        const stats = await statsRes.json();
        renderSessions(sessionsData);
        updateStats(stats);
    } catch (e) {
        console.error('Refresh error:', e);
    }
}

function renderSessions(sessions) {
    const grid = document.getElementById('sessionsGrid');
    const filtered = sessions.filter(s => {
        if (currentFilter === 'connected') return s.status === 'connected';
        if (currentFilter === 'stopped') return s.status === 'stopped';
        return true;
    });

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column: 1/-1">
                <div class="empty-state-icon">📡</div>
                <h3>Chưa có session nào</h3>
                <p>Cấu hình account PPPoE và chạy Install để tạo sessions.</p>
            </div>`;
        return;
    }

    grid.innerHTML = filtered.map(s => {
        const isBusyState = isBusy(`session-${s.id}`);
        return `
        <div class="session-card ${s.status}" data-session-id="${s.id}" data-status="${s.status}">
            <div class="session-top">
                <div class="session-id">
                    <span class="session-num">${s.iface}</span>
                    <span class="session-badge ${s.status}">${s.status === 'connected' ? '● ONLINE' : '○ OFFLINE'}</span>
                </div>
            </div>
            <div class="session-info">
                <div class="session-field">
                    <span class="session-label">IP Address</span>
                    <span class="session-value ${s.ip ? 'ip' : 'no-ip'}">${s.ip || '---'}</span>
                </div>
                <div class="session-field">
                    <span class="session-label">Proxy Port</span>
                    <span class="session-value">${s.port || '---'}</span>
                </div>
                <div class="session-field">
                    <span class="session-label">Account</span>
                    <span class="session-value" style="font-size:10px">${escapeHtml(truncate(s.username, 22))}</span>
                </div>
                <div class="session-field">
                    <span class="session-label">Proxy</span>
                    <span class="session-value ${s.proxyStatus === 'running' ? 'ip' : 'no-ip'}">${s.proxyStatus}</span>
                </div>
            </div>
            <div class="session-actions">
                ${s.status === 'stopped' ? `
                    <button class="session-btn start ${isBusyState ? 'loading' : ''}" onclick="startSession(${s.id})" ${isBusyState ? 'disabled' : ''}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        Start
                    </button>
                ` : `
                    <button class="session-btn stop ${isBusyState ? 'loading' : ''}" onclick="stopSession(${s.id})" ${isBusyState ? 'disabled' : ''}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                        Stop
                    </button>
                    <button class="session-btn rotate ${isBusyState ? 'loading' : ''}" onclick="rotateSession(${s.id})" ${isBusyState ? 'disabled' : ''}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                        Xoay IP
                    </button>
                `}
            </div>
        </div>`;
    }).join('');
}

function filterSessions(filter) {
    currentFilter = filter;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.filter === filter);
    });
    renderSessions(sessionsData);
}

function updateStats(stats) {
    document.getElementById('statPppd').textContent = stats.pppdCount || '0';
    document.getElementById('statProxy').textContent = stats.proxyCount || '0';
    document.getElementById('statLoad').textContent = (stats.loadAvg?.[0] || 0).toFixed(1);
}

// ============ ACTIONS ============

async function runInstall() {
    const btn = document.getElementById('btnInstall');
    btn.classList.add('loading');
    showToast('🔧 Đang cài đặt cấu hình...', 'info');
    appendTerminal('\n--- INSTALL STARTED ---\n', 'system');

    try {
        await fetch('/api/install', { method: 'POST' });
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
        btn.classList.remove('loading');
    }
}

async function startAll() {
    const btn = document.getElementById('btnStartAll');
    btn.classList.add('loading');
    showToast('🚀 Đang khởi động tất cả sessions...', 'info');
    appendTerminal('\n--- START ALL STARTED ---\n', 'system');

    try {
        await fetch('/api/start-all', { method: 'POST' });
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
        btn.classList.remove('loading');
    }
}

async function stopAll() {
    const btn = document.getElementById('btnStopAll');
    btn.classList.add('loading');
    showToast('⏹ Đang dừng tất cả sessions...', 'info');
    appendTerminal('\n--- STOP ALL STARTED ---\n', 'system');

    try {
        await fetch('/api/stop-all', { method: 'POST' });
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
        btn.classList.remove('loading');
    }
}

async function startSession(id) {
    setBusy(`session-${id}`);
    renderSessions(sessionsData);
    showToast(`▶ Đang khởi động ppp${id}...`, 'info');

    try {
        await fetch(`/api/session/${id}/start`, { method: 'POST' });
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
        clearBusy(`session-${id}`);
        renderSessions(sessionsData);
    }
}

async function stopSession(id) {
    setBusy(`session-${id}`);
    renderSessions(sessionsData);
    showToast(`⏹ Đang dừng ppp${id}...`, 'info');

    try {
        await fetch(`/api/session/${id}/stop`, { method: 'POST' });
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
        clearBusy(`session-${id}`);
        renderSessions(sessionsData);
    }
}

async function rotateSession(id) {
    setBusy(`session-${id}`);
    renderSessions(sessionsData);
    showToast(`🔄 Đang xoay IP ppp${id}...`, 'info');

    try {
        await fetch(`/api/session/${id}/rotate`, { method: 'POST' });
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
        clearBusy(`session-${id}`);
        renderSessions(sessionsData);
    }
}

// ============ SOCKET.IO EVENTS ============

socket.on('install_log', (data) => {
    appendTerminal(data, 'default');
});

socket.on('install_complete', (data) => {
    document.getElementById('btnInstall').classList.remove('loading');
    if (data.code === 0) {
        showToast('✅ Cài đặt hoàn tất!', 'success');
        appendTerminal('\n--- INSTALL COMPLETE ✅ ---\n', 'success');
    } else {
        showToast('❌ Cài đặt thất bại', 'error');
        appendTerminal('\n--- INSTALL FAILED ❌ ---\n', 'error');
    }
});

socket.on('start_log', (data) => {
    appendTerminal(data, 'default');
});

socket.on('start_complete', (data) => {
    document.getElementById('btnStartAll').classList.remove('loading');
    if (data.code === 0) {
        showToast('✅ Tất cả sessions đã khởi động!', 'success');
        appendTerminal('\n--- START ALL COMPLETE ✅ ---\n', 'success');
    } else {
        showToast('⚠️ Start hoàn tất (có lỗi)', 'warning');
        appendTerminal('\n--- START ALL COMPLETE (with errors) ---\n', 'warn');
    }
});

socket.on('stop_log', (data) => {
    appendTerminal(data, 'default');
});

socket.on('stop_complete', (data) => {
    document.getElementById('btnStopAll').classList.remove('loading');
    showToast('⏹ Đã dừng tất cả sessions', 'success');
    appendTerminal('\n--- STOP ALL COMPLETE ✅ ---\n', 'success');
});

socket.on('rotate_log', (data) => {
    appendTerminal(`[ppp${data.id}] ${data.data}`, 'default');
});

socket.on('session_update', (data) => {
    clearBusy(`session-${data.id}`);
    const hasOK = data.output && data.output.includes('OK');
    const hasSuccess = data.output && (data.output.includes('✅') || data.output.includes('Stopped'));
    if (hasOK || hasSuccess) {
        showToast(`✅ ppp${data.id} hoạt động`, 'success');
    }
    // Immediately fetch fresh data from server to update IP/port
    refreshStatus();
    // Also refresh again after a short delay to catch late-settling changes
    setTimeout(refreshStatus, 3000);
});

socket.on('status_update', (data) => {
    cleanStaleBusy(); // Auto-clear any stuck loading states
    sessionsData = data.sessions;
    renderSessions(data.sessions);
    updateStats(data.stats);
});

socket.on('refresh', () => {
    setTimeout(refreshStatus, 1000);
});

// ============ UI HELPERS ============

function toggleSection(id) {
    const el = document.getElementById(id);
    el.classList.toggle('collapsed');
    const chevron = el.previousElementSibling?.querySelector('.chevron');
    if (chevron) {
        chevron.style.transform = el.classList.contains('collapsed') ? 'rotate(-90deg)' : '';
    }
}

function appendTerminal(text, type) {
    const terminal = document.getElementById('terminalOutput');
    const span = document.createElement('span');
    if (type === 'system') span.className = 'term-system';
    else if (type === 'success') span.className = 'term-success';
    else if (type === 'error') span.className = 'term-error';
    else if (type === 'warn') span.className = 'term-warn';
    span.textContent = text;
    terminal.appendChild(span);
    terminal.scrollTop = terminal.scrollHeight;

    // Auto-switch to terminal tab when there's output
    const terminalTab = document.getElementById('tabTerminal');
    if (!terminalTab.classList.contains('active')) {
        // Pulse the terminal tab
        terminalTab.style.color = 'var(--amber-400)';
        setTimeout(() => { terminalTab.style.color = ''; }, 2000);
    }
}

function clearTerminal() {
    const terminal = document.getElementById('terminalOutput');
    terminal.innerHTML = '<span class="term-system">Terminal cleared.\n</span>';
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    const icons = {
        success: '✅',
        error: '❌',
        warning: '⚠️',
        info: 'ℹ️'
    };

    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || 'ℹ️'}</span>
        <span>${escapeHtml(message)}</span>
    `;

    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'toastOut 0.3s ease forwards';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function closeModal() {
    document.getElementById('modalOverlay').classList.remove('active');
}

function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '…' : str;
}

// ============ INTERACTIVE CONSOLE (xterm.js) ============

let xterm = null;
let xtermFit = null;
let consoleInitialized = false;

function initConsole() {
    if (consoleInitialized) return;
    if (typeof Terminal === 'undefined') {
        console.error('xterm.js not loaded yet');
        return;
    }

    const container = document.getElementById('consoleContainer');
    if (!container) return;

    xterm = new Terminal({
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 14,
        fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', monospace",
        lineHeight: 1.4,
        theme: {
            background: '#0d0d12',
            foreground: '#e8e8ed',
            cursor: '#a78bfa',
            cursorAccent: '#0d0d12',
            selectionBackground: 'rgba(99, 102, 241, 0.35)',
            selectionForeground: '#ffffff',
            black: '#1e1e28',
            red: '#f87171',
            green: '#4ade80',
            yellow: '#fbbf24',
            blue: '#60a5fa',
            magenta: '#c084fc',
            cyan: '#22d3ee',
            white: '#e8e8ed',
            brightBlack: '#55556a',
            brightRed: '#fca5a5',
            brightGreen: '#86efac',
            brightYellow: '#fde68a',
            brightBlue: '#93c5fd',
            brightMagenta: '#d8b4fe',
            brightCyan: '#67e8f9',
            brightWhite: '#ffffff'
        },
        allowProposedApi: true,
        scrollback: 5000
    });

    // Fit addon
    xtermFit = new FitAddon.FitAddon();
    xterm.loadAddon(xtermFit);

    // Web links addon
    if (typeof WebLinksAddon !== 'undefined') {
        xterm.loadAddon(new WebLinksAddon.WebLinksAddon());
    }

    xterm.open(container);
    xtermFit.fit();

    // Send input to server PTY
    xterm.onData(function(data) {
        socket.emit('terminal_input', data);
    });

    // Receive output from server PTY
    socket.on('terminal_output', function(data) {
        xterm.write(data);
    });

    // PTY exited
    socket.on('terminal_exit', function(data) {
        xterm.writeln('\r\n\x1b[31m[Process exited with code ' + data.code + ']\x1b[0m');
        xterm.writeln('\x1b[90mPress Enter or click Reconnect to start a new session.\x1b[0m');
    });

    // Handle resize
    xterm.onResize(function(size) {
        socket.emit('terminal_resize', { cols: size.cols, rows: size.rows });
    });

    // Window resize → re-fit
    window.addEventListener('resize', function() {
        if (xtermFit && document.getElementById('consoleTab').classList.contains('active')) {
            xtermFit.fit();
        }
    });

    // Open PTY on server
    socket.emit('terminal_open', { cols: xterm.cols, rows: xterm.rows });

    consoleInitialized = true;
    xterm.focus();
}

function reconnectConsole() {
    if (xterm) {
        xterm.clear();
        socket.emit('terminal_open', { cols: xterm.cols, rows: xterm.rows });
        xterm.focus();
        showToast('Console reconnected', 'success');
    }
}

// Override setupTabs to handle console initialization and fit
(function() {
    var origSetupTabs = setupTabs;
    setupTabs = function() {
        origSetupTabs();
        // Re-attach tab click handlers with console logic
        document.querySelectorAll('.tab').forEach(function(tab) {
            tab.addEventListener('click', function() {
                if (tab.dataset.tab === 'console') {
                    // Init on first open or fit on subsequent opens
                    setTimeout(function() {
                        if (!consoleInitialized) {
                            initConsole();
                        } else if (xtermFit) {
                            xtermFit.fit();
                            xterm.focus();
                        }
                    }, 50);
                }
            });
        });
    };
})();
