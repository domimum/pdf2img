const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const fs = require('fs');
const path = require('path');

let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1000,
    minHeight: 640,
    title: 'PDF 拆页助手',
    backgroundColor: '#f0f2f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.loadFile(path.join(__dirname, 'index.html'));
  // 隐藏默认菜单栏，界面更干净（保留 ESC/关闭等快捷键）
  Menu.setApplicationMenu(null);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// 选择 PDF 文件：返回 { name, data: Uint8Array }
ipcMain.handle('open-pdf', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '打开 PDF 文件',
    filters: [{ name: 'PDF 文件', extensions: ['pdf'] }],
    properties: ['openFile']
  });
  if (res.canceled || !res.filePaths.length) return null;
  const p = res.filePaths[0];
  const buf = fs.readFileSync(p);
  return { name: path.basename(p), data: new Uint8Array(buf), dir: path.dirname(p) };
});

// 选择保存文件夹：返回路径
ipcMain.handle('pick-folder', async () => {
  const res = await dialog.showOpenDialog(win, {
    title: '选择保存位置',
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

// 写文件到磁盘
ipcMain.handle('save-file', async (event, folder, name, dataArray) => {
  try {
    const target = folder ? path.join(folder, name) : path.join(app.getPath('downloads'), name);
    fs.writeFileSync(target, Buffer.from(dataArray));
    return { ok: true, path: target };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 在系统文件管理器中显示文件
ipcMain.handle('show-item', async (event, p) => {
  try { require('electron').shell.showItemInFolder(p); } catch (e) {}
});
