import { app, BrowserWindow, dialog, ipcMain, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RuntimeSettings, Settings } from '../shared/types';
import { translate, unchangedWarning } from '../shared/translation';
import { translateDocument } from './documents';

const defaults: Settings = { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini', sourceLang: '自动检测', targetLang: '简体中文', concurrency: 2, apiKeyConfigured: false };
let active: AbortController | null = null;
const settingsPath = () => join(app.getPath('userData'), 'settings.json');
const keyPath = () => join(app.getPath('userData'), 'api-key.bin');
async function getStoredKey(): Promise<string> {
  try { const encrypted = await readFile(keyPath()); return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(encrypted) : ''; } catch { return ''; }
}
async function getSettings(): Promise<Settings> {
  let stored: Record<string, unknown> = {};
  try { stored = JSON.parse(await readFile(settingsPath(), 'utf8')) as Record<string, unknown>; } catch { /* use defaults */ }
  const legacyKey = typeof stored.apiKey === 'string' ? stored.apiKey : '';
  if (legacyKey && safeStorage.isEncryptionAvailable() && !(await getStoredKey())) await writeFile(keyPath(), safeStorage.encryptString(legacyKey));
  const result: Settings = {
    baseUrl: typeof stored.baseUrl === 'string' ? stored.baseUrl : defaults.baseUrl,
    model: typeof stored.model === 'string' ? stored.model : defaults.model,
    sourceLang: typeof stored.sourceLang === 'string' ? stored.sourceLang : defaults.sourceLang,
    targetLang: typeof stored.targetLang === 'string' ? stored.targetLang : defaults.targetLang,
    concurrency: typeof stored.concurrency === 'number' ? Math.max(1, Math.min(6, Math.floor(stored.concurrency))) : defaults.concurrency,
    apiKeyConfigured: Boolean(await getStoredKey())
  };
  if ('apiKey' in stored) await writeFile(settingsPath(), JSON.stringify(result, null, 2), 'utf8');
  return result;
}
async function saveSettings(settings: Settings): Promise<Settings> {
  const next: Settings = { baseUrl: settings.baseUrl, model: settings.model, sourceLang: settings.sourceLang, targetLang: settings.targetLang, concurrency: Math.max(1, Math.min(6, Math.floor(settings.concurrency || defaults.concurrency))), apiKeyConfigured: Boolean(await getStoredKey()) };
  await writeFile(settingsPath(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}
async function updateApiKey(apiKey: string): Promise<Settings> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('系统安全存储不可用，无法保存 API 密钥。');
  if (apiKey.trim()) await writeFile(keyPath(), safeStorage.encryptString(apiKey.trim()));
  else { try { await writeFile(keyPath(), safeStorage.encryptString('')); } catch { /* clearing is best effort */ } }
  return getSettings();
}
async function runtimeSettings(settings: Settings): Promise<RuntimeSettings> { return { ...settings, apiKey: await getStoredKey() }; }

function createWindow() {
  const window = new BrowserWindow({ width: 1180, height: 760, minWidth: 900, minHeight: 620, backgroundColor: '#f2f4f3', title: '喵喵翻译', webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: !app.isPackaged } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (app.isPackaged) window.loadFile(join(__dirname, '../../dist/index.html')); else window.loadURL('http://localhost:5173');
}
app.whenReady().then(() => { createWindow(); app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

ipcMain.handle('settings:get', getSettings);
ipcMain.handle('settings:save', (_event, value: Settings) => saveSettings(value));
ipcMain.handle('settings:update-api-key', (_event, value: string) => updateApiKey(value));
ipcMain.handle('dialog:input', async () => (await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: '支持的文档', extensions: ['docx', 'pptx', 'xlsx', 'pdf'] }] })).filePaths[0] ?? null);
ipcMain.handle('dialog:output', async (_event, defaultPath: string) => (await dialog.showSaveDialog({ defaultPath, filters: [{ name: 'PDF 文档', extensions: ['pdf'] }, { name: 'Office 文档', extensions: ['docx', 'pptx', 'xlsx'] }] })).filePath ?? null);
ipcMain.handle('translate:text', async (_event, text: string, settings: Settings) => {
  active?.abort();
  const controller = new AbortController();
  active = controller;
  try {
    const runtime = await runtimeSettings(settings);
    const translated = await translate({ text, settings: runtime, signal: controller.signal });
    return { text: translated, warning: unchangedWarning(text, translated, runtime.sourceLang, runtime.targetLang) };
  } finally { if (active === controller) active = null; }
});
ipcMain.handle('translate:document', async (event, input: string, output: string, settings: Settings) => {
  active?.abort();
  const controller = new AbortController();
  active = controller;
  try { await translateDocument(input, output, await runtimeSettings(settings), controller.signal, p => event.sender.send('translate:progress', p)); }
  finally { if (active === controller) active = null; }
});
ipcMain.handle('translate:cancel', () => { active?.abort(); active = null; });
