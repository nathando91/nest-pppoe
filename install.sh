#!/bin/bash
#
# install.sh - Khởi tạo tất cả cấu hình cho 30 phiên PPPoE + 3proxy
# Chạy 1 lần duy nhất (hoặc khi cần cập nhật config)
#
set -e

CONFIG="/root/nest/config.json"
INTERFACE="enp1s0f0"
NUM=30
BASE_PORT=8081
PEER_DIR="/etc/ppp/peers"
PROXY_DIR="/root/nest/proxy"
LOG_DIR="/root/nest/logs"

echo "============================================"
echo "  INSTALL - 30 PPPoE Sessions + 3proxy"
echo "============================================"

# --- Parse config ---
USERNAME=$(python3 -c "import json; c=json.load(open('$CONFIG')); print(c['pppoe'][0]['username'])")
PASSWORD=$(python3 -c "import json; c=json.load(open('$CONFIG')); print(c['pppoe'][0]['password'])")
echo "[*] Account: $USERNAME"
echo "[*] Interface: $INTERFACE"
echo ""

# --- 1. Tạo thư mục ---
echo "[1/5] Tạo thư mục..."
mkdir -p "$PROXY_DIR" "$LOG_DIR" "$PEER_DIR"

# --- 2. Cấu hình credentials ---
echo "[2/5] Cấu hình credentials..."
CRED_LINE="\"$USERNAME\" * \"$PASSWORD\" *"
for secret_file in /etc/ppp/chap-secrets /etc/ppp/pap-secrets; do
    if [ -f "$secret_file" ]; then
        grep -v "$USERNAME" "$secret_file" > "${secret_file}.tmp" 2>/dev/null || true
        mv "${secret_file}.tmp" "$secret_file"
    fi
    echo "$CRED_LINE" >> "$secret_file"
    chmod 600 "$secret_file"
done
echo "    ✅ chap-secrets & pap-secrets"

# --- 3. Tạo macvlan interfaces ---
echo "[3/5] Tạo $NUM macvlan interfaces..."

# ppp0 dùng trực tiếp enp1s0f0 (MAC gốc), không cần macvlan
# ppp1-ppp29 dùng macvlan với MAC riêng

for i in $(seq 1 $((NUM-1))); do
    MACVLAN="macppp${i}"
    # Xóa nếu đã tồn tại
    ip link del "$MACVLAN" 2>/dev/null || true
    # Tạo macvlan
    ip link add link "$INTERFACE" "$MACVLAN" type macvlan mode bridge
    # MAC: 02:00:00:00:XX:YY (local administered)
    HEX_I=$(printf '%02x:%02x' $((i / 256)) $((i % 256)))
    ip link set "$MACVLAN" address "02:00:00:00:${HEX_I}"
    ip link set "$MACVLAN" up
done
echo "    ✅ macppp1 - macppp$((NUM-1)) created"

# --- 4. Tạo peer files ---
echo "[4/5] Tạo $NUM peer files..."

# ppp0: dùng enp1s0f0 trực tiếp
cat > "${PEER_DIR}/nest_ppp0" << EOF
plugin pppoe.so
nic-${INTERFACE}
user "${USERNAME}"
unit 0
noipdefault
nodefaultroute
hide-password
noauth
persist
maxfail 5
holdoff 5
mtu 1492
mru 1492
lcp-echo-interval 20
lcp-echo-failure 3
usepeerdns
EOF

# ppp1-ppp29: dùng macvlan
for i in $(seq 1 $((NUM-1))); do
    cat > "${PEER_DIR}/nest_ppp${i}" << EOF
plugin pppoe.so
nic-macppp${i}
user "${USERNAME}"
unit ${i}
noipdefault
nodefaultroute
hide-password
noauth
persist
maxfail 5
holdoff 5
mtu 1492
mru 1492
lcp-echo-interval 20
lcp-echo-failure 3
usepeerdns
EOF
done
echo "    ✅ nest_ppp0 - nest_ppp$((NUM-1))"

# --- 5. Tạo 3proxy config templates ---
echo "[5/5] Tạo $NUM 3proxy configs (template)..."
for i in $(seq 0 $((NUM-1))); do
    PORT=$((BASE_PORT + i))
    cat > "${PROXY_DIR}/3proxy_ppp${i}.cfg" << EOF
# 3proxy config for ppp${i}
# __PPP_IP__ sẽ được thay thế khi start

nserver 8.8.8.8
nserver 8.8.4.4

log ${LOG_DIR}/3proxy_ppp${i}.log D
logformat "L%t %N:%p %E %C:%c %R:%r %O %I %h %T"

# Timeout
timeouts 1 5 30 60 180 1800 15 60

# Cho phép tất cả
auth none
allow *

# Bind outgoing IP (PPPoE)
external __PPP_IP__

# Proxy HTTP trên port __PORT__
proxy -p__PORT__ -i0.0.0.0 -e__PPP_IP__
EOF
done

# Xóa tinyproxy configs cũ nếu có
rm -f "${PROXY_DIR}"/tinyproxy_*.conf 2>/dev/null || true

echo "    ✅ 3proxy configs ppp0-ppp$((NUM-1))"

echo ""
echo "============================================"
echo "  ✅ INSTALL COMPLETE"
echo "============================================"
echo "  Peer files : ${PEER_DIR}/nest_ppp{0..$((NUM-1))}"
echo "  Macvlan    : macppp{1..$((NUM-1))}"
echo "  3proxy conf: ${PROXY_DIR}/3proxy_ppp{0..$((NUM-1))}.cfg"
echo ""
echo "  Chạy: bash /root/nest/start_all.sh"
echo "  Dừng: bash /root/nest/stop_all.sh"
echo "============================================"
