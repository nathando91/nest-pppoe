#!/bin/bash
#
# rotate_ip.sh - Xoay IP cho 1 phiên PPPoE cụ thể
# Usage: bash rotate_ip.sh <ppp_id>
# Ví dụ: bash rotate_ip.sh 1    → xoay IP cho ppp1
#         bash rotate_ip.sh 5    → xoay IP cho ppp5
#
# Không dùng set -e vì nhiều lệnh kill/ip rule có thể fail và đó là bình thường

PROXIES_FILE="/root/nest/proxies.txt"
PROXY_DIR="/root/nest/proxy"
LOG_DIR="/root/nest/logs"

if [ -z "$1" ]; then
    echo "Usage: bash rotate_ip.sh <ppp_id>"
    echo "Ví dụ: bash rotate_ip.sh 1"
    exit 1
fi

ID=$1
IFACE="ppp${ID}"
PEER="nest_ppp${ID}"
RUNTIME_CFG="${PROXY_DIR}/3proxy_ppp${ID}_active.cfg"
LINE_NUM=$((ID + 1))  # dòng trong proxies.txt (1-indexed, ppp0=dòng 1)

# Lấy IP + port hiện tại
OLD_IP=$(ip -4 addr show "$IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+' || echo "")
OLD_PORT=$(grep -oP 'proxy -p\K\d+' "$RUNTIME_CFG" 2>/dev/null || echo "")

if [ -z "$OLD_IP" ]; then
    echo "❌ $IFACE không có IP (chưa kết nối?)"
    exit 1
fi

echo "🔄 Xoay IP cho $IFACE"
echo "   IP cũ: $OLD_IP (port $OLD_PORT)"

# 1. Kill 3proxy đang chạy cho phiên này
if [ -n "$OLD_PORT" ]; then
    PROXY_PID=$(lsof -ti :${OLD_PORT} 2>/dev/null || echo "")
    [ -n "$PROXY_PID" ] && kill $PROXY_PID 2>/dev/null || true
fi

# 2. Kill pppd
PPPD_PID=$(cat "/var/run/ppp${ID}.pid" 2>/dev/null || echo "")
[ -n "$PPPD_PID" ] && kill "$PPPD_PID" 2>/dev/null || true

sleep 3

# 3. Reconnect
pppd call "$PEER" &

# 4. Đợi IP mới (tối đa 15s)
NEW_IP=""
for w in $(seq 1 15); do
    IP=$(ip -4 addr show "$IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+')
    if [ -n "$IP" ]; then
        NEW_IP="$IP"
        break
    fi
    sleep 1
done

if [ -z "$NEW_IP" ]; then
    echo "❌ $IFACE không nhận được IP mới (timeout 15s)"
    exit 1
fi

echo "   IP mới: $NEW_IP"

# 5. Policy routing
TABLE=$((100 + ID))
ip route replace default dev "$IFACE" table "$TABLE" 2>/dev/null
ip rule del from "$NEW_IP" 2>/dev/null || true
ip rule add from "$NEW_IP" table "$TABLE"

# 6. Sinh random port mới (không trùng port đang dùng)
while true; do
    PORT=$(shuf -i 10000-60000 -n 1)
    if ! ss -tlnH "sport = :$PORT" | grep -q .; then
        break
    fi
done

# 7. Tạo 3proxy config runtime mới
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

# 8. Start 3proxy
3proxy "$RUNTIME_CFG" &

# 9. Cập nhật proxies.txt
sed -i "${LINE_NUM}s/.*/${NEW_IP}:${PORT}/" "$PROXIES_FILE"

echo "✅ Xoay IP thành công: $OLD_IP → $NEW_IP (port $PORT)"
