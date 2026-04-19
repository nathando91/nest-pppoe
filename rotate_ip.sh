#!/bin/bash
#
# rotate_ip.sh - Xoay IP cho 1 phiên PPPoE cụ thể
# Usage: bash rotate_ip.sh <ppp_id>
# Ví dụ: bash rotate_ip.sh 1    → xoay IP cho ppp1
#
# Cơ chế: huỷ hoàn toàn phiên PPPoE, tạo lại macvlan mới với MAC random.
# Nếu IP không đổi → huỷ tiếp, chờ 30s cho ISP release, rồi thử lại.

PROXIES_FILE="/root/nest/proxies.txt"
PROXY_DIR="/root/nest/proxy"
LOG_DIR="/root/nest/logs"
INTERFACE="enp1s0f0"

if [ -z "$1" ]; then
    echo "Usage: bash rotate_ip.sh <ppp_id>"
    echo "Ví dụ: bash rotate_ip.sh 1"
    exit 1
fi

ID=$1
IFACE="ppp${ID}"
PEER="nest_ppp${ID}"
RUNTIME_CFG="${PROXY_DIR}/3proxy_ppp${ID}_active.cfg"
LINE_NUM=$((ID + 1))

# ========== HÀM TIỆN ÍCH ==========

kill_pppoe() {
    # Kill 3proxy cho port này
    local PORT=$(grep -oP 'proxy -p\K\d+' "$RUNTIME_CFG" 2>/dev/null || echo "")
    if [ -n "$PORT" ]; then
        local PID=$(lsof -ti :${PORT} 2>/dev/null || echo "")
        [ -n "$PID" ] && kill $PID 2>/dev/null || true
    fi

    # Kill pppd
    local PPPD_PID=$(cat "/var/run/ppp${ID}.pid" 2>/dev/null || echo "")
    if [ -n "$PPPD_PID" ]; then
        kill "$PPPD_PID" 2>/dev/null || true
        sleep 2
        kill -9 "$PPPD_PID" 2>/dev/null || true
    fi

    # Đợi interface biến mất
    for w in $(seq 1 5); do
        ip link show "$IFACE" 2>/dev/null || break
        sleep 1
    done

    # Xoá macvlan
    if [ "$ID" -gt 0 ]; then
        ip link set "macppp${ID}" down 2>/dev/null || true
        ip link del "macppp${ID}" 2>/dev/null || true
    fi

    # Xoá routing rules
    local TBL=$((100 + ID))
    ip route flush table "$TBL" 2>/dev/null || true
}

start_pppoe() {
    # Tạo macvlan mới với MAC random (ppp1-29)
    if [ "$ID" -gt 0 ]; then
        local MACVLAN="macppp${ID}"
        local MAC=$(printf '02:%02x:%02x:%02x:%02x:%02x' \
            $((RANDOM % 256)) $((RANDOM % 256)) $((RANDOM % 256)) \
            $((RANDOM % 256)) $((RANDOM % 256)))

        echo "   Tạo $MACVLAN (MAC: $MAC)..." >&2
        ip link add link "$INTERFACE" "$MACVLAN" type macvlan mode bridge
        ip link set "$MACVLAN" address "$MAC"
        ip link set "$MACVLAN" up
        sleep 1
    fi

    echo "   Kết nối PPPoE..." >&2
    pppd call "$PEER" &

    # Đợi IP (tối đa 20s)
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

# ========== BẮT ĐẦU ==========

OLD_IP=$(ip -4 addr show "$IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+' || echo "")
OLD_PORT=$(grep -oP 'proxy -p\K\d+' "$RUNTIME_CFG" 2>/dev/null || echo "")

echo "🔄 Xoay IP cho $IFACE"
if [ -n "$OLD_IP" ]; then
    echo "   IP cũ: $OLD_IP (port $OLD_PORT)"
else
    echo "   ⚠️  Session đã chết, khởi tạo lại..."
fi

# ========== BƯỚC 1: HUỶ HOÀN TOÀN ==========
echo "   Huỷ session..."
kill_pppoe
echo "   Session đã huỷ."

# ========== BƯỚC 2: KẾT NỐI LẠI ==========
NEW_IP=$(start_pppoe)

if [ -z "$NEW_IP" ]; then
    echo "❌ $IFACE không nhận được IP (timeout 20s)"
    exit 1
fi

# ========== BƯỚC 2b: NẾU IP KHÔNG ĐỔI → CHỜ LÂU HƠN ==========
if [ -n "$OLD_IP" ] && [ "$NEW_IP" = "$OLD_IP" ]; then
    echo "   ⚠️  Vẫn IP cũ ($NEW_IP)"
    echo "   Huỷ lại, chờ 30s cho ISP release binding..."
    kill_pppoe

    for i in $(seq 30 -1 1); do
        printf "\r   ⏳ Chờ ISP: %2ds " "$i"
        sleep 1
    done
    echo ""

    NEW_IP=$(start_pppoe)
    if [ -z "$NEW_IP" ]; then
        echo "❌ $IFACE không nhận được IP lần 2"
        exit 1
    fi
fi

echo "   IP mới: $NEW_IP"

# ========== BƯỚC 3: CẤU HÌNH PROXY ==========

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
    echo "⚠️  IP không đổi sau 30s chờ: $NEW_IP (port $PORT)"
fi
