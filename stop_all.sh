#!/bin/bash
#
# stop_all.sh - Dừng tất cả PPPoE + 3proxy
#
echo "[*] Stopping 3proxy..."
pkill -f "3proxy.*3proxy_ppp" 2>/dev/null || true
pkill 3proxy 2>/dev/null || true

# Cleanup legacy processes
pkill -f log_proxy.py 2>/dev/null || true
pkill tinyproxy 2>/dev/null || true

echo "[*] Stopping pppd..."
pkill pppd 2>/dev/null || true

sleep 2

# Xóa runtime configs
rm -f /root/nest/proxy/3proxy_ppp*_active.cfg 2>/dev/null || true

# Verify
PPPD=$(pgrep -c pppd 2>/dev/null || echo 0)
PROXY=$(pgrep -c 3proxy 2>/dev/null || echo 0)

if [ "$PPPD" -gt 0 ] || [ "$PROXY" -gt 0 ]; then
    echo "[*] Force killing..."
    pkill -9 pppd 2>/dev/null || true
    pkill -9 3proxy 2>/dev/null || true
    pkill -9 -f log_proxy.py 2>/dev/null || true
    sleep 1
fi

echo "[✓] All stopped (pppd: $(pgrep -c pppd 2>/dev/null || echo 0), 3proxy: $(pgrep -c 3proxy 2>/dev/null || echo 0))"
