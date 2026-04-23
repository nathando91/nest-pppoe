#!/bin/bash
# lan.sh — Bật tất cả interface ethernet lên để nhận cable

echo "🔍 Scanning network interfaces..."

UP=0
ALREADY=0

for iface in $(ls /sys/class/net/); do
    # Bỏ qua lo và docker/virtual interfaces
    [[ "$iface" == "lo" ]] && continue
    [[ "$iface" == docker* ]] && continue
    [[ "$iface" == br-* ]] && continue
    [[ "$iface" == veth* ]] && continue

    STATE=$(cat /sys/class/net/$iface/operstate 2>/dev/null)
    FLAGS=$(ip link show $iface 2>/dev/null | head -1)

    # Nếu chưa được set UP (có "qdisc noop" hoặc không có UP flag)
    if echo "$FLAGS" | grep -q "NO-CARRIER\|qdisc noop" || ! echo "$FLAGS" | grep -q ",UP"; then
        ip link set "$iface" up 2>/dev/null && echo "  ✅ $iface → UP" && ((UP++))
    else
        echo "  ⚡ $iface → already UP (state: $STATE)"
        ((ALREADY++))
    fi
done

echo ""
echo "✔  Done! Brought up: $UP interface(s), Already active: $ALREADY"
echo ""

# Hiện trạng thái sau khi up
echo "📡 Current link status:"
for iface in $(ls /sys/class/net/); do
    [[ "$iface" == "lo" ]] && continue
    [[ "$iface" == docker* ]] && continue
    [[ "$iface" == br-* ]] && continue
    [[ "$iface" == veth* ]] && continue

    STATE=$(cat /sys/class/net/$iface/operstate 2>/dev/null)
    IP=$(ip -4 addr show $iface 2>/dev/null | grep -oP '(?<=inet )\S+' || echo "no IP")

    if [[ "$STATE" == "up" ]]; then
        echo "  🟢 $iface → UP  |  IP: $IP"
    else
        echo "  🔴 $iface → DOWN (no cable?)"
    fi
done
