import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProgressEvent, RuntimeSettings } from '../src/shared/types';
import { translateDocument } from '../src/main/documents';

const settings = (baseUrl: string, concurrency = 2): RuntimeSettings => ({ baseUrl, apiKey: 'test', model: 'fake', sourceLang: '英语', targetLang: '简体中文', concurrency });
const xmlByExtension: Record<string, { name: string; xml: string }> = {
  '.docx': { name: 'word/document.xml', xml: '<w:document xmlns:w="x"><w:body><w:p><w:r><w:t>This is a complete document sentence.</w:t></w:r></w:p><w:p><w:r><w:t>Another meaningful paragraph appears here.</w:t></w:r></w:p></w:body></w:document>' },
  '.pptx': { name: 'ppt/slides/slide1.xml', xml: '<p:sld xmlns:p="p" xmlns:a="a"><p:cSld><a:p><a:r><a:t>This is a complete presentation sentence.</a:t></a:r></a:p><a:p><a:r><a:t>Another meaningful slide paragraph.</a:t></a:r></a:p></p:cSld></p:sld>' },
  '.xlsx': { name: 'xl/sharedStrings.xml', xml: '<sst xmlns="x"><si><t>This is a complete spreadsheet sentence.</t></si><si><t>Another meaningful cell value appears.</t></si></sst>' }
};

let server: Server | undefined;
let root: string | undefined;
afterEach(async () => {
  await new Promise<void>(resolve => server?.close(() => resolve()) ?? resolve());
  server = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function fakeApi(responseFor: (text: string, index: number) => unknown) {
  let index = 0;
  server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(responseFor(payload.messages.at(-1)?.content ?? '', index++)));
    });
  });
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake API did not bind');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function fixture(extension: string) {
  root = await mkdtemp(join(tmpdir(), 'translator-meow-'));
  const input = join(root, `input${extension}`);
  const output = join(root, `output${extension}`);
  const zip = new JSZip();
  const fixtureXml = xmlByExtension[extension];
  zip.file(fixtureXml.name, fixtureXml.xml);
  zip.file('untouched.txt', 'preserved');
  await writeFile(input, await zip.generateAsync({ type: 'nodebuffer' }));
  return { input, output, fixtureXml };
}

for (const extension of ['.docx', '.pptx', '.xlsx']) {
  describe(`${extension} document integration`, () => {
    it('bounds in-flight requests, preserves source order, and reports accurate progress', async () => {
      let active = 0;
      let maxActive = 0;
      let requestIndex = 0;
      server = createServer((request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => {
          const index = requestIndex++;
          active++;
          maxActive = Math.max(maxActive, active);
          setTimeout(() => {
            active--;
            const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
            const source = payload.messages.at(-1)?.content ?? '';
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ output_text: index === 0 ? `第一段-${source.length}` : `第二段-${source.length}` }));
          }, index === 0 ? 50 : 10);
        });
      });
      await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('fake API did not bind');
      const { input, output, fixtureXml } = await fixture(extension);
      const events: ProgressEvent[] = [];
      await translateDocument(input, output, settings(`http://127.0.0.1:${address.port}/v1`, 2), new AbortController().signal, event => events.push(event));
      const translated = await JSZip.loadAsync(await readFile(output));
      const xml = await translated.file(fixtureXml.name)!.async('string');
      expect(maxActive).toBe(2);
      expect(xml.indexOf('第一段-')).toBeLessThan(xml.indexOf('第二段-'));
      expect(events.filter(event => event.message.startsWith('正在翻译')).map(event => event.current)).toEqual([1, 2]);
    });

    it('improves delayed API latency with configured concurrency', async () => {
      const baseUrl = await fakeApi(text => ({ output_text: `已翻译-${text.length}` }));
      server!.removeAllListeners('request');
      server!.on('request', (request, response) => {
        let body = '';
        request.setEncoding('utf8');
        request.on('data', chunk => { body += chunk; });
        request.on('end', () => setTimeout(() => {
          const payload = JSON.parse(body) as { messages: Array<{ content: string }> };
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ output_text: `已翻译-${payload.messages.at(-1)?.content.length}` }));
        }, 70));
      });
      const first = await fixture(extension);
      const sequentialStart = Date.now();
      await translateDocument(first.input, first.output, settings(baseUrl, 1), new AbortController().signal, () => undefined);
      const sequential = Date.now() - sequentialStart;
      await rm(root!, { recursive: true, force: true });
      root = undefined;
      const second = await fixture(extension);
      const concurrentStart = Date.now();
      await translateDocument(second.input, second.output, settings(baseUrl, 2), new AbortController().signal, () => undefined);
      const concurrent = Date.now() - concurrentStart;
      expect(concurrent).toBeLessThan(sequential * 0.8);
    });

    it('writes visibly translated content from alternate response shapes', async () => {
      const baseUrl = await fakeApi((_text, index) => index === 0
        ? { output: [{ content: [{ type: 'output_text', text: '这是清晰可见的译文。' }] }] }
        : { choices: [{ message: { content: [{ type: 'text', text: '这是第二段译文。' }] } }] });
      const { input, output, fixtureXml } = await fixture(extension);
      const events: ProgressEvent[] = [];
      await translateDocument(input, output, settings(baseUrl), new AbortController().signal, event => events.push(event));
      const translated = await JSZip.loadAsync(await readFile(output));
      const xml = await translated.file(fixtureXml.name)!.async('string');
      expect(xml).toContain('这是清晰可见的译文。');
      expect(xml).toContain('这是第二段译文。');
      expect(xml).not.toContain('This is a complete');
      expect(await translated.file('untouched.txt')!.async('string')).toBe('preserved');
      expect(events.at(-1)).toMatchObject({ current: 2, total: 2 });
    });

    it('rejects all-echo output and preserves an existing final output', async () => {
      const baseUrl = await fakeApi(text => ({ choices: [{ message: { content: text } }] }));
      const { input, output } = await fixture(extension);
      await writeFile(output, 'stale misleading output');
      await expect(translateDocument(input, output, settings(baseUrl), new AbortController().signal, () => undefined)).rejects.toThrow(/服务商.*模型.*语言/);
      await expect(readFile(output, 'utf8')).resolves.toBe('stale misleading output');
    });

    it('surfaces a warning when only some meaningful units echo', async () => {
      const baseUrl = await fakeApi((text, index) => index === 0 ? { output_text: text } : { choices: [{ text: '第二段已经翻译。' }] });
      const { input, output } = await fixture(extension);
      const events: ProgressEvent[] = [];
      await translateDocument(input, output, settings(baseUrl), new AbortController().signal, event => events.push(event));
      expect(events.at(-1)?.warning).toMatch(/1 个译文与原文基本相同/);
    });
  });
}

describe('document output safeguards', () => {
  it('does not allow the output path to overwrite the source document', async () => {
    const { input } = await fixture('.docx');
    await expect(translateDocument(input, input, settings('https://example.test/v1'), new AbortController().signal, () => undefined)).rejects.toThrow(/不能覆盖原始文档/);
    await expect(readFile(input)).resolves.toBeInstanceOf(Buffer);
  });

  it('requires the output extension to match an Office input', async () => {
    const { input } = await fixture('.docx');
    await expect(translateDocument(input, join(root!, 'output.pdf'), settings('https://example.test/v1'), new AbortController().signal, () => undefined)).rejects.toThrow(/\.docx 扩展名/);
  });
});
