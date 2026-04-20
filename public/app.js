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

// ============ AUTH ============

async function checkAuth() {
    try {
        var res = await fetch('/api/auth/status');
        var data = await res.json();
        return data;
    } catch (e) { return { authenticated: false, passwordSet: false }; }
}

async function doLogin() {
    var input = document.getElementById('loginCodeInput');
    var errorEl = document.getElementById('loginError');
    var btn = document.getElementById('loginBtn');
    var password = input.value.trim();
    if (!password) { errorEl.textContent = 'Vui lòng nhập mật khẩu'; return; }

    btn.classList.add('loading');
    errorEl.textContent = '';

    try {
        var res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: password })
        });
        var data = await res.json();
        if (data.success) {
            document.getElementById('loginOverlay').classList.remove('active');
            document.getElementById('appHeader').style.display = '';
            document.querySelector('.main').style.display = '';
            document.getElementById('bottomNav').style.display = '';
            initApp();
        } else {
            errorEl.textContent = data.error || 'Mật khẩu không đúng';
            input.value = '';
            input.focus();
        }
    } catch (e) {
        errorEl.textContent = 'Lỗi kết nối server';
    }
    btn.classList.remove('loading');
}

async function doLogout() {
    try {
        await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) { /* ignore */ }
    document.getElementById('loginOverlay').classList.add('active');
    document.getElementById('appHeader').style.display = 'none';
    document.querySelector('.main').style.display = 'none';
    document.getElementById('bottomNav').style.display = 'none';
    document.getElementById('loginCodeInput').value = '';
    document.getElementById('loginCodeInput').focus();
}

// ============ INITIALIZATION ============

document.addEventListener('DOMContentLoaded', async () => {
    // Login input enter key
    var loginInput = document.getElementById('loginCodeInput');
    if (loginInput) loginInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });

    var authResult = await checkAuth();
    if (authResult.authenticated) {
        document.getElementById('loginOverlay').classList.remove('active');
        document.getElementById('appHeader').style.display = '';
        document.querySelector('.main').style.display = '';
        document.getElementById('bottomNav').style.display = '';
        // Show/hide logout based on whether password is set
        var logoutBtn = document.getElementById('btnLogout');
        if (logoutBtn) logoutBtn.style.display = authResult.passwordSet ? '' : 'none';
        initApp();
    } else {
        document.getElementById('loginOverlay').classList.add('active');
        document.querySelector('.main').style.display = 'none';
        document.getElementById('bottomNav').style.display = 'none';
        loginInput.focus();
    }
});

async function initApp() {
    await loadInterfacesForSelect();
    loadConfig();
    await fetchConfigForFarms();
    refreshStatus();
    loadRotationQueue();
    loadBlacklistUI();
    loadIPListUI();
    loadInstallStatus();
    setupTabs();
    renderOverview(null);

    // Enter key on blacklist input
    var blInput = document.getElementById('blacklistInput');
    if (blInput) blInput.addEventListener('keydown', function(e) { if (e.key === 'Enter') addBlacklistDomain(); });
}

// ============ TAB NAVIGATION ============

// Tabs that live inside the "More" menu on mobile
var moreMenuTabs = ['terminal', 'console', 'config'];

function setupTabs() {
    // Top tabs (desktop)
    document.querySelectorAll('.tab').forEach(tab => {
        tab.addEventListener('click', () => {
            switchTab(tab.dataset.tab);
        });
    });

    // Bottom nav items (mobile) - only items with data-tab
    document.querySelectorAll('.bottom-nav-item[data-tab]').forEach(item => {
        item.addEventListener('click', () => {
            switchTab(item.dataset.tab);
        });
    });
}

function switchTab(target) {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    document.querySelectorAll('.bottom-nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.more-menu-item').forEach(m => m.classList.remove('active'));

    // Activate top tab
    var topTab = document.querySelector('.tab[data-tab="' + target + '"]');
    if (topTab) topTab.classList.add('active');

    // Activate bottom nav item or "More" button
    var bnItem = document.querySelector('.bottom-nav-item[data-tab="' + target + '"]');
    if (bnItem) {
        bnItem.classList.add('active');
    } else if (moreMenuTabs.indexOf(target) !== -1) {
        // It's a "More" sub-tab — highlight the More button
        var moreBtn = document.getElementById('bnMore');
        if (moreBtn) moreBtn.classList.add('active');
        // Also highlight the item in the more menu
        var moreItem = document.querySelector('.more-menu-item[data-tab="' + target + '"]');
        if (moreItem) moreItem.classList.add('active');
    }

    // Activate content
    var content = document.getElementById(target + 'Tab');
    if (content) content.classList.add('active');
}

// More menu (mobile)
function toggleMoreMenu(e) {
    if (e) e.stopPropagation();
    var menu = document.getElementById('moreMenu');
    var overlay = document.getElementById('moreMenuOverlay');
    var isOpen = menu.classList.contains('active');
    if (isOpen) {
        closeMoreMenu();
    } else {
        menu.classList.add('active');
        overlay.classList.add('active');
    }
}

function closeMoreMenu() {
    var menu = document.getElementById('moreMenu');
    var overlay = document.getElementById('moreMenuOverlay');
    menu.classList.remove('active');
    overlay.classList.remove('active');
}

function switchFromMore(tab) {
    closeMoreMenu();
    switchTab(tab);
}

// ============ CONFIG ============

async function loadConfig() {
    try {
        const res = await fetch('/api/config');
        const config = await res.json();
        document.getElementById('configDeviceCode').value = config.device_code || '';
        document.getElementById('configPassword').value = config.password || '';
        document.getElementById('deviceCode').textContent = config.device_code || 'N/A';
        renderAccounts(config.pppoe || []);

        // Store auto_start in configCache for renderOverview
        if (!configCache) configCache = config;
        else configCache.auto_start = config.auto_start;

        // Set auto-start toggle state (checkbox is inside overview, may not exist yet)
        var autoCheckbox = document.getElementById('ovAutoStartCheckbox');
        var autoToggle = document.getElementById('autoStartToggle');
        if (autoCheckbox) {
            autoCheckbox.checked = !!config.auto_start;
            if (autoToggle) autoToggle.classList.toggle('active', !!config.auto_start);
        }
    } catch (e) {
        console.error('Load config error:', e);
    }
}

async function savePassword() {
    var pw = document.getElementById('configPassword').value.trim();
    try {
        var res = await fetch('/api/config');
        var config = await res.json();
        config.password = pw;
        var saveRes = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(config)
        });
        var data = await saveRes.json();
        if (data.success) {
            showToast(pw ? '🔒 Đã đặt mật khẩu' : '🔓 Đã xoá mật khẩu — truy cập không cần đăng nhập', 'success');
            // Show/hide logout button
            var logoutBtn = document.getElementById('btnLogout');
            if (logoutBtn) logoutBtn.style.display = pw ? '' : 'none';
        } else {
            showToast('Lỗi lưu: ' + (data.error || ''), 'error');
        }
    } catch (e) {
        showToast('Lỗi kết nối server', 'error');
    }
}

async function toggleAutoStart(enabled) {
    var autoToggle = document.getElementById('autoStartToggle');
    if (autoToggle) autoToggle.classList.toggle('active', enabled);

    try {
        await fetch('/api/auto-start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: enabled })
        });
        showToast(enabled ? '✅ Auto Start đã bật' : '⏹ Auto Start đã tắt', enabled ? 'success' : 'info');
    } catch (e) {
        showToast('Lỗi lưu cấu hình', 'error');
        // Revert checkbox
        var cb = document.getElementById('ovAutoStartCheckbox');
        if (cb) cb.checked = !enabled;
        if (autoToggle) autoToggle.classList.toggle('active', !enabled);
    }
}

let interfacesCache = [];

async function loadInterfacesForSelect() {
    try {
        var res = await fetch('/api/interfaces');
        interfacesCache = await res.json();
    } catch (e) { /* use cached */ }
}

function renderNicSelect(selectedNic, idx) {
    var val = selectedNic || '';
    var options = '<option value="">-- Chọn NIC --</option>';
    for (var i = 0; i < interfacesCache.length; i++) {
        var nic = interfacesCache[i];
        var sel = nic.name === val ? ' selected' : '';
        var stateIcon = nic.state === 'up' ? '🟢' : '🔴';
        options += '<option value="' + escapeHtml(nic.name) + '"' + sel + '>' + stateIcon + ' ' + escapeHtml(nic.name) + '</option>';
    }
    return '<select class="account-input account-input-nic" data-field="interface" data-idx="' + idx + '" title="Network interface">' + options + '</select>';
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
                <input type="number" class="account-input account-input-small" placeholder="Sessions" value="${acc.max_session || 30}"
                    data-field="max_session" data-idx="${idx}" min="1" max="100" title="Số session tối đa">
                ${renderNicSelect(acc.interface, idx)}
            </div>
            <div class="account-info">→ ${acc.max_session || 30} sessions · ${escapeHtml(acc.interface || '(chưa chọn)')}</div>
            <button class="account-delete" onclick="removeAccount(${idx})" title="Xóa account">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');
}

function addAccount() {
    const accounts = getAccountsFromForm();
    accounts.push({ username: '', password: '', max_session: 30, interface: '' });
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
        const maxSession = parseInt(card.querySelector('[data-field="max_session"]').value) || 30;
        const iface = card.querySelector('[data-field="interface"]');
        const ifaceVal = iface ? iface.value.trim() : '';
        var acc = { username, password, max_session: maxSession };
        if (ifaceVal) acc.interface = ifaceVal;
        accounts.push(acc);
    });
    return accounts;
}

async function saveConfig() {
    const config = {
        device_code: document.getElementById('configDeviceCode').value,
        password: document.getElementById('configPassword').value.trim(),
        pppoe: getAccountsFromForm(),
        auto_start: !!(configCache && configCache.auto_start)
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
            configCache = config;
            renderFarms(sessionsData);
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

let configCache = null;

async function fetchConfigForFarms() {
    try {
        var res = await fetch('/api/config');
        configCache = await res.json();
    } catch (e) { /* use cached */ }
    return configCache || { pppoe: [] };
}

function renderFarms(sessions) {
    var container = document.getElementById('farmsContainer');
    if (!configCache || !configCache.pppoe || configCache.pppoe.length === 0) {
        container.innerHTML = `
            <div class="empty-state" style="padding:40px">
                <div class="empty-state-icon">📡</div>
                <h3>Chưa có farm nào</h3>
                <p>Cấu hình account PPPoE trong tab Cài đặt và chạy Install.</p>
            </div>`;
        return;
    }

    var accounts = configCache.pppoe;
    var offset = 0;
    var html = '';

    for (var a = 0; a < accounts.length; a++) {
        var acc = accounts[a];
        var maxSess = acc.max_session || 30;
        var nicName = acc.interface || 'enp1s0f0';

        // Get sessions for this farm
        var farmSessions = [];
        for (var i = offset; i < offset + maxSess && i < sessions.length; i++) {
            farmSessions.push(sessions[i]);
        }

        // Apply filter
        var filtered = farmSessions.filter(function(s) {
            if (currentFilter === 'connected') return s.status === 'connected' || s.status === 'rotating' || s.status === 'connecting';
            if (currentFilter === 'stopped') return s.status === 'stopped' || s.status === 'stopping';
            return true;
        });

        // Count stats
        var online = farmSessions.filter(function(s) { return s.status === 'connected'; }).length;
        var total = farmSessions.length;

        // Check collapsed state
        var isCollapsed = document.querySelector('.farm-card[data-farm="' + a + '"]');
        var collapsed = isCollapsed ? isCollapsed.classList.contains('collapsed') : false;

        html += `
        <div class="farm-card${collapsed ? ' collapsed' : ''}" data-farm="${a}">
            <div class="farm-header" onclick="toggleFarm(${a})">
                <div class="farm-idx">${a + 1}</div>
                <div class="farm-info">
                    <div class="farm-title">
                        ${escapeHtml(acc.username || 'Account ' + (a + 1))}
                        <span class="farm-nic-badge">🔌 ${escapeHtml(nicName)}</span>
                    </div>
                    <div class="farm-subtitle">ppp${offset} — ppp${offset + maxSess - 1} · ${maxSess} sessions</div>
                </div>
                <div class="farm-stats">
                    <div class="farm-stat">
                        <span class="dot dot-online"></span>
                        <span style="color:var(--green-400)">${online}</span>
                    </div>
                    <div class="farm-stat">
                        <span class="dot dot-offline"></span>
                        <span style="color:var(--text-tertiary)">${total - online}</span>
                    </div>
                </div>
                <div class="farm-controls" onclick="event.stopPropagation()">
                    <button class="farm-btn start" onclick="startFarm(${a})" title="Start farm">▶</button>
                    <button class="farm-btn stop" onclick="stopFarm(${a})" title="Stop farm">■</button>
                    <button class="farm-btn check" onclick="checkFarm(${a})" title="Check farm">✓</button>
                </div>
                <svg class="farm-chevron" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="farm-body">
                <div class="farm-toolbar">
                    <div class="session-filters" onclick="event.stopPropagation()">
                        <button class="filter-btn${currentFilter === 'all' ? ' active' : ''}" data-filter="all" onclick="filterSessions('all')">All <span class="filter-count">${total}</span></button>
                        <button class="filter-btn${currentFilter === 'connected' ? ' active' : ''}" data-filter="connected" onclick="filterSessions('connected')">Connected <span class="filter-count">${online}</span></button>
                        <button class="filter-btn${currentFilter === 'stopped' ? ' active' : ''}" data-filter="stopped" onclick="filterSessions('stopped')">Stopped <span class="filter-count">${total - online}</span></button>
                    </div>
                </div>
                <div class="farm-sessions-grid">
                    ${filtered.length > 0 
                        ? filtered.map(function(s) { return renderSessionCard(s); }).join('')
                        : '<div class="empty-state" style="padding:20px;grid-column:1/-1"><p>Không có session nào ' + (currentFilter !== 'all' ? '(' + currentFilter + ')' : '') + '</p></div>'
                    }
                </div>
            </div>
        </div>`;

        offset += maxSess;
    }

    container.innerHTML = html;
}

function toggleFarm(idx) {
    var card = document.querySelector('.farm-card[data-farm="' + idx + '"]');
    if (card) card.classList.toggle('collapsed');
}

async function startFarm(idx) {
    showToast('🚀 Đang khởi động farm ' + (idx + 1) + '...', 'info');
    try { await fetch('/api/farm/' + idx + '/start', { method: 'POST' }); } catch(e) {}
}

async function stopFarm(idx) {
    showToast('⏹ Đang dừng farm ' + (idx + 1) + '...', 'info');
    try { await fetch('/api/farm/' + idx + '/stop', { method: 'POST' }); } catch(e) {}
}

async function checkFarm(idx) {
    showToast('🔍 Đang kiểm tra farm ' + (idx + 1) + '...', 'info');
    try {
        var res = await fetch('/api/farm/' + idx + '/check');
        var data = await res.json();
        if (data.results) {
            data.results.forEach(function(r) {
                checkResults.set(r.id, { ok: r.ok, latency: r.latency, error: r.error, time: Date.now() });
            });
        }
        showToast('Farm ' + (idx + 1) + ': ' + data.passed + '/' + data.total + ' OK', data.passed === data.total ? 'success' : 'warning');
        renderFarms(sessionsData);
    } catch(e) {}
}

// Keep renderSessions as alias for backward compat
function renderSessions(sessions) {
    renderFarms(sessions);
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
    renderFarms(sessionsData);
}

function formatUptime(seconds) {
    var d = Math.floor(seconds / 86400);
    var h = Math.floor((seconds % 86400) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
}

function formatUptimeLong(seconds) {
    var d = Math.floor(seconds / 86400);
    var h = Math.floor((seconds % 86400) / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var parts = [];
    if (d > 0) parts.push(d + ' ngày');
    if (h > 0) parts.push(h + ' giờ');
    parts.push(m + ' phút');
    return parts.join(' ');
}

function formatBytes(bytes) {
    if (bytes === 0) return '0';
    var gb = bytes / (1024 * 1024 * 1024);
    if (gb >= 1) return gb.toFixed(1) + 'G';
    var mb = bytes / (1024 * 1024);
    return mb.toFixed(0) + 'M';
}

function updateStats(stats) {
    // All stats are now in the overview dashboard
    renderOverview(stats);
}

// ============ SYSTEM OVERVIEW DASHBOARD ============

var lastStats = null;

function renderOverview(stats) {
    if (stats) lastStats = stats;
    if (!lastStats) return;
    var s = lastStats;

    var cpuPercent = s.cpuPercent || 0;
    var totalMem = s.totalMem || 1;
    var freeMem = s.freeMem || 0;
    var usedMem = totalMem - freeMem;
    var ramPercent = Math.round((usedMem / totalMem) * 100);
    var diskPercent = s.diskPercent || 0;
    var uptime = s.uptime || 0;
    var pppdCount = s.pppdCount || 0;
    var proxyCount = s.proxyCount || 0;
    var cpuCores = s.cpuCores || 1;
    var loadAvg = s.loadAvg || [0, 0, 0];

    // Total sessions from configCache
    var totalSessions = 0;
    var totalFarms = 0;
    if (configCache && configCache.pppoe) {
        totalFarms = configCache.pppoe.length;
        for (var i = 0; i < configCache.pppoe.length; i++) {
            totalSessions += configCache.pppoe[i].max_session || 30;
        }
    }

    // Connected sessions from sessionsData
    var connectedSessions = 0;
    var stoppedSessions = 0;
    if (sessionsData && sessionsData.length > 0) {
        sessionsData.forEach(function(sess) {
            if (sess.status === 'connected') connectedSessions++;
            else if (sess.status === 'stopped') stoppedSessions++;
        });
    }

    function getBarColor(pct) {
        if (pct > 85) return 'var(--red-400)';
        if (pct > 60) return 'var(--amber-400)';
        return 'var(--green-400)';
    }

    function getBarGradient(type) {
        if (type === 'cpu') return 'linear-gradient(90deg, #22c55e, #fbbf24)';
        if (type === 'ram') return 'linear-gradient(90deg, #818cf8, #c084fc)';
        if (type === 'disk') return 'linear-gradient(90deg, #22d3ee, #60a5fa)';
        return 'var(--indigo-400)';
    }

    var grid = document.getElementById('overviewGrid');
    if (!grid) return;

    // Auto Start checkbox state
    var autoChecked = '';
    try {
        var cb = document.getElementById('ovAutoStartCheckbox');
        if (cb && cb.checked) autoChecked = ' checked';
        // On first load, use configCache
        if (!cb && configCache && configCache.auto_start) autoChecked = ' checked';
    } catch(e) {}

    grid.innerHTML = `
        <div class="ov-row ov-row-controls">
            <div class="ov-card ov-card-controls">
                <div class="ov-controls-bar">
                    <button class="ov-ctrl-btn ov-ctrl-start" onclick="confirmStartAll()" id="btnStartAll" title="Start All">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                        Start All
                    </button>
                    <button class="ov-ctrl-btn ov-ctrl-stop" onclick="confirmStopAll()" id="btnStopAll" title="Stop All">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
                        Stop All
                    </button>
                    <button class="ov-ctrl-btn ov-ctrl-refresh" onclick="refreshStatus()" id="btnRefresh" title="Refresh">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
                        Refresh
                    </button>
                    <button class="ov-ctrl-btn ov-ctrl-check" onclick="checkAll()" id="btnCheckAll" title="Check All">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
                        Check All
                    </button>
                    <div class="ov-ctrl-divider"></div>
                    <div class="auto-start-toggle" id="autoStartToggle">
                        <label class="toggle-switch">
                            <input type="checkbox" id="ovAutoStartCheckbox" onchange="toggleAutoStart(this.checked)"${autoChecked}>
                            <span class="toggle-slider"></span>
                        </label>
                        <span class="toggle-label">Auto Start</span>
                    </div>
                </div>
            </div>
        </div>

        <div class="ov-row ov-row-top">
            <div class="ov-card ov-card-uptime">
                <div class="ov-card-icon uptime-icon">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                </div>
                <div class="ov-card-body">
                    <div class="ov-card-label">Uptime</div>
                    <div class="ov-card-value">${formatUptimeLong(uptime)}</div>
                </div>
            </div>
            <div class="ov-card ov-card-device">
                <div class="ov-card-icon device-icon-ov">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
                </div>
                <div class="ov-card-body">
                    <div class="ov-card-label">Device</div>
                    <div class="ov-card-value" style="font-size:18px">${escapeHtml((configCache && configCache.device_code) || 'N/A')}</div>
                    <div class="ov-card-sub">${cpuCores} CPU cores · Load: ${loadAvg[0].toFixed(2)}</div>
                </div>
            </div>
        </div>

        <div class="ov-row ov-row-metrics">
            <div class="ov-card ov-card-metric">
                <div class="ov-metric-header">
                    <span class="ov-metric-icon">⚡</span>
                    <span class="ov-metric-label">CPU</span>
                    <span class="ov-metric-value" style="color:${getBarColor(cpuPercent)}">${cpuPercent.toFixed(1)}%</span>
                </div>
                <div class="ov-progress-bar">
                    <div class="ov-progress-fill" style="width:${Math.min(100, cpuPercent)}%;background:${getBarGradient('cpu')}"></div>
                </div>
                <div class="ov-metric-detail">${cpuCores} cores · Load avg: ${loadAvg[0].toFixed(2)}, ${loadAvg[1].toFixed(2)}, ${loadAvg[2].toFixed(2)}</div>
            </div>
            <div class="ov-card ov-card-metric">
                <div class="ov-metric-header">
                    <span class="ov-metric-icon">🧠</span>
                    <span class="ov-metric-label">RAM</span>
                    <span class="ov-metric-value" style="color:${getBarColor(ramPercent)}">${ramPercent}%</span>
                </div>
                <div class="ov-progress-bar">
                    <div class="ov-progress-fill" style="width:${ramPercent}%;background:${getBarGradient('ram')}"></div>
                </div>
                <div class="ov-metric-detail">${formatBytes(usedMem)} / ${formatBytes(totalMem)} sử dụng</div>
            </div>
            <div class="ov-card ov-card-metric">
                <div class="ov-metric-header">
                    <span class="ov-metric-icon">💾</span>
                    <span class="ov-metric-label">Disk</span>
                    <span class="ov-metric-value" style="color:${getBarColor(diskPercent)}">${diskPercent}%</span>
                </div>
                <div class="ov-progress-bar">
                    <div class="ov-progress-fill" style="width:${diskPercent}%;background:${getBarGradient('disk')}"></div>
                </div>
                <div class="ov-metric-detail">${s.diskUsed ? formatBytes(s.diskUsed) : '?'} / ${s.diskTotal ? formatBytes(s.diskTotal) : '?'} sử dụng</div>
            </div>
        </div>

        <div class="ov-row ov-row-services">
            <div class="ov-card ov-card-service ov-service-pppoe">
                <div class="ov-service-ring">
                    <svg class="ov-ring-svg" viewBox="0 0 64 64">
                        <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="5"/>
                        <circle cx="32" cy="32" r="28" fill="none" stroke="url(#gradPppoe)" stroke-width="5" stroke-linecap="round"
                            stroke-dasharray="${totalSessions > 0 ? (connectedSessions / totalSessions) * 175.9 : 0} 175.9"
                            transform="rotate(-90 32 32)" class="ov-ring-progress"/>
                        <defs><linearGradient id="gradPppoe" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#4ade80"/><stop offset="1" stop-color="#22c55e"/></linearGradient></defs>
                    </svg>
                    <div class="ov-ring-center">
                        <span class="ov-ring-num">${pppdCount}</span>
                    </div>
                </div>
                <div class="ov-service-info">
                    <div class="ov-service-title">PPPoE Sessions</div>
                    <div class="ov-service-detail">
                        <span class="ov-dot dot-green"></span> ${connectedSessions} kết nối
                        <span class="ov-dot dot-offline" style="margin-left:8px"></span> ${stoppedSessions} dừng
                    </div>
                    <div class="ov-service-sub">${totalFarms} farm · ${totalSessions} tổng sessions</div>
                </div>
            </div>
            <div class="ov-card ov-card-service ov-service-proxy">
                <div class="ov-service-ring">
                    <svg class="ov-ring-svg" viewBox="0 0 64 64">
                        <circle cx="32" cy="32" r="28" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="5"/>
                        <circle cx="32" cy="32" r="28" fill="none" stroke="url(#gradProxy)" stroke-width="5" stroke-linecap="round"
                            stroke-dasharray="${totalSessions > 0 ? (proxyCount / totalSessions) * 175.9 : 0} 175.9"
                            transform="rotate(-90 32 32)" class="ov-ring-progress"/>
                        <defs><linearGradient id="gradProxy" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#60a5fa"/><stop offset="1" stop-color="#818cf8"/></linearGradient></defs>
                    </svg>
                    <div class="ov-ring-center">
                        <span class="ov-ring-num">${proxyCount}</span>
                    </div>
                </div>
                <div class="ov-service-info">
                    <div class="ov-service-title">3proxy Instances</div>
                    <div class="ov-service-detail">
                        <span class="ov-dot dot-blue"></span> ${proxyCount} đang chạy
                    </div>
                    <div class="ov-service-sub">${totalSessions > 0 ? Math.round((proxyCount / totalSessions) * 100) : 0}% hoạt động</div>
                </div>
            </div>
        </div>

        <div class="ov-row ov-row-farms-summary">
            <div class="ov-card ov-card-farms-overview">
                <div class="ov-farms-header">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--indigo-400)" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                    <span>Farm Overview</span>
                </div>
                <div class="ov-farms-list" id="overviewFarmsList">
                    ${renderOverviewFarms()}
                </div>
            </div>
        </div>
    `;
}

function renderOverviewFarms() {
    if (!configCache || !configCache.pppoe || configCache.pppoe.length === 0) {
        return '<div class="ov-farms-empty">Chưa có farm nào được cấu hình</div>';
    }
    var accounts = configCache.pppoe;
    var offset = 0;
    var html = '';
    for (var a = 0; a < accounts.length; a++) {
        var acc = accounts[a];
        var maxSess = acc.max_session || 30;
        var nicName = acc.interface || 'enp1s0f0';

        // Count online sessions for this farm
        var online = 0;
        for (var i = offset; i < offset + maxSess && i < sessionsData.length; i++) {
            if (sessionsData[i].status === 'connected') online++;
        }
        var pct = maxSess > 0 ? Math.round((online / maxSess) * 100) : 0;

        html += `
        <div class="ov-farm-row">
            <div class="ov-farm-idx">${a + 1}</div>
            <div class="ov-farm-info">
                <div class="ov-farm-name">${escapeHtml(acc.username || 'Account ' + (a + 1))}</div>
                <div class="ov-farm-detail">🔌 ${escapeHtml(nicName)} · ppp${offset}-ppp${offset + maxSess - 1}</div>
            </div>
            <div class="ov-farm-bar-wrap">
                <div class="ov-farm-bar" style="width:${pct}%"></div>
            </div>
            <div class="ov-farm-stats">
                <span class="ov-farm-online">${online}</span>/<span class="ov-farm-total">${maxSess}</span>
            </div>
        </div>`;
        offset += maxSess;
    }
    return html;
}

// ============ INSTALL STATUS ============

async function loadInstallStatus() {
    try {
        var res = await fetch('/api/install-status');
        var data = await res.json();
        renderInstallStatus(data);
    } catch (e) {
        console.error('Install status error:', e);
    }
}

function renderInstallStatus(data) {
    var badge = document.getElementById('installBadge');
    var badgeIcon = document.getElementById('installBadgeIcon');
    var badgeText = document.getElementById('installBadgeText');
    var details = document.getElementById('installDetails');
    if (!badge || !details) return;

    if (data.installed) {
        badge.className = 'install-status-badge installed';
        badgeIcon.textContent = '✅';
        badgeText.textContent = 'Đã cài đặt (' + data.total + ' sessions)';
    } else {
        badge.className = 'install-status-badge not-installed';
        badgeIcon.textContent = '⚠️';
        badgeText.textContent = 'Chưa cài đặt đầy đủ';
    }

    var items = [
        { label: 'Peer files', count: data.peers.count, total: data.peers.total, icon: '📄' },
        { label: 'Macvlan', count: data.macvlan.count, total: data.macvlan.total, icon: '🔗' },
        { label: '3proxy configs', count: data.proxyConfigs.count, total: data.proxyConfigs.total, icon: '⚙️' },
        { label: 'Credentials', count: data.credentials ? 1 : 0, total: 1, icon: '🔑' }
    ];

    var html = '<div class="install-status-grid">';
    items.forEach(function(item) {
        var ok = item.count === item.total;
        html += '<div class="install-item ' + (ok ? 'ok' : 'missing') + '">' +
            '<span class="install-item-icon">' + item.icon + '</span>' +
            '<span class="install-item-label">' + item.label + '</span>' +
            '<span class="install-item-val">' + item.count + '/' + item.total + '</span>' +
            '</div>';
    });
    html += '</div>';
    details.innerHTML = html;
}

function confirmInstall() {
    showConfirm('🔧', 'Install cấu hình', 'Tạo peer files, macvlan interfaces, 3proxy configs cho tất cả sessions?', 'confirm-btn-green', function() {
        runInstall();
    });
}

function confirmUninstall() {
    showConfirm('🗑️', 'Xoá cấu hình hệ thống', 'Xoá tất cả peer files, macvlan interfaces, 3proxy configs và credentials?', '', function() {
        runUninstall();
    });
}

async function runInstall() {
    var btn = document.getElementById('btnInstall');
    if (btn) btn.classList.add('loading');
    showToast('🔧 Đang cài đặt cấu hình...', 'info');
    appendTerminal('\n--- INSTALL STARTED ---\n', 'system');

    try {
        await fetch('/api/install', { method: 'POST' });
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
        if (btn) btn.classList.remove('loading');
    }
}

async function runUninstall() {
    var btn = document.getElementById('btnUninstall');
    if (btn) btn.classList.add('loading');
    showToast('🗑️ Đang xoá cấu hình...', 'info');
    appendTerminal('\n--- UNINSTALL STARTED ---\n', 'system');

    try {
        await fetch('/api/uninstall', { method: 'POST' });
    } catch (e) {
        showToast('Lỗi: ' + e.message, 'error');
        if (btn) btn.classList.remove('loading');
    }
}

// ============ CONFIRM DIALOG ============

function showConfirm(icon, title, message, okClass, onConfirm) {
    document.getElementById('confirmIcon').textContent = icon;
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    var okBtn = document.getElementById('confirmOkBtn');
    okBtn.className = 'confirm-btn confirm-btn-ok';
    if (okClass) okBtn.classList.add(okClass);
    okBtn.onclick = function() {
        closeConfirm();
        onConfirm();
    };
    document.getElementById('confirmOverlay').classList.add('active');
}

function closeConfirm() {
    document.getElementById('confirmOverlay').classList.remove('active');
}

function confirmStartAll() {
    showConfirm(
        '🚀',
        'Khởi động tất cả?',
        'Sẽ khởi động tất cả sessions PPPoE + 3proxy. Bạn có chắc chắn?',
        'start',
        startAll
    );
}

function confirmStopAll() {
    showConfirm(
        '⛔',
        'Dừng tất cả sessions?',
        'Thao tác này sẽ ngắt kết nối tất cả PPPoE sessions và dừng proxy. Bạn có chắc chắn?',
        'danger',
        stopAll
    );
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
    var ib = document.getElementById('btnInstall');
    var ub = document.getElementById('btnUninstall');
    if (ib) ib.classList.remove('loading');
    if (ub) ub.classList.remove('loading');
    if (data.code === 0) {
        showToast('✅ Hoàn tất!', 'success');
        appendTerminal('\n--- COMPLETE ✅ ---\n', 'success');
    } else {
        showToast('❌ Thất bại', 'error');
        appendTerminal('\n--- FAILED ❌ ---\n', 'error');
    }
    loadInstallStatus();
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
    fetchConfigForFarms().then(() => {
        setTimeout(refreshStatus, 1000);
    });
});

// ============ ROTATION QUEUE ============

socket.on('rotation_queue_update', (data) => {
    renderRotationQueue(data);
});

function renderRotationQueue(entries) {
    var container = document.getElementById('rotationQueueBody');
    var countEl = document.getElementById('queueCount');
    var emptyState = document.getElementById('queueEmptyState');
    var gridWrap = document.getElementById('queueTableWrap');
    var tabBadge = document.getElementById('tabQueueBadge');
    var bnBadge = document.getElementById('bnQueueBadge');

    var count = (entries && entries.length) || 0;
    countEl.textContent = count;

    // Update tab badges
    if (tabBadge) {
        tabBadge.textContent = count;
        tabBadge.style.display = count > 0 ? '' : 'none';
    }
    if (bnBadge) {
        bnBadge.textContent = count;
        bnBadge.style.display = count > 0 ? '' : 'none';
    }

    if (!entries || entries.length === 0) {
        emptyState.style.display = '';
        gridWrap.style.display = 'none';
        return;
    }

    emptyState.style.display = 'none';
    gridWrap.style.display = '';

    container.innerHTML = entries.map(function(e) {
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

        return '<div class="queue-card ' + statusClass + '">' +
            '<div class="queue-card-top">' +
                '<span class="queue-card-session">' + e.iface + '</span>' +
                '<span class="queue-badge ' + statusClass + '">' + statusText + nextRetry + '</span>' +
            '</div>' +
            '<div class="queue-card-ips">' +
                '<div class="queue-card-ip">' +
                    '<span class="queue-card-label">IP Cũ</span>' +
                    '<span class="queue-card-val">' + (e.oldIp || '---') + '</span>' +
                '</div>' +
                '<svg class="queue-card-arrow" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 12h14"/><polyline points="12 5 19 12 12 19"/></svg>' +
                '<div class="queue-card-ip">' +
                    '<span class="queue-card-label">IP Mới</span>' +
                    '<span class="queue-card-val ' + (e.newIp ? 'new-ip' : '') + '">' + (e.newIp || '---') + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="queue-card-bottom">' +
                '<span class="queue-card-meta">Lần thử: <strong>' + e.attempts + '</strong></span>' +
                '<span class="queue-card-meta">' + elapsed + '</span>' +
                '<button class="queue-card-remove" onclick="removeFromQueue(' + e.id + ')" title="Huỷ">✕</button>' +
            '</div>' +
        '</div>';
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
        list.innerHTML = '<div class="bl-empty"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>Chưa có domain nào</div>';
        actions.style.display = 'none';
        status.textContent = '';
        return;
    }

    actions.style.display = '';
    status.textContent = domains.length;

    list.innerHTML = domains.map(function(d) {
        return '<div class="bl-tag">' +
            '<span class="bl-domain">' + escapeHtml(d) + '</span>' +
            '<button class="bl-remove" onclick="removeBlacklistDomain(\'' + escapeHtml(d) + '\')" title="Xóa">✕</button>' +
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

// ============ IP LIST ============

var ipListData = [];

async function loadIPListUI() {
    try {
        var res = await fetch('/api/iplist');
        var data = await res.json();
        ipListData = data.entries || [];
        renderIPList(ipListData);
    } catch (e) { /* ignore */ }
}

function renderIPList(entries) {
    var content = document.getElementById('iplistContent');
    var actions = document.getElementById('iplistActions');
    var countEl = document.getElementById('iplistCount');

    if (!entries || entries.length === 0) {
        content.innerHTML = '<div class="iplist-empty"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>Chưa có IP nào</div>';
        actions.style.display = 'none';
        countEl.textContent = '';
        return;
    }

    actions.style.display = '';
    countEl.textContent = entries.length;

    // Show entries in reverse (newest first), display IP and time
    var reversed = entries.slice().reverse();
    var html = '<div class="iplist-items">';
    reversed.forEach(function(entry) {
        var timeStr = '';
        if (entry.timestamp) {
            var d = new Date(entry.timestamp);
            timeStr = d.toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit' });
        }
        html += '<div class="iplist-row">' +
            '<span class="iplist-ip">' + escapeHtml(entry.ip) + '</span>' +
            '<span class="iplist-time">' + timeStr + '</span>' +
            '</div>';
    });
    html += '</div>';
    content.innerHTML = html;
}

async function copyIPList() {
    if (!ipListData || ipListData.length === 0) {
        showToast('Danh sách IP trống', 'warning');
        return;
    }
    // Unique IPs only
    var uniqueIPs = [];
    ipListData.forEach(function(e) {
        if (uniqueIPs.indexOf(e.ip) === -1) uniqueIPs.push(e.ip);
    });
    var text = uniqueIPs.join('\n');
    try {
        await navigator.clipboard.writeText(text);
        showToast('📋 Đã copy ' + uniqueIPs.length + ' IP (unique)', 'success');
    } catch (e) {
        // Fallback
        var ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        showToast('📋 Đã copy ' + uniqueIPs.length + ' IP (unique)', 'success');
    }
}

async function clearIPList() {
    if (!confirm('Xóa tất cả IP trong danh sách?')) return;
    try {
        await fetch('/api/iplist', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        ipListData = [];
        renderIPList([]);
        showToast('✅ Đã xóa tất cả IP', 'success');
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

// Hook into switchTab to handle console initialization and fit
(function() {
    var origSwitchTab = switchTab;
    switchTab = function(target) {
        origSwitchTab(target);
        if (target === 'console') {
            setTimeout(function() {
                if (!consoleInitialized) {
                    initConsole();
                } else if (xtermFit) {
                    xtermFit.fit();
                    xterm.focus();
                }
            }, 50);
        }
    };
})();
