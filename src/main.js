const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require('electron');
const path  = require('path');
const fs    = require('fs');
const https = require('https');
const http  = require('http');

const API_BASE = 'https://api.timelink.digital';

// ── 다크 테마 강제 ──
nativeTheme.themeSource = 'dark';

let mainWindow = null;
let currentTLFile = null;

// ── 메인 윈도우 생성 ──
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 440,
    height: 700,
    minWidth: 380,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#08080F',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: {
      preload:        path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webSecurity:      true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // 프로덕션에서 메뉴 숨김
  if (!process.env.DEV) mainWindow.setMenu(null);
}

// ── .tl 파일 열기 ──
function openTLFile(filePath) {
  if (!filePath || !filePath.endsWith('.tl')) return;
  currentTLFile = filePath;
  if (mainWindow) {
    mainWindow.webContents.send('tl-file-open', filePath);
  }
}

// ── 앱 시작 ──
app.whenReady().then(() => {
  createWindow();

  // macOS: dock 아이콘 클릭
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // .tl 파일 연결 프로그램으로 열리면 (Windows)
  const argv = process.argv;
  const tlArg = argv.find(a => a.endsWith('.tl'));
  if (tlArg && fs.existsSync(tlArg)) {
    mainWindow.webContents.once('did-finish-load', () => openTLFile(tlArg));
  }
});

// macOS: .tl 파일 열기 이벤트
app.on('open-file', (event, filePath) => {
  event.preventDefault();
  if (mainWindow) openTLFile(filePath);
  else app.whenReady().then(() => {
    createWindow();
    mainWindow.webContents.once('did-finish-load', () => openTLFile(filePath));
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ════════════════════════════════════════════
// IPC 핸들러
// ════════════════════════════════════════════

// .tl 파일 파싱 (메인 프로세스에서 처리)
ipcMain.handle('parse-tl-file', async (event, filePath) => {
  try {
    const buf  = fs.readFileSync(filePath);
    const data = new Uint8Array(buf);

    // 매직 확인
    if (data[0]!==0x54||data[1]!==0x4C||data[2]!==0x4E||data[3]!==0x4B) {
      return { error: '유효하지 않은 .tl 파일입니다.' };
    }
    // 헤더 파싱
    const hdrLen = data[6]|(data[7]<<8)|(data[8]<<16)|(data[9]<<24);
    const hdrBytes = data.slice(10, 10 + hdrLen);
    const header = JSON.parse(Buffer.from(hdrBytes).toString('utf8'));
    return { ok: true, header, fileSize: data.length };
  } catch(e) {
    return { error: e.message };
  }
});

// 서버에서 복호화된 스트림 가져오기
ipcMain.handle('decrypt-stream', async (event, { shareId, token }) => {
  return new Promise((resolve) => {
    const opts = {
      hostname: 'api.timelink.digital',
      path:     `/api/decrypt/${shareId}`,
      method:   'POST',
      headers:  { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    };
    const req = https.request(opts, (res) => {
      if (res.statusCode === 402) {
        resolve({ error: 'TL_INSUFFICIENT', tl: 0 }); return;
      }
      if (res.statusCode !== 200) {
        resolve({ error: `HTTP ${res.statusCode}` }); return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const tlHeader = res.headers['x-tl-header'];
        resolve({ ok: true, data: buf.toString('base64'), tlHeader });
      });
    });
    req.on('error', e => resolve({ error: e.message }));
    req.end();
  });
});

// TL tick (1초 차감)
ipcMain.handle('tl-tick', async (event, { shareId, token, deduct_rate }) => {
  return new Promise((resolve) => {
    const body = JSON.stringify({ seconds:1, deduct_rate: deduct_rate||1.0 });
    const opts = {
      hostname: 'api.timelink.digital',
      path:     `/api/stream/${shareId}/tick`,
      method:   'POST',
      headers:  { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
                  'Content-Length': Buffer.byteLength(body) },
    };
    const req = https.request(opts, (res) => {
      let d=''; res.on('data',c=>d+=c);
      res.on('end', ()=>{ try{resolve(JSON.parse(d));}catch(e){resolve({ok:false});} });
    });
    req.on('error', e => resolve({ ok:false, error:e.message }));
    req.write(body); req.end();
  });
});

// 파일 열기 다이얼로그
ipcMain.handle('open-file-dialog', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'TL 파일 열기',
    filters: [{ name: 'TimeLink Files', extensions: ['tl'] }],
    properties: ['openFile'],
  });
  return result.canceled ? null : result.filePaths[0];
});

// 토큰 저장/로드 (electron-store 대신 파일 기반)
const STORE_PATH = path.join(app.getPath('userData'), 'tl_auth.json');
ipcMain.handle('store-get', (e, key) => {
  try {
    const d = JSON.parse(fs.readFileSync(STORE_PATH,'utf8'));
    return d[key];
  } catch { return null; }
});
ipcMain.handle('store-set', (e, key, val) => {
  let d = {};
  try { d = JSON.parse(fs.readFileSync(STORE_PATH,'utf8')); } catch {}
  d[key] = val;
  fs.writeFileSync(STORE_PATH, JSON.stringify(d), 'utf8');
});
