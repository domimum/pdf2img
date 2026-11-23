#!/bin/bash
# PDF 渲染服务一键部署脚本（阿里云轻量云 Ubuntu/CentOS 通用）
# 用法：把整个 server 目录传到服务器，然后 bash deploy.sh

set -e
echo "========== PDF 渲染服务部署 =========="

# 1. 检查/安装 Node.js（需要 16+）
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" -lt 16 ]; then
  echo ">>> 安装 Node.js 18..."
  if command -v apt-get &> /dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
    apt-get install -y nodejs
  elif command -v yum &> /dev/null; then
    curl -fsSL https://rpm.nodesource.com/setup_18.x | bash -
    yum install -y nodejs
  else
    echo "❌ 无法识别系统，请手动安装 Node.js 18+"; exit 1
  fi
fi
echo ">>> Node 版本: $(node -v)"

# 2. 安装项目依赖
echo ">>> 安装依赖（首次约 2-5 分钟）..."
cd "$(dirname "$0")"
npm install --production --no-audit --no-fund

# 3. 生成 systemd 服务（开机自启 + 崩了自动重启）
echo ">>> 配置开机自启..."
DIR="$(pwd)"
cat > /etc/systemd/system/pdf-render.service <<EOF
[Unit]
Description=PDF Render Service
After=network.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=PORT=3000
Environment=RENDER_TOKEN=CHANGE_ME_TOKEN
ExecStart=/usr/bin/node $DIR/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pdf-render
systemctl restart pdf-render

echo ""
echo "========== 部署完成 =========="
echo "服务状态:"
systemctl status pdf-render --no-pager | head -12
echo ""
echo "测试: curl http://localhost:3000/health"
echo ""
echo "⚠️  重要："
echo "  1. 编辑 /etc/systemd/system/pdf-render.service 里的 RENDER_TOKEN，改成你自己的密钥"
echo "  2. 改完执行: systemctl daemon-reload && systemctl restart pdf-render"
echo "  3. 小程序里的 RENDER_TOKEN 要填同样的值"
