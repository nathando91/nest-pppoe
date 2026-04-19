#!/bin/bash
#
# start_all.sh - Khởi động 30 phiên PPPoE + 3proxy (random port)
# Yêu cầu: đã chạy install.sh trước
#
NUM=30
PORT_MIN=10000
PORT_MAX=60000
PROXY_DIR="/root/nest/proxy"
LOG_DIR="/root/nest/logs"
PROXIES_FILE="/root/nest/proxies.txt"
DELAY_BETWEEN=2  # giây chờ giữa mỗi phiên

# Sinh port ngẫu nhiên, đảm bảo không trùng & không bị chiếm
declare -A USED_PORTS
random_port() {
    while true; do
        PORT=$(shuf -i ${PORT_MIN}-${PORT_MAX} -n 1)
        # Kiểm tra chưa dùng và chưa bị chiếm
        if [ -z "${USED_PORTS[$PORT]}" ] && ! ss -tlnH "sport = :$PORT" | grep -q .; then
            USED_PORTS[$PORT]=1
            echo "$PORT"
            return
        fi
    done
}

echo "============================================"
echo "  START - ${NUM} PPPoE + 3proxy (random ports)"
echo "============================================"
echo ""

# --- Cleanup ---
echo "[*] Dừng các phiên cũ..."
pkill -f "3proxy.*3proxy_ppp" 2>/dev/null || true
pkill -f log_proxy.py 2>/dev/null || true
pkill tinyproxy 2>/dev/null || true
pkill pppd 2>/dev/null || true
sleep 3

# Xóa ip rules cũ
for t in $(seq 100 $((100+NUM-1))); do
    ip route flush table "$t" 2>/dev/null || true
done
ip rule show | grep -oP 'from \S+ lookup \d+' | while read line; do
    ip rule del $line 2>/dev/null || true
done

# Reset proxies file
> "$PROXIES_FILE"

# --- Start PPPoE tuần tự ---
echo "[*] Khởi động PPPoE tuần tự..."
echo ""

CONNECTED=0
for i in $(seq 0 $((NUM-1))); do
    PEER="nest_ppp${i}"
    IFACE="ppp${i}"

    pppd call "$PEER" &

    # Đợi IP (tối đa 15s mỗi phiên)
    GOT_IP=""
    for w in $(seq 1 15); do
        IP=$(ip -4 addr show "$IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+')
        if [ -n "$IP" ]; then
            GOT_IP="$IP"
            break
        fi
        sleep 1
    done

    if [ -n "$GOT_IP" ]; then
        # Sinh random port
        PORT=$(random_port)
        
        printf "  ✅ %-6s %-18s → :%s\n" "$IFACE" "$GOT_IP" "$PORT"
        
        # Policy routing
        TABLE=$((100 + i))
        ip route replace default dev "$IFACE" table "$TABLE" 2>/dev/null
        ip rule del from "$GOT_IP" 2>/dev/null || true
        ip rule add from "$GOT_IP" table "$TABLE"
        
        # Tạo 3proxy config runtime (thay thế placeholders)
        RUNTIME_CFG="${PROXY_DIR}/3proxy_ppp${i}_active.cfg"
        cat > "$RUNTIME_CFG" << EOF
# 3proxy runtime config for ppp${i}
# IP: ${GOT_IP} Port: ${PORT}

nserver 8.8.8.8
nserver 8.8.4.4

log ${LOG_DIR}/3proxy_ppp${i}.log D
logformat "L%t %N:%p %E %C:%c %R:%r %O %I %h %T"

timeouts 1 5 30 60 180 1800 15 60

auth none
allow *

external ${GOT_IP}
proxy -p${PORT} -i0.0.0.0 -e${GOT_IP}
EOF
        
        # Start 3proxy
        3proxy "$RUNTIME_CFG" &
        
        # Lưu mapping
        echo "${GOT_IP}:${PORT}" >> "$PROXIES_FILE"
        
        CONNECTED=$((CONNECTED + 1))
    else
        printf "  ❌ %-6s no IP (timeout)\n" "$IFACE"
    fi

    # Chờ giữa các phiên
    if [ $i -lt $((NUM-1)) ]; then
        sleep "$DELAY_BETWEEN"
    fi
done

sleep 1
echo ""

# --- Tổng kết ---
PROXY_COUNT=$(pgrep -c 3proxy 2>/dev/null || echo 0)
echo "============================================"
echo "  RESULT"
echo "============================================"
echo ""
printf "  %-8s %-18s %-8s\n" "PPP" "IP" "PORT"
printf "  %-8s %-18s %-8s\n" "---" "--" "----"
LINE=1
while IFS=: read -r IP PORT; do
    printf "  %-8s %-18s :%s\n" "ppp$((LINE-1))" "$IP" "$PORT"
    LINE=$((LINE+1))
done < "$PROXIES_FILE"
echo ""
echo "  PPPoE connected: ${CONNECTED}/${NUM}"
echo "  3proxy running:  ${PROXY_COUNT}"
echo "  Proxy list saved: ${PROXIES_FILE}"
echo ""
echo "  Test: curl --proxy http://192.168.1.50:\$(head -1 ${PROXIES_FILE} | cut -d: -f2) https://api.ipify.org"
echo "============================================"
