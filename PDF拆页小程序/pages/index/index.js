const pdfLib = require('../../utils/pdf-lib.js');

// ===== 自有服务器渲染配置 =====
// 真实值在不入库的 config.js（同目录参考 config.example.js 复制一份填好即可）
// RENDER_TOKEN 要和服务器 /etc/systemd/system/pdf-render.service 里的值保持一致
let serverConfig = { SERVER_URL: '', RENDER_TOKEN: '' };
try { serverConfig = require('../../config.js'); } catch (e) {}
const SERVER_URL = serverConfig.SERVER_URL;
const RENDER_TOKEN = serverConfig.RENDER_TOKEN;
const IMG_HEIGHT = 1800;   // 渲染高度：A4 打印清晰档

// 给异步操作加超时保护，避免云函数卡住时界面无限等待
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error((label || '操作') + '超时')), ms);
    }),
  ]);
}

// 把数组切成固定大小的批次
function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

Page({
  data: {
    viewState: 'empty',       // empty | loading | ready | error
    errMsg: '',
    fileName: '',
    pageCount: 0,
    pages: [],                // [{ n, selected }]
    selectedCount: 0,
    exporting: false,
    fileSizeText: '',
    rangeText: '',            // 范围选页输入（如 5-20, 33）
    outImages: [],            // 已导出的本地图片路径 [{ page, path }]
    statusBarH: 20,           // 状态栏高度 px（自定义导航栏避让用）
    navBarH: 44,              // 导航栏内容区高度 px
  },

  onLoad() {
    // 自定义导航栏：读取状态栏与右上角胶囊位置，精确避让
    let statusBarH = 20;
    try {
      const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
      statusBarH = win.statusBarHeight || 20;
    } catch (e) {}
    this.setData({ statusBarH });
  },

  // 从微信聊天里选一个 PDF 文件
  chooseFile() {
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['pdf'],
      success: (res) => {
        const f = res.tempFiles && res.tempFiles[0];
        if (!f) return;
        this.loadPdf(f.path, f.name, f.size);
      },
      fail: (err) => {
        if (err && err.errMsg && err.errMsg.indexOf('cancel') > -1) return;
        this.setData({ viewState: 'error', errMsg: '选择文件失败，请重试' });
      },
    });
  },

  // 微信原生查看 PDF 全文：秒开、全部页、双指放大字字清晰、完全免费。
  // 这是手机上"看内容"的最佳方式——看完记住页码，回来勾选。
  openFullPdf() {
    if (!this._localPath) {
      wx.showToast({ title: '文件已失效，请重新选择', icon: 'none' });
      return;
    }
    wx.openDocument({
      filePath: this._fullPath || this._localPath,
      fileType: 'pdf',
      showMenu: true,
      fail: () => wx.showToast({ title: '打开失败，请重新选择 PDF', icon: 'none' }),
    });
  },

  async loadPdf(path, name, size) {
    this.setData({
      viewState: 'loading', errMsg: '', outImages: [], rangeText: '',
    });
    this._doc = null;
    this._hiRes = {};   // 单页高清预览缓存
    try {
      const fs = wx.getFileSystemManager();
      const ab = await new Promise((resolve, reject) => {
        fs.readFile({ filePath: path, success: (r) => resolve(r.data), fail: reject });
      });
      const bytes = new Uint8Array(ab);
      this._srcBytes = bytes;
      this._localPath = path;
      // 全文查看用：复制一份以原 PDF 名称命名的文件。
      // wx.openDocument 的标题取文件路径名，微信聊天文件是 hash 路径会显示乱码，
      // 用真实文件名命名后标题栏就能显示正确的 PDF 名称。
      try {
        const safeName = (name || '文档.pdf').replace(/[\\/:*?"<>|]/g, '_');
        const namedPath = wx.env.USER_DATA_PATH + '/' + safeName;
        try { fs.unlinkSync(namedPath); } catch (e) {}   // 同名覆盖前先删，避免读到旧内容
        fs.copyFileSync(path, namedPath);
        this._fullPath = namedPath;
      } catch (e) {
        this._fullPath = path;   // 复制失败退回原路径，至少能打开
      }
      const doc = await pdfLib.PDFDocument.load(bytes, { ignoreEncryption: true });
      this._doc = doc;
      const n = doc.getPageCount();
      const pages = [];
      for (let i = 0; i < n; i++) pages.push({ n: i + 1, selected: false });
      // 解析完立即显示页码网格——零云端渲染、零等待、零费用
      this.setData({
        viewState: 'ready',
        fileName: name || '未命名.pdf',
        pageCount: n,
        pages,
        selectedCount: 0,
        fileSizeText: size ? (size / 1024 / 1024).toFixed(1) + ' MB' : '',
      });
    } catch (e) {
      this.setData({
        viewState: 'error',
        errMsg: '无法读取这个 PDF，请确认文件没加密或损坏',
      });
    }
  },

  // 本地文档只解析一次，后面所有抽页复用
  async getDoc() {
    if (this._doc) return this._doc;
    this._doc = await pdfLib.PDFDocument.load(this._srcBytes, { ignoreEncryption: true });
    return this._doc;
  },

  // 从已加载的文档里抽出指定页（1-based），做成小 PDF 字节
  async extractSubPdf(pageNumbers) {
    const doc = await this.getDoc();
    const out = await pdfLib.PDFDocument.create();
    const idxs = pageNumbers.map((n) => n - 1);
    const copied = await out.copyPages(doc, idxs);
    copied.forEach((pg) => out.addPage(pg));
    return await out.save({ useObjectStreams: false });
  },

  // 渲染一批页：把小 PDF 上传到自有服务器，直接拿回渲染好的图片（base64），写入本地临时文件
  // 一次请求完成 上传+渲染+取图，不再经过云存储 / 云函数 / 二次下载
  // 返回 [{ page: 原页码, path: 本地图片路径 }]
  async renderBatch(pageNumbers, height, format) {
    const fs = wx.getFileSystemManager();
    const small = await this.extractSubPdf(pageNumbers);
    const smallPath = wx.env.USER_DATA_PATH + '/sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6) + '.pdf';
    await new Promise((resolve, reject) => {
      fs.writeFile({
        filePath: smallPath,
        data: small.buffer.slice(small.byteOffset, small.byteOffset + small.byteLength),
        success: resolve,
        fail: reject,
      });
    });

    let res;
    try {
      res = await withTimeout(
        new Promise((resolve, reject) => {
          wx.uploadFile({
            url: SERVER_URL + '/render',
            filePath: smallPath,
            name: 'file',
            header: { 'x-render-token': RENDER_TOKEN },
            formData: {
              pages: pageNumbers.map((_, i) => i + 1).join(','),  // 小 PDF 里的页码
              height: String(height),
              format,
            },
            success: resolve,
            fail: reject,
          });
        }),
        60000,
        '渲染'
      );
    } finally {
      try { fs.unlinkSync(smallPath); } catch (e) {}
    }

    let result;
    try {
      result = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    } catch (e) {
      throw new Error('服务器返回格式错误，请检查域名配置');
    }
    if (result.error) throw new Error(result.error);

    const thumbs = [];
    for (const t of (result.thumbs || [])) {
      if (!t || !t.base64) continue;
      const imgPath = wx.env.USER_DATA_PATH + '/img_' + Date.now() + '_' + t.page + '_' + Math.random().toString(36).slice(2, 6) + '.png';
      await new Promise((resolve, reject) => {
        fs.writeFile({ filePath: imgPath, data: t.base64, encoding: 'base64', success: resolve, fail: reject });
      });
      thumbs.push({ page: pageNumbers[t.page - 1], path: imgPath });  // 映射回原 PDF 页码
    }
    if (!thumbs.length) {
      const first = (result.thumbs || [])[0];
      throw new Error((first && first.error) || '服务器未返回图片');
    }
    return thumbs;
  },

  // 通用：把页码分批渲染，并发执行，每批失败自动重试 2 次
  // 只用于"保存选中页"和"单页高清预览"——不做全页缩略图，省钱省时
  async renderPages(pageNumbers, height, format, onProgress) {
    const batchSize = 4;
    const concurrency = 3;
    const batches = chunk(pageNumbers, batchSize);
    const thumbs = [];
    let doneCount = 0;
    let cursor = 0;

    async function worker() {
      while (cursor < batches.length) {
        const batch = batches[cursor++];
        let got = null;
        for (let attempt = 0; attempt < 3 && !got; attempt++) {
          try {
            got = await this.renderBatch(batch, height, format);
          } catch (e) {
            if (!this._lastRenderError) this._lastRenderError = (e && e.message) || String(e);
          }
        }
        if (got) thumbs.push(...got);
        doneCount += batch.length;
        if (onProgress) onProgress(doneCount, pageNumbers.length);
      }
    }
    this._lastRenderError = '';
    const workers = [];
    for (let w = 0; w < Math.min(concurrency, batches.length); w++) {
      workers.push(worker.call(this));
    }
    await Promise.all(workers);
    return thumbs;
  },

  // 点页码卡片 = 勾选/取消
  togglePage(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const pages = this.data.pages.slice();
    if (!pages[idx]) return;
    pages[idx] = Object.assign({}, pages[idx], { selected: !pages[idx].selected });
    this.setData({ pages, selectedCount: pages.filter((p) => p.selected).length });
  },

  selectAll() {
    const pages = this.data.pages.map((p) => Object.assign({}, p, { selected: true }));
    this.setData({ pages, selectedCount: pages.length });
  },

  selectNone() {
    const pages = this.data.pages.map((p) => Object.assign({}, p, { selected: false }));
    this.setData({ pages, selectedCount: 0 });
  },

  // 范围快速选页：支持 "5-20"、"33"、"5-20, 33, 45"
  onRangeInput(e) {
    this.setData({ rangeText: e.detail.value });
  },

  applyRange() {
    const txt = (this.data.rangeText || '').trim();
    if (!txt) {
      wx.showToast({ title: '先输入页码，如 5-20', icon: 'none' });
      return;
    }
    const pages = this.data.pages.slice();
    let hit = 0;
    txt.split(/[,，、\s]+/).forEach((part) => {
      if (!part) return;
      const m = part.match(/^(\d+)(?:\s*[-—–~至]\s*(\d+))?$/);
      if (!m) return;
      const a = parseInt(m[1], 10);
      const b = m[2] !== undefined ? parseInt(m[2], 10) : a;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      for (let n = lo; n <= hi && n <= pages.length; n++) {
        if (n >= 1 && pages[n - 1]) {
          pages[n - 1] = Object.assign({}, pages[n - 1], { selected: true });
          hit++;
        }
      }
    });
    if (!hit) {
      wx.showToast({ title: '没识别到有效页码', icon: 'none' });
      return;
    }
    this.setData({ pages, selectedCount: pages.filter((p) => p.selected).length });
  },

  // 单页预览：本地抽出这一页做成单页 PDF，交给微信原生打开。
  // 不再走云端渲染 JPEG——那又慢（一次完整云调用+冷启动）、又糊
  // （重新光栅化 + 二次有损压缩 + 放大，文字会出现彩色重影），还烧积分。
  // 原生打开：秒开、PDF 原始画质、双指放大清晰、完全免费、零云调用。
  // 点放大镜：抽单页 → 微信原生打开。文件名即标题栏文字，命名成"第 N 页"让顶部显示对应页码
  async previewPage(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const page = this.data.pages[idx];
    if (!page) return;
    wx.showLoading({ title: '正在打开第 ' + page.n + ' 页…', mask: true });
    try {
      const bytes = await this.extractSubPdf([page.n]);
      const fs = wx.getFileSystemManager();
      const p = wx.env.USER_DATA_PATH + '/第' + page.n + '页.pdf';
      try { fs.unlinkSync(p); } catch (e) { /* 文件不存在，忽略 */ }  // 防止重复打开时内容被缓存
      await new Promise((resolve, reject) => {
        fs.writeFile({
          filePath: p,
          data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          success: resolve,
          fail: reject,
        });
      });
      wx.hideLoading();
      wx.openDocument({
        filePath: p,
        fileType: 'pdf',
        showMenu: true,
        fail: () => wx.showToast({ title: '打开失败，请重试', icon: 'none' }),
      });
    } catch (err) {
      wx.hideLoading();
      wx.showToast({ title: '预览失败：' + ((err && err.message) || '请重试'), icon: 'none' });
    }
  },

  pickedPages() {
    return this.data.pages
      .map((p, i) => (p.selected ? i + 1 : -1))
      .filter((n) => n > 0);
  },

  // 保存选中页为图片到相册（format: png | jpeg）
  // 只有这一步走云端：只渲染勾选的几页，1800px（A4 打印清晰档）
  async saveImages(format) {
    if (this.data.exporting) return;   // 生成中防重复点击（view 按钮没有 disabled 属性）
    format = format || 'jpeg';
    const picked = this.pickedPages();
    if (!picked.length) {
      wx.showToast({ title: '请先勾选页面', icon: 'none' });
      return;
    }
    const authorized = await this.ensurePhotoPermission();
    if (!authorized) return;

    this.setData({ exporting: true });
    // 点下去立刻弹加载框，别等第一批渲染完才弹（那段时间屏幕没反馈，显得很慢）
    wx.showLoading({ title: '正在保存图片…', mask: true });
    try {
      const thumbs = await this.renderPages(picked, IMG_HEIGHT, format, (done, total) => {
        wx.showLoading({ title: '正在生成 ' + done + '/' + total + ' 页…', mask: true });
      });
      if (!thumbs.length) throw new Error(this._lastRenderError || '生成失败');

      wx.showLoading({ title: '正在保存图片…', mask: true });
      // 图片已是本地路径（renderBatch 里写好的），直接存相册，无需再下载
      const out = thumbs.map((t) => ({ page: t.page, path: t.path }));

      let saved = 0;
      for (const item of out) {
        try {
          await new Promise((resolve, reject) => {
            wx.saveImageToPhotosAlbum({ filePath: item.path, success: resolve, fail: reject });
          });
          saved++;
        } catch (e) {}
      }
      wx.hideLoading();
      this.setData({ exporting: false, outImages: out });
      const failed = picked.length - saved;
      wx.showModal({
        title: saved ? '已保存 ' + saved + ' 张' + (format === 'png' ? 'PNG' : 'JPG') : '保存失败',
        content: saved
          ? (failed ? ('已存 ' + saved + ' 张，' + failed + ' 张失败，可重试') : '图片已存入手机相册')
          : '请检查是否允许保存到相册，然后重试',
        showCancel: false,
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ exporting: false });
      wx.showToast({ title: '生成失败：' + ((e && e.message) || '请重试'), icon: 'none' });
    }
  },

  savePng() { this.saveImages('png'); },
  saveJpg() { this.saveImages('jpeg'); },

  // 转发：把勾选页合成一个 PDF，直接转发给微信好友（一次一个文件，包含全部勾选页）
  async shareImages() {
    if (this.data.exporting) return;   // 生成中防重复点击（view 按钮没有 disabled 属性）
    if (this.pickedPages().length === 0) {
      wx.showToast({ title: '请先勾选页面', icon: 'none' });
      return;
    }
    this.setData({ exporting: true });
    wx.showLoading({ title: '正在生成…', mask: true });
    try {
      const built = await this.buildSelectedPdf();
      wx.hideLoading();
      this.setData({ exporting: false });
      if (!built) return;
      wx.shareFileMessage({
        filePath: built.outPath,
        fileName: built.outName,
        fail: () => wx.showToast({ title: '转发取消', icon: 'none' }),
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ exporting: false });
      wx.showToast({ title: '生成失败，请重试', icon: 'none' });
    }
  },

  async ensurePhotoPermission() {
    try {
      const setting = await new Promise((resolve) => wx.getSetting({ success: resolve }));
      if (setting.authSetting && setting.authSetting['scope.writePhotosAlbum'] === false) {
        const r = await new Promise((resolve) => wx.showModal({
          title: '需要相册权限',
          content: '请在设置里允许「保存到相册」，否则图片无法保存',
          confirmText: '去设置',
          cancelText: '取消',
          success: resolve,
        }));
        if (!r.confirm) return false;
        const opened = await new Promise((resolve) => wx.openSetting({ success: resolve }));
        return !!(opened.authSetting && opened.authSetting['scope.writePhotosAlbum']);
      }
      return true;
    } catch (e) {
      return true;
    }
  },

  // 把勾选页合成一个 PDF 文件，返回 { outPath, outName, pageTag, count }
  // 「存 PDF」和「转发」共用这一段；纯本地完成，完全免费
  async buildSelectedPdf() {
    const pickedNums = this.pickedPages();          // 1-based 页码，用于文件命名
    const picked = pickedNums.map((n) => n - 1);    // 0-based 索引，用于 copyPages
    if (!picked.length) {
      wx.showToast({ title: '请先勾选页面', icon: 'none' });
      return null;
    }
    const doc = await this.getDoc();
    const out = await pdfLib.PDFDocument.create();
    const copied = await out.copyPages(doc, picked);
    copied.forEach((pg) => out.addPage(pg));
    const bytes = await out.save({ useObjectStreams: false });

    const fs = wx.getFileSystemManager();
    const rawName = this.data.fileName || '文档.pdf';
    const baseName = (rawName.replace(/\.[^.]+$/, '') || '文档').replace(/[\\/:*?"<>|]/g, '_');
    // 文件名体现勾选的页码：单页"第6页"，连续"第6-8页"，不连续"第6-8,10页"
    const sortedNums = pickedNums.slice().sort((a, b) => a - b);
    let pageTag;
    if (sortedNums.length === 1) {
      pageTag = '第' + sortedNums[0] + '页';
    } else {
      let continuous = true;
      for (let i = 1; i < sortedNums.length; i++) {
        if (sortedNums[i] !== sortedNums[i - 1] + 1) { continuous = false; break; }
      }
      pageTag = continuous
        ? ('第' + sortedNums[0] + '-' + sortedNums[sortedNums.length - 1] + '页')
        : ('第' + sortedNums.join(',') + '页');
    }
    const outName = baseName + '-' + pageTag + '.pdf';
    const outPath = wx.env.USER_DATA_PATH + '/' + outName;
    try { fs.unlinkSync(outPath); } catch (e) { /* 文件不存在，忽略 */ }  // 防止 filename 相同导致微信读到旧缓存
    await new Promise((resolve, reject) => {
      fs.writeFile({
        filePath: outPath,
        data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        success: resolve,
        fail: reject,
      });
    });
    return { outPath, outName, pageTag, count: picked.length };
  },

  // 导出选中的页面为新 PDF（纯本地完成，完全免费）
  async exportPdf() {
    if (this.data.exporting) return;   // 生成中防重复点击（view 按钮没有 disabled 属性）
    if (this.pickedPages().length === 0) {
      wx.showToast({ title: '请先勾选页面', icon: 'none' });
      return;
    }
    this.setData({ exporting: true });
    wx.showLoading({ title: '正在生成…', mask: true });
    try {
      const built = await this.buildSelectedPdf();
      if (!built) { wx.hideLoading(); this.setData({ exporting: false }); return; }
      const { outPath, outName, pageTag, count } = built;
      wx.hideLoading();
      this.setData({ exporting: false });
      this._outPdf = outPath;
      wx.showModal({
        title: '已生成 ' + count + ' 页',
        content: '勾选页码：' + pageTag + '\n文件名：' + outName,
        cancelText: '打开预览',
        confirmText: '转发保存',
        success: (r) => {
          if (r.cancel) {
            wx.openDocument({
              filePath: outPath,
              fileType: 'pdf',
              showMenu: true,
              fail: () => wx.showToast({ title: '打开失败，可转发保存', icon: 'none' }),
            });
          } else if (r.confirm) {
            wx.shareFileMessage({
              filePath: outPath,
              fileName: outName,   // 强制指定转发文件名，避免微信复用旧缓存名
              fail: () => wx.showToast({ title: '转发取消', icon: 'none' }),
            });
          }
        },
      });
    } catch (e) {
      wx.hideLoading();
      this.setData({ exporting: false });
      wx.showToast({ title: '生成失败，请重试', icon: 'none' });
    }
  },

  sharePdf() {
    if (!this._outPdf) {
      wx.showToast({ title: '请先导出 PDF', icon: 'none' });
      return;
    }
    wx.shareFileMessage({
      filePath: this._outPdf,
      fail: () => wx.showToast({ title: '转发取消', icon: 'none' }),
    });
  },

  reset() {
    this.setData({
      viewState: 'empty', fileName: '', pageCount: 0, pages: [],
      selectedCount: 0, outImages: [], rangeText: '',
    });
    this._doc = null;
    this._srcBytes = null;
    this._localPath = null;
    this._hiRes = {};
    this._outPdf = null;
  },
});
