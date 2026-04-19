// ============================================
// Nest PPPoE Manager - Frontend Application
// ============================================

const socket = io();

let currentFilter = 'all';
let sessionsData = [];
let busyActions = new Map(); // Track buttons in loading state: key -> timestamp
const BUSY_TIMEOUT_MS = 60000; // Auto-clear loading after 60 seconds
let checkResults = new Map(); // Track TCP check results: id -> {ok, latency, error, time}

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
    loadRotationQueue();
    loadBlacklistUI();
    setupTabs();

    // Enter key on blacklist input
    var blInput = document.getElementById('blacklistInput');
    if (blInput) blInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') addBlacklistDomain(); });
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

function getStatusBadge(status) {
    switch (status) {
        case 'connected': return '● ONLINE';
        case 'rotating': return '🔄 ROTATING';
        case 'connecting': return '⏳ CONNECTING';
        case 'stopping': return '⏳ STOPPING';
        default: return '○ OFFLINE';
    }
}

function getStatusClass(status) {
    if (status === 'rotating' || status === 'connecting') return 'rotating';
    if (status === 'stopping') return 'stopping';
    return status;
}

// Countdown timer - small inline badge
function renderCountdownBadge(nextRetryAt) {
    var remaining = Math.max(0, Math.floor((nextRetryAt - Date.now()) / 1000));
    return '<span class="countdown-badge" data-next-retry="' + nextRetryAt + '">⏱' + remaining + 's</span>';
}

// Tick countdowns every second
setInterval(function() {
    document.querySelectorAll('.countdown-badge[data-next-retry]').forEach(function(el) {
        var remaining = Math.max(0, Math.floor((parseInt(el.dataset.nextRetry) - Date.now()) / 1000));
        el.textContent = '⏱' + remaining + 's';
    });
}, 1000);

function renderSessionCard(s) {
    const isBusyState = isBusy(`session-${s.id}`) || ['rotating', 'connecting', 'stopping'].includes(s.status);
    const statusClass = getStatusClass(s.status);
    const stepMsg = s.message || '';
    const ports = s.ports || [];
    const vipPort = s.vipPort || '';
    const regularPorts = ports.length > 1 ? ports.slice(1) : [];

    // Build ports display
    var portsHtml = '';
    if (vipPort || regularPorts.length > 0) {
        portsHtml = '<div class="session-ports">';
        if (vipPort) {
            portsHtml += '<div class="port-item vip" title="VIP Port"><span class="port-label">★ VIP</span><span class="port-value">' + vipPort + '</span></div>';
        }
        for (var pi = 0; pi < regularPorts.length; pi++) {
            portsHtml += '<div class="port-item" title="Port ' + (pi + 1) + '"><span class="port-label">P' + (pi + 1) + '</span><span class="port-value">' + regularPorts[pi] + '</span></div>';
        }
        portsHtml += '</div>';
    }

    return `
    <div class="session-card ${statusClass}" data-session-id="${s.id}" data-status="${s.status}">
        <div class="session-top">
            <div class="session-id">
                <span class="session-num">${s.iface}</span>
                <span class="session-badge ${statusClass}">${getStatusBadge(s.status)}</span>
            </div>
            ${s.nextRetryAt && s.step === 'waiting' ? renderCountdownBadge(s.nextRetryAt) : ''}
        </div>
        ${stepMsg ? `<div class="session-step">${escapeHtml(stepMsg)}</div>` : ''}
        <div class="session-info">
            <div class="session-field">
                <span class="session-label">IP Address</span>
                <span class="session-value ${s.ip ? 'ip' : 'no-ip'}">${s.ip || '---'}</span>
            </div>
            <div class="session-field">
                <span class="session-label">Account</span>
                <span class="session-value" style="font-size:10px">${escapeHtml(truncate(s.username || '', 22))}</span>
            </div>
        </div>
        ${portsHtml}
        <div class="session-actions">
            ${s.status === 'stopped' ? `
                <button class="session-btn start" onclick="startSession(${s.id})">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                    Start
                </button>
            ` : isBusyState ? `
                <button class="session-btn rotate loading" disabled>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    Đang xử lý...
                </button>
            ` : `
                <button class="session-btn stop" onclick="stopSession(${s.id})">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                    Stop
                </button>
                <button class="session-btn rotate" onclick="rotateSession(${s.id})">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    Xoay IP
                </button>
            `}
            ${s.status !== 'stopped' ? renderCheckButton(s.id) : ''}
        </div>
    </div>`;
}

function renderSessions(sessions) {
    const grid = document.getElementById('sessionsGrid');
    const filtered = sessions.filter(s => {
        if (currentFilter === 'connected') return s.status === 'connected' || s.status === 'rotating' || s.status === 'connecting';
        if (currentFilter === 'stopped') return s.status === 'stopped' || s.status === 'stopping';
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

    grid.innerHTML = filtered.map(s => renderSessionCard(s)).join('');
}

// Update a single session card in-place without re-rendering the whole grid
function updateSingleSession(data) {
    // Merge live data into sessionsData
    var idx = sessionsData.findIndex(s => s.id === data.id);
    if (idx !== -1) {
        if (data.ip !== undefined) sessionsData[idx].ip = data.ip;
        if (data.vipPort !== undefined) sessionsData[idx].vipPort = data.vipPort;
        if (data.ports !== undefined) sessionsData[idx].ports = data.ports;
        if (data.status) sessionsData[idx].status = data.status;
        if (data.proxyStatus) sessionsData[idx].proxyStatus = data.proxyStatus;
        sessionsData[idx].message = data.message || '';
        sessionsData[idx].step = data.step || '';
        if (data.nextRetryAt !== undefined) sessionsData[idx].nextRetryAt = data.nextRetryAt;
        // Clear nextRetryAt when step is no longer waiting
        if (data.step && data.step !== 'waiting') sessionsData[idx].nextRetryAt = null;
    }

    // Find the card in the DOM and update it
    var card = document.querySelector('[data-session-id="' + data.id + '"]');
    if (card) {
        var s = idx !== -1 ? sessionsData[idx] : data;
        var temp = document.createElement('div');
        temp.innerHTML = renderSessionCard(s);
        var newCard = temp.firstElementChild;
        card.replaceWith(newCard);
    }
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

// ============ TCP CHECK ============

function renderCheckButton(id) {
    var cr = checkResults.get(id);
    var checking = isBusy('check-' + id);
    if (checking) {
        return '<button class="session-btn check loading" disabled title="Đang kiểm tra..."><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></button>';
    }
    if (cr) {
        var cls = cr.ok ? 'ok' : 'fail';
        var icon = cr.ok ? '✓' : '✗';
        var title = cr.ok ? 'OK - ' + cr.latency + 'ms' : 'FAIL: ' + (cr.error || 'timeout');
        return '<button class="session-btn check ' + cls + '" onclick="checkSession(' + id + ')" title="' + title + '">' + icon + (cr.ok ? ' ' + cr.latency + 'ms' : '') + '</button>';
    }
    return '<button class="session-btn check" onclick="checkSession(' + id + ')" title="Check TCP"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></button>';
}

async function checkSession(id) {
    setBusy('check-' + id);
    // Re-render just this card
    var card = document.querySelector('[data-session-id="' + id + '"]');
    if (card) {
        var s = sessionsData.find(function(x) { return x.id === id; });
        if (s) {
            var temp = document.createElement('div');
            temp.innerHTML = renderSessionCard(s);
            card.replaceWith(temp.firstElementChild);
        }
    }
    try {
        var res = await fetch('/api/session/' + id + '/check');
        var data = await res.json();
        checkResults.set(id, { ok: data.ok, latency: data.latency, error: data.error, time: Date.now() });
    } catch (e) {
        checkResults.set(id, { ok: false, latency: 0, error: e.message, time: Date.now() });
    }
    clearBusy('check-' + id);
    // Re-render card
    var card2 = document.querySelector('[data-session-id="' + id + '"]');
    if (card2) {
        var s2 = sessionsData.find(function(x) { return x.id === id; });
        if (s2) {
            var temp2 = document.createElement('div');
            temp2.innerHTML = renderSessionCard(s2);
            card2.replaceWith(temp2.firstElementChild);
        }
    }
}

async function checkAll() {
    var btn = document.getElementById('btnCheckAll');
    btn.classList.add('loading');
    checkResults.clear();
    renderSessions(sessionsData);
    showToast('🔍 Đang kiểm tra kết nối tất cả proxy...', 'info');
    try {
        var res = await fetch('/api/check-all');
        var data = await res.json();
        // Results will be applied via socket events, but also handle here as fallback
        data.results.forEach(function(r) {
            checkResults.set(r.id, { ok: r.ok, latency: r.latency, error: r.error, time: Date.now() });
        });
        renderSessions(sessionsData);
        showToast('✅ Check hoàn tất: ' + data.passed + '/' + data.total + ' OK', data.passed === data.total ? 'success' : 'warning');
    } catch (e) {
        showToast('❌ Lỗi check: ' + e.message, 'error');
    }
    btn.classList.remove('loading');
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
    const hasFail = data.output && (data.output.includes('FAIL') || data.output.includes('ERROR'));
    const hasSuccess = data.output && (data.output.includes('✅') || data.output.includes('Stopped'));
    if (hasOK || hasSuccess) {
        showToast(`✅ ppp${data.id} hoạt động`, 'success');
    } else if (hasFail) {
        showToast(`❌ ppp${data.id} thất bại`, 'error');
    }
    // Fetch fresh data to sync everything
    refreshStatus();
});

socket.on('session_live_update', (data) => {
    // Real-time step-by-step update for a single session card
    updateSingleSession(data);
});

socket.on('status_update', (data) => {
    cleanStaleBusy(); // Auto-clear any stuck loading states
    // Preserve live state for sessions that are currently rotating/connecting/stopping
    data.sessions.forEach((s, i) => {
        var existing = sessionsData.find(e => e.id === s.id);
        if (existing && ['rotating', 'connecting', 'stopping'].includes(existing.status)) {
            data.sessions[i] = existing; // Keep the live state
        }
    });
    sessionsData = data.sessions;
    renderSessions(data.sessions);
    updateStats(data.stats);
});

socket.on('check_progress', (data) => {
    data.results.forEach(function(r) {
        checkResults.set(r.id, { ok: r.ok, latency: r.latency, error: r.error, time: Date.now() });
        // Update individual card
        var card = document.querySelector('[data-session-id="' + r.id + '"]');
        if (card) {
            var s = sessionsData.find(function(x) { return x.id === r.id; });
            if (s) {
                var temp = document.createElement('div');
                temp.innerHTML = renderSessionCard(s);
                card.replaceWith(temp.firstElementChild);
            }
        }
    });
});

socket.on('check_complete', (data) => {
    appendTerminal('\n[TCP Check] ' + data.passed + '/' + data.total + ' proxies OK\n', data.passed === data.total ? 'success' : 'warn');
});

socket.on('refresh', () => {
    setTimeout(refreshStatus, 1000);
});

// ============ ROTATION QUEUE ============

socket.on('rotation_queue_update', (data) => {
    renderRotationQueue(data);
});

function renderRotationQueue(entries) {
    var section = document.getElementById('rotationQueueSection');
    var tbody = document.getElementById('rotationQueueBody');
    var countEl = document.getElementById('queueCount');

    if (!entries || entries.length === 0) {
        section.style.display = 'none';
        countEl.textContent = '0';
        return;
    }

    section.style.display = '';
    countEl.textContent = entries.length;

    tbody.innerHTML = entries.map(function(e) {
        var statusClass = 'queue-status-' + e.status.replace('_', '-');
        var statusText = {
            'queued': '⏳ Đang chờ',
            'in_progress': '🔄 Đang xoay',
            'pending_retry': '⏱ Chờ thử lại',
            'success': '✅ Thành công',
            'failed': '❌ Thất bại'
        }[e.status] || e.status;

        var elapsed = '';
        if (e.requestedAt) {
            var secs = Math.floor((Date.now() - e.requestedAt) / 1000);
            if (secs < 60) elapsed = secs + 's';
            else elapsed = Math.floor(secs / 60) + 'm ' + (secs % 60) + 's';
        }

        var nextRetry = '';
        if (e.status === 'pending_retry' && e.nextRetryAt) {
            var remaining = Math.max(0, Math.floor((e.nextRetryAt - Date.now()) / 1000));
            nextRetry = ' (' + remaining + 's)';
        }

        return '<tr class="' + statusClass + '">' +
            '<td><strong>' + e.iface + '</strong></td>' +
            '<td class="mono">' + (e.oldIp || '---') + '</td>' +
            '<td class="mono">' + (e.newIp || '---') + '</td>' +
            '<td><span class="queue-badge ' + statusClass + '">' + statusText + nextRetry + '</span></td>' +
            '<td>' + e.attempts + '</td>' +
            '<td>' + elapsed + '</td>' +
            '<td><button class="btn btn-sm btn-ghost" onclick="removeFromQueue(' + e.id + ')" title="Huỷ">✕</button></td>' +
            '</tr>';
    }).join('');
}

async function removeFromQueue(id) {
    try {
        await fetch('/api/rotation-queue/' + id, { method: 'DELETE' });
    } catch (e) { /* ignore */ }
}

async function clearRotationQueue() {
    try {
        await fetch('/api/rotation-queue', { method: 'DELETE' });
    } catch (e) { /* ignore */ }
}

// Refresh queue on page load
async function loadRotationQueue() {
    try {
        var res = await fetch('/api/rotation-queue');
        var data = await res.json();
        renderRotationQueue(data);
    } catch (e) { /* ignore */ }
}

// Auto-refresh countdown timers in queue table
setInterval(function() {
    var tbody = document.getElementById('rotationQueueBody');
    if (tbody && tbody.children.length > 0) {
        // Re-fetch to update countdown
        loadRotationQueue();
    }
}, 5000);

// ============ BLACKLIST ============

async function loadBlacklistUI() {
    try {
        var res = await fetch('/api/blacklist');
        var domains = await res.json();
        renderBlacklist(domains);
    } catch (e) { /* ignore */ }
}

function renderBlacklist(domains) {
    var list = document.getElementById('blacklistList');
    var actions = document.getElementById('blacklistActions');
    var status = document.getElementById('blacklistStatus');

    if (!domains || domains.length === 0) {
        list.innerHTML = '<div class="blacklist-empty">Chưa có domain nào bị chặn</div>';
        actions.style.display = 'none';
        status.textContent = '';
        return;
    }

    actions.style.display = '';
    status.textContent = domains.length + ' domain đang bị chặn';

    list.innerHTML = domains.map(function(d) {
        return '<div class="blacklist-item">' +
            '<span class="blacklist-domain">' + escapeHtml(d) + '</span>' +
            '<button class="blacklist-remove" onclick="removeBlacklistDomain(\'' + escapeHtml(d) + '\')" title="Xóa">✕</button>' +
            '</div>';
    }).join('');
}

async function addBlacklistDomain() {
    var input = document.getElementById('blacklistInput');
    var raw = input.value.trim();
    if (!raw) return;

    // Parse: comma, newline, space separated
    var domains = raw.split(/[,\n\s]+/).map(function(d) { return d.trim(); }).filter(Boolean);
    if (domains.length === 0) return;

    input.value = '';
    document.getElementById('blacklistStatus').textContent = '⏳ Đang thêm...';

    try {
        var res = await fetch('/api/blacklist', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domains: domains })
        });
        var data = await res.json();
        renderBlacklist(data.domains);
        showToast('✅ Đã thêm ' + domains.length + ' domain vào blacklist', 'success');
    } catch (e) {
        showToast('❌ Lỗi thêm blacklist', 'error');
    }
}

async function removeBlacklistDomain(domain) {
    try {
        var res = await fetch('/api/blacklist', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domains: [domain] })
        });
        var data = await res.json();
        renderBlacklist(data.domains);
        showToast('Đã xóa ' + domain, 'success');
    } catch (e) {
        showToast('❌ Lỗi xóa', 'error');
    }
}

async function clearBlacklist() {
    if (!confirm('Xóa tất cả domain khỏi blacklist?')) return;
    try {
        var res = await fetch('/api/blacklist', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        var data = await res.json();
        renderBlacklist(data.domains);
        showToast('✅ Đã xóa tất cả blacklist', 'success');
    } catch (e) {
        showToast('❌ Lỗi', 'error');
    }
}

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
