#!/bin/bash
# Quick rotate script — bypasses Node.js queue
# Usage: ./rotate.sh <session_id>
# Example: ./rotate.sh 1  => Rotate ppp1

set -e

ID="$1"
if [ -z "$ID" ]; then
    echo "Usage: ./rotate.sh <session_id>"
    echo "Example: ./rotate.sh 1"
    exit 1
fi

IFACE="ppp${ID}"
MACVLAN="macppp${ID}"
CONFIG_FILE="/root/nest/config.json"
NIC=$(cat "$CONFIG_FILE" | grep -oP '"interface"\s*:\s*"\K[^"]+' | head -1)
NIC=${NIC:-enp1s0f0}
USER=$(cat "$CONFIG_FILE" | grep -oP '"username"\s*:\s*"\K[^"]+' | head -1)
MAX_ATTEMPTS=10
START=$(date +%s%3N)

step() {
    local NOW=$(date +%s%3N)
    local ELAPSED=$(( NOW - START ))
    echo "[${ELAPSED}ms] $1"
}

is_private_ip() {
    local ip="$1"
    [[ "$ip" =~ ^10\. ]] || [[ "$ip" =~ ^172\.(1[6-9]|2[0-9]|3[01])\. ]] || [[ "$ip" =~ ^192\.168\. ]] || [[ "$ip" =~ ^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\. ]]
}

do_rotate() {
    local attempt=$1

    step "🔄 [Lần $attempt] Rotating ${IFACE}..."

    # Kill pppd for this session by unit number (new format) or peer name (legacy)
    pkill -9 -f "unit ${ID}[^0-9]" 2>/dev/null || true
    pkill -9 -f "^pppd call nest_ppp${ID}$" 2>/dev/null || true
    PID_FILE="/var/run/${IFACE}.pid"
    [ -f "$PID_FILE" ] && kill -9 "$(cat "$PID_FILE" 2>/dev/null)" 2>/dev/null || true

    # Wait for interface down
    for i in $(seq 1 5); do
        ip link show "$IFACE" 2>/dev/null || break
        sleep 0.3
    done

    # Kill 3proxy (only first attempt)
    if [ "$attempt" -eq 1 ]; then
        CFG_FILE="/etc/3proxy/3proxy_ppp${ID}_active.cfg"
        if [ -f "$CFG_FILE" ]; then
            PORTS=$(grep -oP 'proxy -p\K\d+' "$CFG_FILE" 2>/dev/null || true)
            for PORT in $PORTS; do
                PIDS=$(lsof -ti ":$PORT" 2>/dev/null || true)
                for PID in $PIDS; do
                    kill -9 "$PID" 2>/dev/null || true
                done
            done
            step "   Proxy killed"
        fi
    fi

    # Rebuild macvlan
    if [ "$ID" -gt 0 ]; then
        MAC=$(printf '02:%02x:%02x:%02x:%02x:%02x' $((RANDOM%256)) $((RANDOM%256)) $((RANDOM%256)) $((RANDOM%256)) $((RANDOM%256)))
        ip link set "$MACVLAN" down 2>/dev/null || true
        ip link del "$MACVLAN" 2>/dev/null || true
        ip link add link "$NIC" "$MACVLAN" type macvlan mode bridge
        ip link set "$MACVLAN" address "$MAC"
        ip link set "$MACVLAN" up
        sleep 0.5
        step "   macvlan rebuilt (MAC: $MAC)"
    else
        sleep 1
    fi

    # Connect pppd with dynamic args (no peer file needed)
    # Password is read from chap-secrets (already configured during install)
    local PPPD_NIC="$MACVLAN"
    if [ "$ID" -eq 0 ]; then
        PPPD_NIC="$NIC"
    fi
    pppd plugin pppoe.so "nic-${PPPD_NIC}" user "$USER" \
        unit "$ID" noipdefault nodefaultroute hide-password noauth \
        nopersist maxfail 1 mtu 1492 mru 1492 \
        lcp-echo-interval 20 lcp-echo-failure 3 &
    disown

    # Wait for IP (max 15s)
    NEW_IP=""
    for i in $(seq 1 15); do
        NEW_IP=$(ip -4 addr show "$IFACE" 2>/dev/null | grep -oP 'inet \K[\d.]+' || true)
        if [ -n "$NEW_IP" ]; then
            break
        fi
        sleep 1
    done

    if [ -z "$NEW_IP" ]; then
        step "   ⚠️ Không nhận được IP, thử lại..."
        return 1
    fi

    # Check CGNAT
    if is_private_ip "$NEW_IP"; then
        step "   ⚠️ IP CGNAT: $NEW_IP — thử lại..."
        return 1
    fi

    step "   ✅ IP mới: $NEW_IP"
    return 0
}

# Main loop
for attempt in $(seq 1 $MAX_ATTEMPTS); do
    if do_rotate "$attempt"; then
        END=$(date +%s%3N)
        TOTAL=$(( END - START ))
        echo ""
        echo "⏱️  Tổng thời gian: ${TOTAL}ms ($attempt lần)"
        exit 0
    fi
    # Wait before retry — ISP needs cooldown to stop assigning CGNAT
    if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
        step "   ⏳ Chờ 10s để ISP reset..."
        sleep 10
    fi
done

echo "❌ Thất bại sau $MAX_ATTEMPTS lần thử"
exit 1

