#!/bin/bash
# test-pppoe.sh — Thử nghiệm quy trình lấy proxy từ ppp0 và ppp1

# 1. Dọn dẹp trước khi test
echo "🧹 Cleaning up old sessions..."
pkill -9 pppd 2>/dev/null
pkill -9 3proxy 2>/dev/null
ip link del macppp1 2>/dev/null
sleep 2

# Thông tin tài khoản từ config.json
USER0="dng_gftth_nestgroupctt0"
PASS0="4EB9Y8"
NIC0="enp18s0"

USER1="dng_gftth_nestgroupctt0" # Dùng chung account 0 cho ppp1
PASS1="4EB9Y8"

echo "🚀 [1/3] Starting ppp0 on physical NIC $NIC0..."
pppd plugin pppoe.so nic-$NIC0 user "$USER0" password "$PASS0" unit 0 \
    noipdefault nodefaultroute hide-password noauth nopersist maxfail 1 mtu 1492 mru 1492 \
    lcp-echo-interval 20 lcp-echo-failure 3 &
sleep 10

IP0=$(ip -4 addr show ppp0 2>/dev/null | grep -oP 'inet \K[\d.]+')
if [ -n "$IP0" ]; then
    echo "  ✅ ppp0 connected! IP: $IP0"
else
    echo "  ❌ ppp0 failed to get IP. Check journalctl -xef"
    # exit 1
fi

echo "🚀 [2/3] Creating macppp1 and starting ppp1..."
ip link add link $NIC0 macppp1 type macvlan mode bridge
ip link set macppp1 address 02:00:00:00:00:01
ip link set macppp1 up
sleep 2

pppd plugin pppoe.so nic-macppp1 user "$USER1" password "$PASS1" unit 1 \
    noipdefault nodefaultroute hide-password noauth nopersist maxfail 1 mtu 1492 mru 1492 \
    lcp-echo-interval 20 lcp-echo-failure 3 &
sleep 10

IP1=$(ip -4 addr show ppp1 2>/dev/null | grep -oP 'inet \K[\d.]+')
if [ -n "$IP1" ]; then
    echo "  ✅ ppp1 connected! IP: $IP1"
else
    echo "  ❌ ppp1 failed to get IP."
fi

if [ -z "$IP0" ] && [ -z "$IP1" ]; then
    echo "❗ No active sessions. Exiting."
    exit 1
fi

echo "🚀 [3/3] Setting up 3proxy for ppp0 (Port 8081)..."
# Policy routing cho ppp0
ip route replace default dev ppp0 table 100 2>/dev/null
ip rule add from $IP0 table 100 2>/dev/null

# Tạo config 3proxy tạm thời
cat > /tmp/3proxy_test.cfg <<EOF
nserver 8.8.8.8
nserver 8.8.4.4
timeouts 1 5 30 60 180 1800 15 60
auth iponly
allow *
external $IP0
proxy -p8081 -i0.0.0.0 -e$IP0
EOF

3proxy /tmp/3proxy_test.cfg &
sleep 2

echo "🧪 Testing Proxy connectivity (curl --proxy http://127.0.0.1:8081)..."
CHECK=$(curl -s --proxy http://127.0.0.1:8081 http://ifconfig.me/ip)

if [ "$CHECK" == "$IP0" ]; then
    echo "  ⭐️ SUCCESS! Proxy is working. IP: $CHECK"
else
    echo "  ❌ Proxy check failed. Output: $CHECK"
fi

# Cleanup after test if you want, or leave it running
# pkill -9 pppd 3proxy
