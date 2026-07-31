import fontkit from '@pdf-lib/fontkit';
import JSZip from 'jszip';
import { PDFDocument, PDFFont, rgb } from 'pdf-lib';
import { access, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import type { ProgressEvent, RuntimeSettings } from '../shared/types';
import { createRateLimitGate, isMeaningfulUnchanged, isNontrivialTranslationUnit, translate } from '../shared/translation';

const XML_TARGETS: Record<string, RegExp> = {
  '.docx': /^word\/(document|header\d*|footer\d*|footnotes|endnotes|comments)\.xml$/,
  '.pptx': /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/,
  '.xlsx': /^xl\/(sharedStrings|worksheets\/sheet\d+)\.xml$/
};
const TAGS: Record<string, RegExp> = { '.docx': /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, '.pptx': /<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g, '.xlsx': /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g };
const LOGICAL_UNIT_TAGS: Record<string, RegExp> = {
  '.docx': /<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g,
  '.pptx': /<a:p(?:\s[^>]*)?>[\s\S]*?<\/a:p>/g,
  '.xlsx': /<si(?:\s[^>]*)?>[\s\S]*?<\/si>|<c(?:\s[^>]*)?\bt=["']inlineStr["'][^>]*>[\s\S]*?<\/c>/g
};
const LOGICAL_TEXT_TAGS: Record<string, RegExp> = { '.docx': TAGS['.docx'], '.pptx': TAGS['.pptx'], '.xlsx': /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g };

type PdfTextItem = { str: string; transform: number[]; width: number; height: number };
export type PdfTextBlock = { text: string; x: number; y: number; width: number; height: number };
type TranslationCounts = { meaningful: number; unchanged: number };
const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;
const MAX_TARGET_XML_CHARACTERS = 25_000_000;

const unchangedDocumentError = () => new Error('翻译结果与原文基本相同，未生成输出文件。可能原因：服务商未执行翻译、模型不支持当前语言，或源语言/目标语言设置不正确。请先用“直接翻译”输入一段明显不同语言的文本测试接口。');
function trackTranslation(counts: TranslationCounts, source: string, translated: string, settings: RuntimeSettings) {
  if (!isNontrivialTranslationUnit(source)) return;
  counts.meaningful++;
  if (isMeaningfulUnchanged(source, translated, settings.sourceLang, settings.targetLang)) counts.unchanged++;
}
function warningFor(counts: TranslationCounts): string | undefined {
  return counts.unchanged > 0 && counts.unchanged < counts.meaningful
    ? `警告：${counts.meaningful} 个有效文本单元中有 ${counts.unchanged} 个译文与原文基本相同，请抽查结果并检查模型与语言设置。`
    : undefined;
}
async function writeOutputAtomically(output: string, data: Uint8Array) {
  const filename = output.split(/[\\/]/).pop() ?? 'translation';
  const token = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const temporary = join(dirname(output), `.${token}-${filename}.tmp`);
  const backup = join(dirname(output), `.${token}-${filename}.bak`);
  let hasBackup = false;
  try {
    await writeFile(temporary, data);
    try { await rename(output, backup); hasBackup = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(temporary, output);
    if (hasBackup) await rm(backup, { force: true });
  } catch (error) {
    await rm(temporary, { force: true });
    if (hasBackup) {
      await rm(output, { force: true });
      await rename(backup, output);
    }
    throw error;
  }
}

function samePath(first: string, second: string): boolean {
  const normalize = (value: string) => process.platform === 'win32' ? resolve(value).toLocaleLowerCase() : resolve(value);
  return normalize(first) === normalize(second);
}

export function decodeXml(value: string): string { return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'); }
export function encodeXml(value: string): string { return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }

function isTranslatableUnit(unit: string, extension: string): boolean {
  return extension !== '.xlsx' || !/<f(?:\s[^>]*)?(?:\/>|>[\s\S]*?<\/f>)/.test(unit);
}

function unitText(unit: string, extension: string): string {
  return [...unit.matchAll(LOGICAL_TEXT_TAGS[extension])].map(match => decodeXml(match[1])).join('');
}

function replaceUnitText(unit: string, extension: string, translation: string): string {
  const matches = [...unit.matchAll(LOGICAL_TEXT_TAGS[extension])];
  const nodeCharacters = matches.map(match => [...decodeXml(match[1])]);
  const source = nodeCharacters.flat().join('');
  let leadingRemaining = [...(source.match(/^\s*/)?.[0] ?? '')].length;
  let trailingRemaining = [...(source.match(/\s*$/)?.[0] ?? '')].length;
  const boundaries = nodeCharacters.map(characters => {
    const leadingLength = Math.min(leadingRemaining, characters.length);
    leadingRemaining -= leadingLength;
    return { characters, leadingLength, trailingLength: 0 };
  });
  for (let index = boundaries.length - 1; index >= 0; index--) {
    const available = boundaries[index].characters.length - boundaries[index].leadingLength;
    const trailingLength = Math.min(trailingRemaining, available);
    boundaries[index].trailingLength = trailingLength;
    trailingRemaining -= trailingLength;
  }

  const translatedCharacters = [...translation.trim()];
  let lastContentNode = -1;
  for (let index = boundaries.length - 1; index >= 0; index--) {
    if (boundaries[index].characters.length > boundaries[index].leadingLength + boundaries[index].trailingLength) {
      lastContentNode = index;
      break;
    }
  }
  let offset = 0;
  let nodeIndex = 0;
  return unit.replace(LOGICAL_TEXT_TAGS[extension], (whole, text: string) => {
    const boundary = boundaries[nodeIndex];
    const contentLength = boundary.characters.length - boundary.leadingLength - boundary.trailingLength;
    const end = nodeIndex === lastContentNode
      ? translatedCharacters.length
      : Math.min(translatedCharacters.length, offset + contentLength);
    const replacement = [
      ...boundary.characters.slice(0, boundary.leadingLength),
      ...translatedCharacters.slice(offset, end),
      ...boundary.characters.slice(boundary.characters.length - boundary.trailingLength)
    ].join('');
    offset = end;
    nodeIndex++;
    return whole.replace(text, encodeXml(replacement));
  });
}

export function extractTextNodes(xml: string, extension: string): string[] {
  const units = LOGICAL_UNIT_TAGS[extension];
  if (!units) return [];
  return [...xml.matchAll(units)]
    .map(match => match[0])
    .filter(unit => isTranslatableUnit(unit, extension))
    .map(unit => unitText(unit, extension))
    .filter(text => text.trim());
}

export function replaceTextNodes(xml: string, extension: string, translations: string[]): string {
  const units = LOGICAL_UNIT_TAGS[extension];
  if (!units) return xml;
  let index = 0;
  return xml.replace(units, unit => {
    const text = unitText(unit, extension);
    if (!isTranslatableUnit(unit, extension) || !text.trim()) return unit;
    const translation = translations[index++] ?? text;
    return replaceUnitText(unit, extension, translation);
  });
}

export function inferPdfTextBlocks(items: PdfTextItem[]): PdfTextBlock[] {
  const meaningful = items.filter(item => item.str.trim() && item.transform.length >= 6);
  const lines: PdfTextBlock[] = [];
  for (const item of meaningful) {
    const x = item.transform[4];
    const y = item.transform[5];
    const height = Math.max(item.height || Math.abs(item.transform[3]), 6);
    const existing = lines.find(line => Math.abs(line.y - y) <= Math.max(2, Math.min(line.height, height) * 0.35));
    if (existing) {
      const right = Math.max(existing.x + existing.width, x + item.width);
      existing.text += `${existing.text && x > existing.x + existing.width + height * 0.35 ? ' ' : ''}${item.str}`;
      existing.x = Math.min(existing.x, x);
      existing.width = right - existing.x;
      existing.height = Math.max(existing.height, height);
    } else lines.push({ text: item.str, x, y, width: Math.max(item.width, height), height });
  }
  return lines.sort((a, b) => b.y - a.y || a.x - b.x);
}

async function translateUnits(texts: string[], settings: RuntimeSettings, signal: AbortSignal, progress: (completed: number, message?: string) => void): Promise<string[]> {
  const results = new Array<string>(texts.length);
  const gate = createRateLimitGate();
  const concurrency = Math.max(1, Math.min(6, Math.floor(settings.concurrency || 2), texts.length));
  let next = 0;
  let completed = 0;
  let failure: unknown;
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  const worker = async () => {
    while (!failure) {
      controller.signal.throwIfAborted();
      const index = next++;
      if (index >= texts.length) return;
      try {
        results[index] = await translate({
          text: texts[index], settings, signal: controller.signal, rateLimitGate: gate,
          onStatus: message => progress(completed, message)
        });
        completed++;
        progress(completed);
      } catch (error) {
        failure = error;
        controller.abort(error);
        throw error;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: concurrency }, worker));
    return results;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

async function translateOoxml(input: string, output: string, settings: RuntimeSettings, signal: AbortSignal, progress: (p: ProgressEvent) => void) {
  const extension = extname(input).toLowerCase();
  const zip = await JSZip.loadAsync(await readFile(input));
  const files = Object.keys(zip.files).filter(name => XML_TARGETS[extension].test(name));
  const documents: Array<{ name: string; xml: string; texts: string[] }> = [];
  let xmlCharacters = 0;
  for (const name of files) {
    const xml = await zip.file(name)!.async('string');
    xmlCharacters += xml.length;
    if (xmlCharacters > MAX_TARGET_XML_CHARACTERS) throw new Error('文档中的可翻译 XML 内容过大，已停止处理。');
    const texts = extractTextNodes(xml, extension);
    if (texts.length) documents.push({ name, xml, texts });
  }
  const total = documents.reduce((sum, doc) => sum + doc.texts.length, 0);
  if (!total) throw new Error('文档中没有可翻译的文本。');
  const counts: TranslationCounts = { meaningful: 0, unchanged: 0 };
  const texts = documents.flatMap(document => document.texts);
  const translated = await translateUnits(texts, settings, signal, (completed, message) => {
    progress({ current: completed, total, message: message ?? `正在翻译 ${completed}/${total}` });
  });
  let offset = 0;
  for (const document of documents) {
    const documentTranslations = translated.slice(offset, offset + document.texts.length);
    document.texts.forEach((text, index) => trackTranslation(counts, text, documentTranslations[index], settings));
    zip.file(document.name, replaceTextNodes(document.xml, extension, documentTranslations));
    offset += document.texts.length;
  }
  if (counts.meaningful > 0 && counts.unchanged === counts.meaningful) {
    throw unchangedDocumentError();
  }
  await writeOutputAtomically(output, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
  const warning = warningFor(counts);
  if (warning) progress({ current: total, total, message: '翻译完成，请留意警告', warning });
}

async function embedCjkFont(pdf: PDFDocument): Promise<PDFFont> {
  const windir = process.env.WINDIR || 'C:\\Windows';
  const candidates = [
    join(windir, 'Fonts', 'simhei.ttf'),
    join(windir, 'Fonts', 'msyh.ttf'),
    join(windir, 'Fonts', 'msyh.ttc'),
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.otf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/System/Library/Fonts/PingFang.ttc'
  ];
  for (const path of candidates) {
    try { await access(path); return await pdf.embedFont(await readFile(path), { subset: true }); } catch { /* missing or unsupported font; try next */ }
  }
  throw new Error('未找到可嵌入的 CJK 系统字体。请安装“黑体”或 Noto Sans CJK 后重试。');
}

function splitToFit(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const character of text.replace(/\s+/g, ' ').trim()) {
    if (line && font.widthOfTextAtSize(line + character, size) > width) { lines.push(line); line = character.trimStart(); } else line += character;
  }
  if (line) lines.push(line);
  return lines;
}

function drawTranslation(page: ReturnType<PDFDocument['getPage']>, block: PdfTextBlock, text: string, font: PDFFont) {
  const pageWidth = page.getWidth();
  const maxWidth = Math.max(12, Math.min(pageWidth - block.x - 2, Math.max(block.width, block.height * 4)));
  let size = Math.min(block.height * 0.82, 12);
  let lines = splitToFit(text, font, size, maxWidth);
  while (size > 4.5 && lines.length * size * 1.15 > block.height * 1.5) { size -= 0.5; lines = splitToFit(text, font, size, maxWidth); }
  const coverHeight = Math.max(block.height * 1.35, lines.length * size * 1.15 + 2);
  const bottom = Math.max(0, block.y - block.height * 0.25 - Math.max(0, coverHeight - block.height));
  page.drawRectangle({ x: Math.max(0, block.x - 1), y: bottom, width: maxWidth + 2, height: coverHeight, color: rgb(1, 1, 1), opacity: 0.94 });
  lines.forEach((line, index) => page.drawText(line, { x: block.x, y: bottom + coverHeight - size * (index + 1), size, font, color: rgb(0.08, 0.1, 0.09), maxWidth }));
}

async function translatePdf(input: string, output: string, settings: RuntimeSettings, signal: AbortSignal, progress: (p: ProgressEvent) => void) {
  if (extname(output).toLowerCase() !== '.pdf') throw new Error('PDF 翻译结果必须保存为 .pdf 文件。');
  const source = await readFile(input);
  const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const sourcePdf = await getDocument({ data: new Uint8Array(source), useWorkerFetch: false, isEvalSupported: false, useSystemFonts: true }).promise;
  const pageBlocks: PdfTextBlock[][] = [];
  let characterCount = 0;
  for (let pageNo = 1; pageNo <= sourcePdf.numPages; pageNo++) {
    const page = await sourcePdf.getPage(pageNo);
    const content = await page.getTextContent();
    const items: PdfTextItem[] = content.items.flatMap(item => {
      if (!('str' in item)) return [];
      return [{ str: item.str, transform: item.transform, width: item.width, height: item.height }];
    });
    const blocks = inferPdfTextBlocks(items);
    pageBlocks.push(blocks);
    characterCount += blocks.reduce((sum, block) => sum + block.text.replace(/\s/g, '').length, 0);
  }
  if (characterCount < Math.max(20, sourcePdf.numPages * 10)) throw new Error('未检测到足够的数字文本。扫描版 PDF 暂不支持，请先使用 OCR。');

  const outputPdf = await PDFDocument.load(source);
  outputPdf.registerFontkit(fontkit);
  const font = await embedCjkFont(outputPdf);
  const total = pageBlocks.reduce((sum, blocks) => sum + blocks.length, 0);
  const counts: TranslationCounts = { meaningful: 0, unchanged: 0 };
  const flatBlocks = pageBlocks.flatMap((blocks, pageIndex) => blocks.map(block => ({ block, pageIndex })));
  const translations = await translateUnits(flatBlocks.map(item => item.block.text), settings, signal, (completed, message) => {
    progress({ current: completed, total, message: message ?? `正在翻译 PDF（${completed}/${total}）` });
  });
  flatBlocks.forEach((item, index) => {
    trackTranslation(counts, item.block.text, translations[index], settings);
    drawTranslation(outputPdf.getPage(item.pageIndex), item.block, translations[index], font);
  });
  if (counts.meaningful > 0 && counts.unchanged === counts.meaningful) {
    throw unchangedDocumentError();
  }
  await writeOutputAtomically(output, await outputPdf.save());
  const warning = warningFor(counts);
  if (warning) progress({ current: total, total, message: '翻译完成，请留意警告', warning });
}

export async function translateDocument(input: string, output: string, settings: RuntimeSettings, signal: AbortSignal, progress: (p: ProgressEvent) => void) {
  const extension = extname(input).toLowerCase();
  if (samePath(input, output)) throw new Error('输出文件不能覆盖原始文档，请选择其他位置或文件名。');
  const inputInfo = await stat(input);
  if (!inputInfo.isFile()) throw new Error('输入路径不是有效文件。');
  if (inputInfo.size > MAX_DOCUMENT_BYTES) throw new Error('文档不能超过 100 MB。');
  if (extension in XML_TARGETS && extname(output).toLowerCase() !== extension) throw new Error(`输出文件必须使用 ${extension} 扩展名。`);
  if (extension in XML_TARGETS) return translateOoxml(input, output, settings, signal, progress);
  if (extension === '.pdf') return translatePdf(input, output, settings, signal, progress);
  throw new Error('仅支持 DOCX、PPTX、XLSX 和 PDF。');
}
