#!/bin/bash
#
# rotate_ip.sh - Xoay IP cho 1 phiên PPPoE cụ thể
# Usage: bash rotate_ip.sh <ppp_id> [--fast]
#
# Cơ chế:
#   1. Disconnect pppd (giữ nguyên macvlan)
#   2. Reconnect → nếu đổi IP → xong!
#   3. Nếu trùng IP → huỷ macvlan, tạo mới MAC random, reconnect
#   --fast: chỉ thử bước 1+2, bỏ qua bước 3

PROXIES_FILE="/root/nest/proxies.txt"
PROXY_DIR="/root/nest/proxy"
LOG_DIR="/root/nest/logs"
INTERFACE="enp1s0f0"
FAST_MODE=false

# Parse args
if [ -z "$1" ]; then
    echo "Usage: bash rotate_ip.sh <ppp_id> [--fast]"
    echo "Ví dụ: bash rotate_ip.sh 1"
    exit 1
fi

ID=$1
shift
while [ $# -gt 0 ]; do
    case "$1" in
        --fast) FAST_MODE=true ;;
    esac
    shift
done

IFACE="ppp${ID}"
PEER="nest_ppp${ID}"
RUNTIME_CFG="${PROXY_DIR}/3proxy_ppp${ID}_active.cfg"
LINE_NUM=$((ID + 1))

# ========== HÀM TIỆN ÍCH ==========

kill_proxy() {
    local PORT=$(grep -oP 'proxy -p\K\d+' "$RUNTIME_CFG" 2>/dev/null || echo "")
    if [ -n "$PORT" ]; then
        local PID=$(lsof -ti :${PORT} 2>/dev/null || echo "")
        [ -n "$PID" ] && kill $PID 2>/dev/null || true
    fi
}

kill_pppd_only() {
    # Kill pppd nhưng KHÔNG xoá macvlan
    local PPPD_PID=$(cat "/var/run/ppp${ID}.pid" 2>/dev/null || echo "")
    if [ -n "$PPPD_PID" ]; then
        kill "$PPPD_PID" 2>/dev/null || true
        for w in $(seq 1 5); do
            kill -0 "$PPPD_PID" 2>/dev/null || break
            sleep 1
        done
        kill -9 "$PPPD_PID" 2>/dev/null || true
    fi
    # Đợi interface down
    for w in $(seq 1 5); do
        ip link show "$IFACE" 2>/dev/null || break
        sleep 1
    done
}

rebuild_macvlan() {
    # Xoá macvlan cũ, tạo mới với MAC random
    if [ "$ID" -gt 0 ]; then
        local MACVLAN="macppp${ID}"
        local MAC=$(printf '02:%02x:%02x:%02x:%02x:%02x' \
            $((RANDOM % 256)) $((RANDOM % 256)) $((RANDOM % 256)) \
            $((RANDOM % 256)) $((RANDOM % 256)))

        echo "   Tạo lại $MACVLAN (MAC: $MAC)..." >&2
        ip link set "$MACVLAN" down 2>/dev/null || true
        ip link del "$MACVLAN" 2>/dev/null || true
        ip link add link "$INTERFACE" "$MACVLAN" type macvlan mode bridge
        ip link set "$MACVLAN" address "$MAC"
        ip link set "$MACVLAN" up
        sleep 1
    else
        echo "   ppp0 (interface gốc) - chờ ISP release..." >&2
        sleep 8
    fi
}

connect_pppoe() {
    pppd call "$PEER" >/dev/null 2>&1 &
    local GOT_IP=""
    for w in $(seq 1 20); do
        local IP=$(ip -4 addr show "$IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+')
        if [ -n "$IP" ]; then
            GOT_IP="$IP"
            break
        fi
        sleep 1
    done
    echo "$GOT_IP"
}

setup_proxy() {
    local IP=$1
    local TABLE=$((100 + ID))

    # Policy routing
    ip route replace default dev "$IFACE" table "$TABLE" 2>/dev/null
    ip rule del from "$IP" 2>/dev/null || true
    ip rule add from "$IP" table "$TABLE"

    # Random port
    local PORT
    while true; do
        PORT=$(shuf -i 10000-60000 -n 1)
        if ! ss -tlnH "sport = :$PORT" | grep -q .; then
            break
        fi
    done

    # 3proxy config
    cat > "$RUNTIME_CFG" << EOF
# 3proxy runtime config for ppp${ID}
# IP: ${IP} Port: ${PORT}

nserver 8.8.8.8
nserver 8.8.4.4

log ${LOG_DIR}/3proxy_ppp${ID}.log D
logformat "L%t %N:%p %E %C:%c %R:%r %O %I %h %T"

timeouts 1 5 30 60 180 1800 15 60

auth none
allow *

external ${IP}
proxy -p${PORT} -i0.0.0.0 -e${IP}
EOF

    3proxy "$RUNTIME_CFG" &

    # Cập nhật proxies.txt
    sed -i "${LINE_NUM}s/.*/${IP}:${PORT}/" "$PROXIES_FILE"

    echo "$PORT"
}

# ========== BẮT ĐẦU ==========

OLD_IP=$(ip -4 addr show "$IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+' || echo "")
OLD_PORT=$(grep -oP 'proxy -p\K\d+' "$RUNTIME_CFG" 2>/dev/null || echo "")

echo "🔄 Xoay IP cho $IFACE"
if [ -n "$OLD_IP" ]; then
    echo "   IP cũ: $OLD_IP (port $OLD_PORT)"
else
    echo "   ⚠️  Session đã chết, khởi tạo lại..."
fi

# Kill proxy cũ
kill_proxy

# ========== BƯỚC 1: DISCONNECT + RECONNECT (giữ macvlan) ==========
echo "   Disconnect pppd..."
kill_pppd_only
sleep 2

echo "   Reconnect..."
NEW_IP=$(connect_pppoe)

if [ -z "$NEW_IP" ]; then
    echo "   ⚠️  Không nhận được IP, thử tạo lại macvlan..."
    rebuild_macvlan
    NEW_IP=$(connect_pppoe)
fi

if [ -z "$NEW_IP" ]; then
    echo "❌ $IFACE không nhận được IP"
    exit 1
fi

# ========== BƯỚC 2: NẾU TRÙNG IP → HUỶ MACVLAN, TẠO LẠI ==========
if [ -n "$OLD_IP" ] && [ "$NEW_IP" = "$OLD_IP" ] && [ "$FAST_MODE" = false ]; then
    echo "   ⚠️  Vẫn IP cũ ($NEW_IP), huỷ macvlan tạo lại..."
    kill_pppd_only
    rebuild_macvlan
    
    NEW_IP=$(connect_pppoe)
    if [ -z "$NEW_IP" ]; then
        echo "❌ $IFACE không nhận được IP sau khi tạo lại macvlan"
        exit 1
    fi
fi

# ========== BƯỚC 3: CẤU HÌNH PROXY ==========
echo "   IP mới: $NEW_IP"

# Policy routing
TABLE=$((100 + ID))
ip route replace default dev "$IFACE" table "$TABLE" 2>/dev/null
ip rule del from "$NEW_IP" 2>/dev/null || true
ip rule add from "$NEW_IP" table "$TABLE"

# Random port
while true; do
    PORT=$(shuf -i 10000-60000 -n 1)
    if ! ss -tlnH "sport = :$PORT" | grep -q .; then
        break
    fi
done

# 3proxy config
cat > "$RUNTIME_CFG" << EOF
# 3proxy runtime config for ppp${ID}
# IP: ${NEW_IP} Port: ${PORT}

nserver 8.8.8.8
nserver 8.8.4.4

log ${LOG_DIR}/3proxy_ppp${ID}.log D
logformat "L%t %N:%p %E %C:%c %R:%r %O %I %h %T"

timeouts 1 5 30 60 180 1800 15 60

auth none
allow *

external ${NEW_IP}
proxy -p${PORT} -i0.0.0.0 -e${NEW_IP}
EOF

3proxy "$RUNTIME_CFG" &

# Cập nhật proxies.txt
sed -i "${LINE_NUM}s/.*/${NEW_IP}:${PORT}/" "$PROXIES_FILE"

# ========== KẾT QUẢ ==========
if [ -n "$OLD_IP" ] && [ "$NEW_IP" != "$OLD_IP" ]; then
    echo "✅ Đổi IP thành công: $OLD_IP → $NEW_IP (port $PORT)"
elif [ -z "$OLD_IP" ]; then
    echo "✅ Khôi phục session: $NEW_IP (port $PORT)"
else
    echo "⚠️  IP không đổi: $NEW_IP (port $PORT)"
fi
