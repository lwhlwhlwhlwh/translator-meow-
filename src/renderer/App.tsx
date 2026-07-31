import React, { useEffect, useState } from 'react';
import type { ProgressEvent, Settings } from '../shared/types';
import './styles.css';

const initial: Settings = { baseUrl: '', model: '', sourceLang: '自动检测', targetLang: '简体中文', concurrency: 2, apiKeyConfigured: false };
const languageDirections = [
  { label: '自动检测 → 简体中文', sourceLang: '自动检测', targetLang: '简体中文' },
  { label: '简体中文 → English', sourceLang: '简体中文', targetLang: 'English' },
  { label: 'English → 简体中文', sourceLang: 'English', targetLang: '简体中文' }
] as const;
export default function App() {
  const [tab, setTab] = useState<'text'|'file'|'settings'>('text');
  const [settings, setSettings] = useState(initial);
  const [apiKey, setApiKey] = useState('');
  const [source, setSource] = useState(''); const [result, setResult] = useState('');
  const [file, setFile] = useState(''); const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false); const [status, setStatus] = useState('就绪');
  const [warning, setWarning] = useState('');
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  useEffect(() => { window.app.getSettings().then(setSettings); return window.app.onProgress(event => { setProgress(event); if (event.warning) setWarning(event.warning); }); }, []);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setStatus('处理中'); setWarning(''); try { await fn(); setStatus('已完成'); } catch (e) { setStatus((e as Error).name === 'AbortError' ? '已取消' : (e as Error).message); } finally { setBusy(false); } };
  const choose = async () => { const path = await window.app.chooseInput(); if (path) { setFile(path); setOutput(path.replace(/(\.[^.]+)$/, '-translated$1')); } };
  const saveAll = () => run(async () => {
    let next = await window.app.saveSettings(settings);
    if (apiKey) { next = await window.app.updateApiKey(apiKey); setApiKey(''); }
    setSettings(next);
  });
  const clearKey = () => run(async () => { setSettings(await window.app.updateApiKey('')); setApiKey(''); });
  const selectDirection = (sourceLang: string, targetLang: string) => {
    const next = { ...settings, sourceLang, targetLang };
    setSettings(next);
    void window.app.saveSettings(next).then(setSettings).catch(() => undefined);
  };
  const activeDirection = languageDirections.find(direction => direction.sourceLang === settings.sourceLang && direction.targetLang === settings.targetLang)?.label ?? '自定义';
  return <div className="shell">
    <aside><div className="brand"><span className="mark">喵</span><div><b>喵喵翻译</b><small>文档翻译工作台</small></div></div>
      <nav aria-label="主导航"><button className={tab==='text'?'active':''} onClick={()=>setTab('text')}>直接翻译 <kbd>01</kbd></button><button className={tab==='file'?'active':''} onClick={()=>setTab('file')}>文档翻译 <kbd>02</kbd></button><button className={tab==='settings'?'active':''} onClick={()=>setTab('settings')}>接口设置 <kbd>03</kbd></button></nav>
      <div className="side-note">DOCX · PPTX · XLSX<br/>数字文本 PDF</div>
    </aside>
    <main><header><div><span className="eyebrow">TRANSLATION DESK</span><h1>{tab==='text'?'直接翻译':tab==='file'?'文档翻译':'接口设置'}</h1></div><div className="status"><i className={busy?'pulse':''}/>{status}</div></header>
      {warning&&<div className="warning" role="status">{warning}</div>}
      {tab==='text' && <section className="workspace"><LanguageDirectionControl settings={settings} activeDirection={activeDirection} onSelect={selectDirection}/><div className="pane"><label>原文 <span>{source.length} 字符</span></label><textarea value={source} onChange={e=>setSource(e.target.value)} placeholder="在这里粘贴要翻译的内容……"/></div><div className="divider">→</div><div className="pane"><label>译文 <button className="link" onClick={()=>navigator.clipboard.writeText(result)}>复制</button></label><textarea value={result} readOnly placeholder="译文会出现在这里"/></div><footer><span>{settings.sourceLang} → {settings.targetLang}</span><Action busy={busy} disabled={!source.trim()} onCancel={()=>window.app.cancel()} onClick={()=>run(async()=>{const next=await window.app.translateText(source,settings);setResult(next.text);setWarning(next.warning??'');})} label="开始翻译"/></footer></section>}
      {tab==='file' && <section className="card"><LanguageDirectionControl settings={settings} activeDirection={activeDirection} onSelect={selectDirection}/><div className="drop"><span className="file-glyph">文</span><h2>选择待翻译文档</h2><p>Office 文档保留结构；数字文本 PDF 在原页面上覆盖译文。</p><button className="secondary" onClick={choose}>选择文件</button></div>{file&&<div className="file-row"><div><small>输入文件</small><strong>{file}</strong></div><button className="link" onClick={choose}>更换</button></div>} {file&&<div className="file-row"><div><small>输出位置</small><strong>{output}</strong></div><button className="link" onClick={async()=>{const p=await window.app.chooseOutput(output);if(p)setOutput(p)}}>更改</button></div>}{progress&&busy&&<div className="progress"><div style={{width:`${progress.current/progress.total*100}%`}}/><span>{progress.message}</span></div>}<div className="card-actions"><span>扫描版 PDF 暂不支持</span><Action busy={busy} disabled={!file||!output} onCancel={()=>window.app.cancel()} onClick={()=>{setProgress(null);run(()=>window.app.translateDocument(file,output,settings));}} label="翻译文档"/></div></section>}
      {tab==='settings' && <section className="settings"><div className="setting-head"><h2>OpenAI 兼容接口</h2><p>请求由主进程发送；密钥经系统安全存储加密，界面无法读取原值。</p></div><LanguageDirectionControl settings={settings} activeDirection={activeDirection} onSelect={selectDirection}/><div className="grid"><Field label="源语言（可编辑）" value={settings.sourceLang} onChange={v=>setSettings({...settings,sourceLang:v})}/><Field label="目标语言（可编辑）" value={settings.targetLang} onChange={v=>setSettings({...settings,targetLang:v})}/></div><Field label="接口地址" value={settings.baseUrl} placeholder="https://api.openai.com/v1" onChange={v=>setSettings({...settings,baseUrl:v})}/><Field label="API 密钥" type="password" value={apiKey} placeholder={settings.apiKeyConfigured?'已配置；留空保持不变':'sk-…'} onChange={setApiKey}/>{settings.apiKeyConfigured&&<div className="key-state"><span>已配置密钥</span><button className="link" disabled={busy} onClick={clearKey}>清除</button></div>}<Field label="模型" value={settings.model} placeholder="gpt-4o-mini" onChange={v=>setSettings({...settings,model:v})}/><NumberField label="文档并发请求" value={settings.concurrency} min={1} max={6} onChange={v=>setSettings({...settings,concurrency:v})}/><div className="save"><button className="primary" disabled={busy} onClick={saveAll}>保存设置</button></div></section>}
    </main>
  </div>;
}
function LanguageDirectionControl({settings,activeDirection,onSelect}:{settings:Settings;activeDirection:string;onSelect:(sourceLang:string,targetLang:string)=>void}) { return <div className="language-direction" aria-label="翻译方向"><div><strong>翻译方向</strong><small>当前：{activeDirection === '自定义' ? `${settings.sourceLang} → ${settings.targetLang}` : activeDirection}</small></div><div className="direction-options">{languageDirections.map(direction=><button type="button" key={direction.label} className={activeDirection===direction.label?'selected':''} aria-pressed={activeDirection===direction.label} onClick={()=>onSelect(direction.sourceLang,direction.targetLang)}>{direction.label}</button>)}</div></div>; }
function Action({busy,disabled,onCancel,onClick,label}:{busy:boolean;disabled:boolean;onCancel:()=>void;onClick:()=>void;label:string}) { return busy?<button className="danger" onClick={onCancel}>取消任务</button>:<button className="primary" disabled={disabled} onClick={onClick}>{label} <span>↗</span></button>; }
function Field({label,value,onChange,placeholder='',type='text'}:{label:string;value:string;onChange:(v:string)=>void;placeholder?:string;type?:string}) { return <label className="field"><span>{label}</span><input type={type} value={value} placeholder={placeholder} onChange={e=>onChange(e.target.value)}/></label>; }
function NumberField({label,value,min,max,onChange}:{label:string;value:number;min:number;max:number;onChange:(v:number)=>void}) { return <label className="field"><span>{label}（{value}）</span><input type="range" value={value} min={min} max={max} step={1} onChange={e=>onChange(Number(e.target.value))}/></label>; }
