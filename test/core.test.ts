import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { completionUrl, createRateLimitGate, extractTranslationText, isMeaningfulUnchanged, translate, unchangedWarning } from '../src/shared/translation';
import type { RuntimeSettings } from '../src/shared/types';
import { decodeXml, encodeXml, extractTextNodes, inferPdfTextBlocks, replaceTextNodes } from '../src/main/documents';

describe('product branding and language directions', () => {
  it('keeps the storage app id while exposing the new product name', () => {
    const builder = readFileSync(resolve(__dirname, '../electron-builder.yml'), 'utf8');
    const packageJson = readFileSync(resolve(__dirname, '../package.json'), 'utf8');
    expect(builder).toContain('appId: com.translatormeow.app');
    expect(builder).toContain('productName: 喵喵翻译');
    expect(packageJson).toContain('"productName": "喵喵翻译"');
  });

  it('includes persistent supported directions in the Chinese UI', () => {
    const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8');
    for (const label of ['自动检测 → 简体中文', '简体中文 → English', 'English → 简体中文']) expect(app).toContain(label);
    expect(app).toContain('window.app.saveSettings(next)');
    expect(app).toContain('window.app.translateText(source,settings)');
    expect(app).toContain('window.app.translateDocument(file,output,settings)');
  });
});
describe('completionUrl', () => {
  it('appends compatible endpoint', () => expect(completionUrl('https://api.example/v1/')).toBe('https://api.example/v1/chat/completions'));
  it('does not append twice', () => expect(completionUrl('https://api.example/chat/completions')).toBe('https://api.example/chat/completions'));
  it('preserves query parameters used by compatible providers', () => expect(completionUrl('https://api.example/v1?api-version=1')).toBe('https://api.example/v1/chat/completions?api-version=1'));
  it.each(['not a url', 'file:///tmp/api', 'https://user:secret@api.example/v1'])('rejects unsafe endpoint %s', endpoint => {
    expect(() => completionUrl(endpoint)).toThrow(/接口地址/);
  });
});
describe('translation responses', () => {
  it.each([
    [{ choices: [{ message: { content: '你好' } }] }, '你好'],
    [{ choices: [{ message: { content: [{ type: 'text', text: '你' }, { type: 'text', text: '好' }] } }] }, '你好'],
    [{ choices: [{ text: '你好' }] }, '你好'],
    [{ output_text: '你好' }, '你好'],
    [{ output: [{ content: [{ type: 'output_text', text: '你' }, { type: 'output_text', text: '好' }] }] }, '你好']
  ])('extracts a supported response shape', (response, expected) => expect(extractTranslationText(response)).toBe(expected));
  it('describes unsupported response shapes', () => expect(() => extractTranslationText({ id: 'x', result: 'hello' })).toThrow(/顶层字段：id、result/));
  it('warns for meaningful echoes but ignores likely false positives', () => {
    expect(unchangedWarning('This is a complete sentence for translation.', 'This is a complete sentence for translation.', '英语', '简体中文')).toMatch(/译文与原文/);
    for (const text of ['OK', 'OpenAI', '12345', 'https://example.com', 'Ada Lovelace']) expect(isMeaningfulUnchanged(text, text, '英语', '简体中文')).toBe(false);
    expect(isMeaningfulUnchanged('This sentence stays in English.', 'This sentence stays in English.', '英语', '英语')).toBe(false);
  });
  it('rejects empty and unreasonably large requests before fetch', async () => {
    const settings: RuntimeSettings = { baseUrl: 'https://example.test/v1', model: 'fake', sourceLang: '英语', targetLang: '简体中文', concurrency: 1, apiKey: '' };
    await expect(translate({ text: '   ', settings })).rejects.toThrow(/没有可翻译/);
    await expect(translate({ text: 'x'.repeat(100_001), settings })).rejects.toThrow(/100,000/);
  });

  it('does not fetch when the request was already cancelled', async () => {
    const settings: RuntimeSettings = { baseUrl: 'https://example.test/v1', model: 'fake', sourceLang: '英语', targetLang: '简体中文', concurrency: 1, apiKey: '' };
    const controller = new AbortController();
    controller.abort();
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = (async () => { fetched = true; return Response.json({ output_text: '不应执行' }); }) as typeof fetch;
    try {
      await expect(translate({ text: 'This request is already cancelled.', settings, signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetched).toBe(false);
    } finally { globalThis.fetch = originalFetch; }
  });
});
describe('rate limit handling', () => {
  const settings: RuntimeSettings = { baseUrl: 'https://example.test/v1', model: 'fake', sourceLang: '英语', targetLang: '简体中文', concurrency: 2, apiKey: 'test' };

  it('honors Retry-After and recovers', async () => {
    let calls = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ++calls === 1
      ? new Response('{"error":{"message":"slow down"}}', { status: 429, headers: { 'Retry-After': '0.02' } })
      : Response.json({ choices: [{ message: { content: '译文' } }] })) as typeof fetch;
    try {
      const started = Date.now();
      await expect(translate({ text: 'source', settings, signal: new AbortController().signal })).resolves.toBe('译文');
      expect(calls).toBe(2);
      expect(Date.now() - started).toBeGreaterThanOrEqual(15);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('uses a shared gate to avoid a retry storm', async () => {
    let calls = 0;
    const callTimes: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      callTimes.push(Date.now());
      calls++;
      if (calls === 1) return new Response('limited', { status: 429, headers: { 'Retry-After': '0.04' } });
      return Response.json({ output_text: `译文${calls}` });
    }) as typeof fetch;
    try {
      const gate = createRateLimitGate();
      await Promise.all([
        translate({ text: 'one', settings, rateLimitGate: gate }),
        translate({ text: 'two', settings, rateLimitGate: gate }),
        translate({ text: 'three', settings, rateLimitGate: gate })
      ]);
      expect(calls).toBe(4);
      expect(callTimes[3] - callTimes[0]).toBeGreaterThanOrEqual(30);
    } finally { globalThis.fetch = originalFetch; }
  });

  it('cancels during a shared cooldown', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('limited', { status: 429, headers: { 'Retry-After': '1' } })) as typeof fetch;
    const controller = new AbortController();
    try {
      const request = translate({ text: 'source', settings, signal: controller.signal, rateLimitGate: createRateLimitGate() });
      setTimeout(() => controller.abort(), 20);
      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
    } finally { globalThis.fetch = originalFetch; }
  });

  it('gives actionable guidance for permanent 429 responses', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('{"error":{"message":"quota exceeded"}}', { status: 429, headers: { 'Retry-After': '0' } })) as typeof fetch;
    try {
      await expect(translate({ text: 'source', settings })).rejects.toThrow(/降低文档并发数.*额度/);
    } finally { globalThis.fetch = originalFetch; }
  });
});
describe('OOXML text nodes', () => {
  it('encodes and decodes entities', () => expect(decodeXml(encodeXml('A&B <C> "D"'))).toBe('A&B <C> "D"'));
  it('extracts and replaces docx nodes without changing structure', () => {
    const xml = '<w:p><w:r><w:t>Hello &amp; </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p><w:p><w:r><w:t>Other</w:t></w:r></w:p>';
    expect(extractTextNodes(xml, '.docx')).toEqual(['Hello & world', 'Other']);
    expect(replaceTextNodes(xml, '.docx', ['你好 & 世界', '另一个'])).toBe('<w:p><w:r><w:t>你好 &amp; 世界</w:t></w:r><w:r><w:t></w:t></w:r></w:p><w:p><w:r><w:t>另一个</w:t></w:r></w:p>');
  });
  it('redistributes longer and shorter translations across existing docx and pptx runs', () => {
    const docx = '<w:p><w:r><w:t>A</w:t></w:r><w:r><w:t>B</w:t></w:r><w:r><w:t>C</w:t></w:r></w:p>';
    expect(replaceTextNodes(docx, '.docx', ['longer text'])).toBe('<w:p><w:r><w:t>l</w:t></w:r><w:r><w:t>o</w:t></w:r><w:r><w:t>nger text</w:t></w:r></w:p>');
    expect(replaceTextNodes(docx, '.docx', ['X'])).toBe('<w:p><w:r><w:t>X</w:t></w:r><w:r><w:t></w:t></w:r><w:r><w:t></w:t></w:r></w:p>');
    const pptx = '<a:p><a:r><a:t>Sl</a:t></a:r><a:r><a:t>ide</a:t></a:r></a:p>';
    expect(replaceTextNodes(pptx, '.pptx', ['Presentation'])).toBe('<a:p><a:r><a:t>Pr</a:t></a:r><a:r><a:t>esentation</a:t></a:r></a:p>');
  });
  it('preserves paragraph boundary whitespace', () => {
    const xml = '<w:p><w:r><w:t xml:space="preserve"> A</w:t></w:r><w:r><w:t>B </w:t></w:r></w:p>';
    expect(replaceTextNodes(xml, '.docx', [' X '])).toBe('<w:p><w:r><w:t xml:space="preserve"> X</w:t></w:r><w:r><w:t> </w:t></w:r></w:p>');
  });
  it('supports pptx and xlsx logical text units', () => {
    expect(extractTextNodes('<a:p><a:r><a:t>Sl</a:t></a:r><a:r><a:t>ide</a:t></a:r></a:p>', '.pptx')).toEqual(['Slide']);
    expect(extractTextNodes('<sst><si><t>Cell</t></si><si><r><t>Rich</t></r><r><t>Text</t></r></si><sheetData><c r="A1" t="inlineStr"><is><t>Inline</t></is></c><c r="B1"><f>A1*2</f><v>42</v></c></sheetData></sst>', '.xlsx')).toEqual(['Cell', 'RichText', 'Inline']);
    const formulaXml = '<c r="B1"><f>A1*2</f><v>42</v></c>';
    expect(replaceTextNodes(formulaXml, '.xlsx', ['changed'])).toBe(formulaXml);
  });
});
describe('PDF text blocks', () => {
  it('groups text items on the same inferred line', () => {
    const blocks = inferPdfTextBlocks([
      { str: 'Hello', transform: [1, 0, 0, 12, 40, 700], width: 30, height: 12 },
      { str: 'world', transform: [1, 0, 0, 12, 76, 700], width: 32, height: 12 },
      { str: 'Second line', transform: [1, 0, 0, 10, 40, 680], width: 58, height: 10 }
    ]);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ text: 'Hello world', x: 40, y: 700, width: 68 });
    expect(blocks[1].text).toBe('Second line');
  });
});
