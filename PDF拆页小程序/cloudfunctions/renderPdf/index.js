/**
 * 云函数 renderPdf —— 把 PDF 指定页渲染成图片，返回图片 fileID 列表
 * 入参: { fileID, pages(1-based,可选), height(px,默认300), format('jpeg'|'png') }
 * 出参: { total, thumbs:[{page,fileID,error?}], error? }
 *
 * 关键点：所有依赖加载都放进 try/catch，任何崩溃都以 {error} 形式返回，
 * 这样前端界面能直接看到原因，不会再出现无日志的 145 静默崩溃。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

let napi = null;
let pdfjsLib = null;
let INIT_ERROR = '';

function initDeps() {
  try {
    // 0. 关键补丁：云函数 Node 版本较老，没有全局 DOMException，
    //    pdfjs-dist 加载时读 NativeDOMException.prototype 会崩溃（145 静默退出）。
    //    这里补一个最小实现，本地新 Node 已有则跳过。
    if (typeof globalThis.DOMException === 'undefined') {
      globalThis.DOMException = class DOMException extends Error {
        constructor(message, name) {
          super(message);
          this.name = name || 'Error';
        }
      };
    }

    // 0b. 第二个补丁：pdfjs 在渲染每页时会用 ReadableStream 做 worker 通信
    //     （sendWithStream → GetOperatorList）。云端老 Node 没有全局 ReadableStream，
    //     渲染时就会报 "ReadableStream is not defined"。三级兜底：
    //     ① 全局已有 ② Node 内置 stream/web（Node 16.5+）③ 纯 JS 最小实现
    if (typeof globalThis.ReadableStream === 'undefined') {
      try {
        globalThis.ReadableStream = require('stream/web').ReadableStream;
      } catch (e) {
        globalThis.ReadableStream = class MiniReadableStream {
          constructor(underlying) {
            underlying = underlying || {};
            this._q = []; this._r = []; this._c = false; this._e = null; this._p = false;
            const self = this;
            this._controller = {
              get desiredSize() { return 1; },
              enqueue(ch) {
                if (self._r.length) self._r.shift().resolve({ value: ch, done: false });
                else self._q.push(ch);
              },
              close() {
                self._c = true;
                while (self._r.length) self._r.shift().resolve({ value: undefined, done: true });
              },
              error(err) {
                self._e = err;
                while (self._r.length) self._r.shift().reject(err);
              },
            };
            if (underlying.start) {
              try { Promise.resolve(underlying.start(this._controller)).catch((err) => this._controller.error(err)); }
              catch (err) { this._controller.error(err); }
            }
            this._underlying = underlying;
          }
          _doPull() {
            if (this._p || !this._underlying.pull || this._c) return;
            this._p = true; const self = this;
            Promise.resolve().then(() => this._underlying.pull(this._controller))
              .catch((err) => this._controller.error(err)).finally(() => { self._p = false; });
          }
          getReader() {
            const self = this;
            return {
              read() {
                if (self._q.length) return Promise.resolve({ value: self._q.shift(), done: false });
                if (self._e) return Promise.reject(self._e);
                if (self._c) return Promise.resolve({ value: undefined, done: true });
                const p = new Promise((resolve, reject) => self._r.push({ resolve, reject }));
                self._doPull();
                return p;
              },
              cancel(reason) {
                if (self._underlying.cancel) return Promise.resolve(self._underlying.cancel(reason));
                return Promise.resolve();
              },
              releaseLock() {},
            };
          }
        };
      }
    }

    // 1. 原生 canvas（预编译二进制）。云端必须安装 linux-x64 平台包
    napi = require('@napi-rs/canvas');
    globalThis.DOMMatrix = napi.DOMMatrix;
    globalThis.Path2D = napi.Path2D;
    globalThis.ImageData = napi.ImageData;

    // 2. pdfjs 在 Node 下会 require('canvas')，拦截指向 napi-canvas
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function (request) {
      if (request === 'canvas') return napi;
      return originalLoad.apply(this, arguments);
    };

    // 3. pdfjs
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  } catch (e) {
    INIT_ERROR = '依赖加载失败: ' + String((e && (e.stack || e.message)) || e);
    console.error('[renderPdf] ' + INIT_ERROR);
  }
}
initDeps();

const fs = require('fs');
const os = require('os');
const path = require('path');

const THUMB_HEIGHT = 360;
const JPEG_QUALITY = 0.88;

exports.main = async (event) => {
  // 依赖没加载成功：直接把错误返回给前端显示
  if (INIT_ERROR) {
    return { error: INIT_ERROR };
  }
  const { fileID, pages, height, format } = event;
  if (!fileID) return { error: '缺少 fileID' };

  const targetHeight = Math.min(2400, Math.max(120, Number(height) || THUMB_HEIGHT));
  const isPng = format === 'png';
  const ext = isPng ? 'png' : 'jpg';

  let localPath;
  try {
    // 1. 从云存储下载 PDF
    const dl = await cloud.downloadFile({ fileID });
    localPath = path.join(os.tmpdir(), 'src_' + Date.now() + '.pdf');
    fs.writeFileSync(localPath, dl.fileContent);

    // 2. 解析 PDF
    const data = new Uint8Array(fs.readFileSync(localPath));
    const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    const total = doc.numPages;

    // 3. 页码
    let targets = [];
    if (Array.isArray(pages) && pages.length) {
      targets = pages.filter((p) => p >= 1 && p <= total);
    } else {
      for (let i = 1; i <= total; i++) targets.push(i);
    }

    // 4. 逐页渲染（串行），再把整批图片并行上传——比"渲染一张传一张"的纯串行快一倍以上
    const rendered = [];
    for (const pno of targets) {
      try {
        const page = await doc.getPage(pno);
        const vp0 = page.getViewport({ scale: 1 });
        const scale = targetHeight / vp0.height;
        const vp = page.getViewport({ scale });
        const canvas = napi.createCanvas(
          Math.max(1, Math.floor(vp.width)),
          Math.max(1, Math.floor(vp.height))
        );
        await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        const buf = isPng ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', JPEG_QUALITY);
        rendered.push({ page: pno, buf: Buffer.from(buf) });
      } catch (e) {
        rendered.push({ page: pno, error: String((e && e.message) || e) });
      }
    }

    // 并行上传（Promise.all 保序，结果顺序与页码顺序一致）
    const thumbs = await Promise.all(rendered.map(async (r) => {
      if (r.error) return { page: r.page, fileID: null, error: r.error };
      try {
        const cloudPath = 'thumbs/' + Date.now() + '_' + r.page + '_' + Math.random().toString(36).slice(2, 8) + '.' + ext;
        const up = await cloud.uploadFile({ cloudPath, fileContent: r.buf });
        return { page: r.page, fileID: up.fileID };
      } catch (e) {
        return { page: r.page, fileID: null, error: String((e && e.message) || e) };
      }
    }));

    // 不调用 doc.destroy()：它会在渲染完成后触发 pdfjs worker stream 的清理，
    // 在纯 JS ReadableStream 兜底下有竞态残留异常。云函数是一次性的，进程退出会自然回收。
    return { total, thumbs };
  } catch (e) {
    return { error: '渲染失败: ' + String((e && (e.stack || e.message)) || e) };
  } finally {
    if (localPath) { try { fs.unlinkSync(localPath); } catch (e) {} }
  }
};
