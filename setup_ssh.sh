#!/bin/bash
# ============================================
# Setup SSH Key cho Git trên VPS mới
# Chạy: bash setup_ssh.sh
# ============================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KEY_SOURCE="$SCRIPT_DIR/deploy_key"
SSH_DIR="$HOME/.ssh"
KEY_DEST="$SSH_DIR/id_ed25519_nest_pppoe"
SSH_CONFIG="$SSH_DIR/config"

# Kiểm tra file deploy_key có tồn tại không
if [ ! -f "$KEY_SOURCE" ]; then
    echo "❌ Không tìm thấy file deploy_key tại: $KEY_SOURCE"
    exit 1
fi

# Tạo thư mục .ssh nếu chưa có
mkdir -p "$SSH_DIR"
chmod 700 "$SSH_DIR"

# Copy private key vào .ssh
cp "$KEY_SOURCE" "$KEY_DEST"
chmod 600 "$KEY_DEST"

# Thêm cấu hình SSH cho GitHub (ghi đè nếu đã có)
# Xóa block cũ nếu tồn tại
if grep -q "# nest-pppoe-deploy" "$SSH_CONFIG" 2>/dev/null; then
    sed -i '/# nest-pppoe-deploy START/,/# nest-pppoe-deploy END/d' "$SSH_CONFIG"
fi

cat >> "$SSH_CONFIG" <<EOF
# nest-pppoe-deploy START
Host github.com
    HostName github.com
    User git
    IdentityFile $KEY_DEST
    IdentitiesOnly yes
    StrictHostKeyChecking no
# nest-pppoe-deploy END
EOF

chmod 600 "$SSH_CONFIG"

echo "✅ SSH key đã được cài đặt thành công!"
echo ""
echo "📋 Thông tin:"
echo "   Key: $KEY_DEST"
echo "   Config: $SSH_CONFIG"
echo ""
echo "🧪 Test kết nối GitHub:"
ssh -T git@github.com 2>&1 || true
echo ""
echo "📦 Clone repo:"
echo "   git clone git@github.com:nathando91/nest-pppoe.git"
