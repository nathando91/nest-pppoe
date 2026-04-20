/**
 * test.js - Auto Rotate IP cho 30 PPPoE sessions
 * 
 * Giả lập người dùng thật:
 * - Mỗi session có chu kỳ xoay riêng (8-12 phút, random)
 * - Xoay tuần tự: CHỈ 1 session xoay tại 1 thời điểm
 * - Sau mỗi lần xoay, chờ 15-45 giây rồi mới xoay session tiếp theo
 * - Không bao giờ 2 session xoay cùng lúc → nhà mạng không phát hiện
 * 
 * Chạy: node test.js
 * Dừng: Ctrl+C
 */

const http = require('http');

const API_HOST = '127.0.0.1';
const API_PORT = 3000;
const TOTAL_SESSIONS = 30;

// Mỗi session xoay mỗi 8-12 phút (random cho mỗi session)
const MIN_INTERVAL_MS = 8 * 60 * 1000;   // 8 phút
const MAX_INTERVAL_MS = 12 * 60 * 1000;  // 12 phút

// Khoảng cách giữa 2 lần xoay liên tiếp (giữa 2 session khác nhau)
const MIN_GAP_MS = 15 * 1000;  // 15 giây
const MAX_GAP_MS = 45 * 1000;  // 45 giây

// ============ STATE ============

// Mỗi session lưu thời điểm cần xoay tiếp theo
var sessions = [];
var rotateQueue = [];  // queue các session đang chờ xoay
var isRotating = false;

// ============ UTILS ============

function timestamp() {
    return new Date().toLocaleTimeString('vi-VN', { hour12: false });
}

function formatMs(ms) {
    var sec = Math.floor(ms / 1000);
    var min = Math.floor(sec / 60);
    sec = sec % 60;
    return min + 'p' + (sec < 10 ? '0' : '') + sec + 's';
}

function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
    return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ============ API CALL ============

function rotateSession(id) {
    return new Promise(function(resolve, reject) {
        var options = {
            hostname: API_HOST,
            port: API_PORT,
            path: '/api/session/' + id + '/rotate',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        };

        var req = http.request(options, function(res) {
            var body = '';
            res.on('data', function(chunk) { body += chunk; });
            res.on('end', function() {
                try {
                    resolve(JSON.parse(body));
                } catch (e) {
                    resolve({ raw: body });
                }
            });
        });

        req.on('error', function(err) { reject(err); });
        req.setTimeout(15000, function() {
            req.destroy();
            reject(new Error('timeout'));
        });

        req.end();
    });
}

// ============ QUEUE PROCESSOR ============
// Chỉ xoay 1 session tại 1 thời điểm, chờ random gap giữa mỗi lần

async function processQueue() {
    if (isRotating) return;
    if (rotateQueue.length === 0) return;

    isRotating = true;

    while (rotateQueue.length > 0) {
        var id = rotateQueue.shift();

        console.log('[' + timestamp() + '] 🔄 ppp' + id + ' → Gọi API xoay IP... (còn ' + rotateQueue.length + ' trong queue)');

        try {
            var result = await rotateSession(id);
            console.log('[' + timestamp() + '] ✅ ppp' + id + ' → ' + (result.message || 'OK'));
        } catch (err) {
            console.log('[' + timestamp() + '] ❌ ppp' + id + ' → Lỗi: ' + err.message);
        }

        // Lên lịch xoay tiếp cho session này (8-12 phút sau)
        scheduleNextRotation(id);

        // Chờ random gap trước khi xoay session tiếp theo
        if (rotateQueue.length > 0) {
            var gap = randomBetween(MIN_GAP_MS, MAX_GAP_MS);
            console.log('[' + timestamp() + '] ⏸  Chờ ' + formatMs(gap) + ' trước khi xoay session tiếp...');
            await sleep(gap);
        }
    }

    isRotating = false;
}

// ============ SCHEDULER ============

function scheduleNextRotation(id) {
    var interval = randomBetween(MIN_INTERVAL_MS, MAX_INTERVAL_MS);
    sessions[id].nextRotateAt = Date.now() + interval;
    sessions[id].interval = interval;
}

function enqueueRotation(id) {
    // Tránh trùng lặp trong queue
    if (rotateQueue.indexOf(id) === -1) {
        rotateQueue.push(id);
    }
    processQueue(); // Trigger processor (nếu chưa chạy)
}

// Kiểm tra mỗi 10 giây xem session nào đến lượt xoay
function checkSchedule() {
    var now = Date.now();
    for (var i = 0; i < TOTAL_SESSIONS; i++) {
        if (sessions[i].nextRotateAt && now >= sessions[i].nextRotateAt) {
            sessions[i].nextRotateAt = null; // Đánh dấu đã enqueue
            enqueueRotation(i);
        }
    }
}

// ============ MAIN ============

console.log('');
console.log('==========================================');
console.log('  🔄 Auto Rotate - ' + TOTAL_SESSIONS + ' PPPoE Sessions');
console.log('  ⏱  Chu kỳ mỗi session: 8-12 phút (random)');
console.log('  🔒 Xoay tuần tự: 1 session/lần');
console.log('  ⏸  Gap giữa 2 lần xoay: 15-45 giây');
console.log('  🛑 Dừng: Ctrl+C');
console.log('==========================================');
console.log('');

// Khởi tạo: stagger ban đầu để 30 session trải đều trong 10 phút đầu
for (var i = 0; i < TOTAL_SESSIONS; i++) {
    var firstDelay = randomBetween(0, MAX_INTERVAL_MS);
    sessions.push({
        id: i,
        nextRotateAt: Date.now() + firstDelay,
        interval: 0
    });
    console.log('[' + timestamp() + '] 📋 ppp' + i + ' → xoay lần đầu sau ' + formatMs(firstDelay));
}

console.log('');
console.log('[' + timestamp() + '] ⏳ Đang chờ... Mỗi session sẽ xoay khi đến lượt.');
console.log('');

// Chạy scheduler mỗi 10 giây
setInterval(checkSchedule, 10 * 1000);
