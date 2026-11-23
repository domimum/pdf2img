/**
 * PDF 存图助手渲染服务
 * POST /render  —— 上传 PDF + 页码，返回渲染好的图片 base64
 * GET  /health  —— 健康检查（浏览器打开看是否正常）
 */

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const { renderPdf } = require('./render');

const app = express();
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.RENDER_TOKEN || '';   // 设在环境变量里，留空则不校验（本地测试用）

app.use(cors());

// 内存上传，限制 40MB（教材 PDF 一般几 MB），不落盘
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024 },
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'pdf-render', time: new Date().toISOString() });
});

app.post('/render', upload.single('file'), async (req, res) => {
  // 简单的 token 校验，防止别人盗用你的服务器
  if (TOKEN && req.headers['x-render-token'] !== TOKEN) {
    return res.status(403).json({ error: '无权访问' });
  }
  if (!req.file) {
    return res.status(400).json({ error: '缺少 PDF 文件' });
  }
  // 校验是 PDF（读文件头 %PDF）
  const head = req.file.buffer.slice(0, 5).toString();
  if (head.indexOf('%PDF') !== 0) {
    return res.status(400).json({ error: '文件不是有效的 PDF' });
  }

  try {
    // pages: "1,2,3"，height: px，format: png|jpeg
    const pages = String(req.body.pages || '')
      .split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
    const height = parseInt(req.body.height, 10) || 1200;
    const format = req.body.format === 'jpeg' ? 'jpeg' : 'png';

    const result = await renderPdf(req.file.buffer, pages, height, format);
    res.json(result);
  } catch (e) {
    console.error('[render error]', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

//  multer 上传超限等错误处理
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'PDF 文件超过 40MB 限制' });
  }
  console.error('[server error]', err);
  res.status(500).json({ error: '服务器错误' });
});

app.listen(PORT, () => {
  console.log(`[pdf-render] 服务已启动: http://localhost:${PORT}`);
  console.log(`[pdf-render] 健康检查: http://localhost:${PORT}/health`);
  if (!TOKEN) console.warn('[pdf-render] 警告: 未设置 RENDER_TOKEN，任何人都能调用（本地测试可忽略）');
});
