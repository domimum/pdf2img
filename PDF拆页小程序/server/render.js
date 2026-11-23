/**
 * 渲染核心 —— 从云函数 renderPdf 移植，改为返回 base64 图片（不再上传云存储）
 * 用 pdfjs-dist + @napi-rs/canvas，纯本地渲染，无腾讯云端依赖
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const JPEG_QUALITY = 0.88;
const MAX_HEIGHT = 1800;   // 打印清晰档，与小程序端一致

let napi = null;
let pdfjsLib = null;
let INIT_ERROR = '';

function initDeps() {
  try {
    // Node 16-18 兜底：pdfjs 需要 DOMException / ReadableStream
    if (typeof globalThis.DOMException === 'undefined') {
      globalThis.DOMException = class DOMException extends Error {
        constructor(message, name) { super(message); this.name = name || 'Error'; }
      };
    }
    if (typeof globalThis.ReadableStream === 'undefined') {
      try { globalThis.ReadableStream = require('stream/web').ReadableStream; } catch (e) {}
    }

    napi = require('@napi-rs/canvas');
    globalThis.DOMMatrix = napi.DOMMatrix;
    globalThis.Path2D = napi.Path2D;
    globalThis.ImageData = napi.ImageData;

    // pdfjs 在 Node 下会 require('canvas')，拦截指向 napi-canvas
    const Module = require('module');
    const originalLoad = Module._load;
    Module._load = function (request) {
      if (request === 'canvas') return napi;
      return originalLoad.apply(this, arguments);
    };

    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
  } catch (e) {
    INIT_ERROR = '依赖加载失败: ' + String((e && (e.stack || e.message)) || e);
    console.error('[render] ' + INIT_ERROR);
  }
}
initDeps();

// 简单并发闸门：2c2g 服务器最多同时跑 2 个渲染任务，避免内存爆掉
let running = 0;
const MAX_CONCURRENT = 2;
const queue = [];

function acquireSlot() {
  return new Promise((resolve) => {
    if (running < MAX_CONCURRENT) { running++; resolve(); }
    else queue.push(resolve);
  });
}
function releaseSlot() {
  running--;
  if (queue.length) { running++; queue.shift()(); }
}

/**
 * 渲染 PDF 的指定页
 * @param {Buffer} pdfBuffer PDF 文件二进制
 * @param {number[]} pages 1-based 页码（小 PDF 里相对页码）
 * @param {number} height 目标高度 px
 * @param {string} format 'png' | 'jpeg'
 * @returns {Promise<{total:number, thumbs:Array<{page:number, base64:string, error?:string}>}>}
 */
async function renderPdf(pdfBuffer, pages, height, format) {
  if (INIT_ERROR) throw new Error(INIT_ERROR);

  const targetHeight = Math.min(MAX_HEIGHT, Math.max(120, Number(height) || 1200));
  const isPng = format !== 'jpeg';
  const mime = isPng ? 'image/png' : 'image/jpeg';

  await acquireSlot();
  let tmpPath;
  try {
    // 写入临时文件（pdfjs 需要文件路径或 Uint8Array，这里用内存 Uint8Array，避免磁盘 IO）
    const data = new Uint8Array(pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength));
    const doc = await pdfjsLib.getDocument({ data, verbosity: 0 }).promise;
    const total = doc.numPages;

    let targets = [];
    if (Array.isArray(pages) && pages.length) {
      targets = pages.filter((p) => p >= 1 && p <= total);
    } else {
      for (let i = 1; i <= total; i++) targets.push(i);
    }

    const thumbs = [];
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
        thumbs.push({ page: pno, base64: Buffer.from(buf).toString('base64'), mime });
      } catch (e) {
        thumbs.push({ page: pno, error: String((e && e.message) || e) });
      }
    }
    return { total, thumbs };
  } finally {
    releaseSlot();
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch (e) {} }
  }
}

module.exports = { renderPdf, MAX_HEIGHT };
