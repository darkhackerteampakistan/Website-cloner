// api/clone.js
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import path from 'path';
import zlib from 'zlib';

// ---------- CONFIG ----------
const CONFIG = {
  maxDepth: 2,
  maxPages: 25,
  maxFileSize: 10 * 1024 * 1024,
  timeoutMs: 8000,
  totalBudgetMs: 45000,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
  excludeExt: ['mp4', 'avi', 'mkv', 'mp3', 'zip', 'rar', '7z', 'exe', 'dmg', 'iso'],
};

// ---------- HELPERS ----------
function sanitizeUrl(url) {
  url = (url || '').trim();
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  return url.replace(/\/+$/, '');
}

function resolveUrl(relative, base) {
  if (!relative) return null;
  if (/^(javascript:|mailto:|tel:|data:|#)/i.test(relative)) return null;
  relative = relative.replace(/#.*$/, '');
  try { return new URL(relative, base).href; } catch { return null; }
}

function isPrivateHost(hostname) {
  if (/^(localhost|127\.|0\.0\.0\.0)/i.test(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
  if (/^169\.254\./.test(hostname)) return true;
  return false;
}

function toLocalPath(url) {
  try {
    const u = new URL(url);
    let p = u.pathname || '/';
    if (p === '' || p.endsWith('/')) p += 'index.html';
    const base = path.posix.basename(p);
    if (!base.includes('.')) p = p.replace(/\/?$/, '/index.html');
    const clean = p.split('/').filter(Boolean)
      .map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, '_')).join('/');
    return '/' + (clean || 'index.html');
  } catch { return '/index.html'; }
}

function extOf(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.([a-z0-9]{1,6})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

// ---------- FETCH ----------
async function fetchWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': CONFIG.userAgent },
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    return { ok: res.ok, status: res.status, contentType: ct, body: buf };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally { clearTimeout(timer); }
}

// ---------- REWRITERS ----------
function rewriteHtml(html, pageUrl, baseDomain) {
  const $ = cheerio.load(html);

  const rewriteAttr = (selector, attr) => {
    $(selector).each((_, el) => {
      const raw = $(el).attr(attr);
      if (!raw) return;
      const abs = resolveUrl(raw, pageUrl);
      if (!abs) return;
      try { if (new URL(abs).hostname !== baseDomain) return; } catch { return; }
      $(el).attr(attr, '.' + toLocalPath(abs));
    });
  };

  rewriteAttr('a[href]', 'href');
  rewriteAttr('link[href]', 'href');
  rewriteAttr('script[src]', 'src');
  rewriteAttr('img[src]', 'src');
  rewriteAttr('img[data-src]', 'data-src');
  rewriteAttr('source[src]', 'src');
  rewriteAttr('video[src]', 'src');
  rewriteAttr('audio[src]', 'src');

  $('[style]').each((_, el) => {
    let style = $(el).attr('style') || '';
    style = style.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, u) => {
      const abs = resolveUrl(u, pageUrl);
      if (!abs) return m;
      try { if (new URL(abs).hostname !== baseDomain) return m; } catch { return m; }
      return `url(".${toLocalPath(abs)}")`;
    });
    $(el).attr('style', style);
  });

  return $.html();
}

function rewriteCss(css, cssUrl, cssLocalPath, baseDomain) {
  const cssDir = path.posix.dirname(cssLocalPath);
  return css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, u) => {
    const abs = resolveUrl(u, cssUrl);
    if (!abs) return m;
    try { if (new URL(abs).hostname !== baseDomain) return m; } catch { return m; }
    const target = toLocalPath(abs);
    let rel = path.posix.relative(cssDir, target);
    if (!rel.startsWith('.')) rel = './' + rel;
    return `url("${rel}")`;
  });
}

// ---------- LINK EXTRACTION ----------
function extractLinksFromHtml(html, pageUrl, baseDomain) {
  const $ = cheerio.load(html);
  const links = new Set();
  const add = (raw) => {
    const abs = resolveUrl(raw, pageUrl);
    if (!abs) return;
    try { if (new URL(abs).hostname !== baseDomain) return; } catch { return; }
    if (CONFIG.excludeExt.includes(extOf(abs))) return;
    links.add(abs);
  };
  $('a[href]').each((_, el) => add($(el).attr('href')));
  $('link[href]').each((_, el) => add($(el).attr('href')));
  $('script[src]').each((_, el) => add($(el).attr('src')));
  $('img[src]').each((_, el) => add($(el).attr('src')));
  return Array.from(links);
}

function extractLinksFromCss(css, cssUrl, baseDomain) {
  const links = new Set();
  const re = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let m;
  while ((m = re.exec(css))) {
    const abs = resolveUrl(m[1], cssUrl);
    if (!abs) continue;
    try { if (new URL(abs).hostname !== baseDomain) continue; } catch { continue; }
    links.add(abs);
  }
  return Array.from(links);
}

// ---------- CRAWLER ----------
async function crawl(startUrl, opts, sendLog) {
  const base = sanitizeUrl(startUrl);
  const baseDomain = new URL(base).hostname;

  if (isPrivateHost(baseDomain)) throw new Error('Refusing to clone local/private addresses.');

  const visited = new Set();
  const files = new Map();
  let queue = [base];
  let depth = 0;
  const startTime = Date.now();

  while (queue.length && depth <= CONFIG.maxDepth) {
    const next = [];
    for (const url of queue) {
      if (Date.now() - startTime > CONFIG.totalBudgetMs) {
        sendLog('⏱️ Time budget reached, stopping.');
        return { files, baseDomain, truncated: true };
      }
      if (visited.has(url)) continue;
      if (visited.size >= CONFIG.maxPages) {
        sendLog(`⛔ Max pages (${CONFIG.maxPages}) reached.`);
        return { files, baseDomain, truncated: true };
      }
      visited.add(url);
      sendLog(`📥 ${url}`);

      const res = await fetchWithTimeout(url, CONFIG.timeoutMs);
      if (!res.ok || !res.body) {
        sendLog(`   ⚠️ Failed: ${res.error || 'HTTP ' + res.status}`);
        continue;
      }
      if (res.body.length > CONFIG.maxFileSize) {
        sendLog(`   ⚠️ Too large, skipping.`);
        continue;
      }

      const ct = res.contentType;
      const localPath = toLocalPath(url);
      const isHtml = ct.includes('text/html') || ct.includes('application/xhtml');
      const isCss  = ct.includes('text/css');
      const isJs   = ct.includes('javascript') || ct.includes('ecmascript');
      const isImg  = ct.startsWith('image/');

      if (isHtml) {
        const text = res.body.toString('utf8');
        files.set(localPath, Buffer.from(rewriteHtml(text, url, baseDomain), 'utf8'));
        if (opts.recursive || opts.followLinks) {
          for (const link of extractLinksFromHtml(text, url, baseDomain)) {
            if (!visited.has(link)) next.push(link);
          }
        }
      } else if (isCss && opts.downloadCss) {
        const text = res.body.toString('utf8');
        files.set(localPath, Buffer.from(rewriteCss(text, url, localPath, baseDomain), 'utf8'));
        for (const link of extractLinksFromCss(text, url, baseDomain)) {
          if (!visited.has(link)) next.push(link);
        }
      } else if (isJs && opts.downloadJs) {
        files.set(localPath, res.body);
      } else if (isImg && opts.downloadImages) {
        files.set(localPath, res.body);
      } else {
        files.set(localPath, res.body);
      }
    }
    queue = Array.from(new Set(next));
    depth++;
  }
  return { files, baseDomain, truncated: false };
}

// ---------- PURE-JS ZIP WRITER (no archiver!) ----------
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const now = new Date();
  const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() / 2)) & 0xffff;
  const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

  for (const [name, content] of files) {
    const cleanName = name.replace(/^\//, '');
    const nameBuf = Buffer.from(cleanName, 'utf8');
    const crc = crc32(content);

    // Compress with deflate
    let data = content;
    let method = 0;
    try {
      const deflated = zlib.deflateRawSync(content);
      if (deflated.length < content.length) {
        data = deflated;
        method = 8;
      }
    } catch {}

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.size, 8);
  endRecord.writeUInt16LE(files.size, 10);
  endRecord.writeUInt32LE(centralDir.length, 12);
  endRecord.writeUInt32LE(offset, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, endRecord]);
}

// ---------- HANDLER ----------
export default async function handler(req, res) {
  // CORS + method check
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { url, options = {} } = body || {};

  if (!url) { res.status(400).json({ error: 'URL is required' }); return; }

  // SSE headers — CRITICAL for streaming
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  const send = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch {}
  };
  const sendLog = (message) => send({ type: 'log', message });

  try {
    sendLog(`🚀 Starting clone of ${url}`);

    const { files, baseDomain, truncated } = await crawl(url, options, sendLog);

    if (files.size === 0) {
      send({ type: 'error', message: 'No files downloaded.' });
      res.end();
      return;
    }

    sendLog(`📦 Building ZIP for ${files.size} files…`);
    const zipBuffer = createZip(files);

    sendLog(`✅ Done! ${files.size} files, ${(zipBuffer.length / 1024).toFixed(1)} KB`);

    send({
      type: 'done',
      filename: `${baseDomain}_clone.zip`,
      size: zipBuffer.length,
      files: files.size,
      truncated,
      zipBase64: zipBuffer.toString('base64'),
    });
    res.end();
  } catch (err) {
    console.error('Clone error:', err);
    send({ type: 'error', message: err.message || 'Unknown error' });
    res.end();
  }
}
