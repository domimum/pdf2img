// 示例配置：复制本文件为同目录的 config.js，填入你自己的值后再编译小程序。
// config.js 已被 .gitignore 排除，不会提交到仓库（真实密钥不进公开仓库）。
// RENDER_TOKEN 与服务器 /etc/systemd/system/pdf-render.service 里的 RENDER_TOKEN 保持一致。
module.exports = {
  SERVER_URL: 'https://pdf.qimingxing.top',
  RENDER_TOKEN: '在这里填你的48位密钥（服务器与本地保持一致）',
};
