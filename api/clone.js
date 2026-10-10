// api/clone.js
import fetch from 'node-fetch';
import * as cheerio from 'cheerio';
import archiver from 'archiver';
import path from 'path';

// ---------- CONFIG ----------
const CONFIG = {
  maxDepth: 2,              // crawl depth
  maxPages: 25,             // hard cap
  maxFileSize: 10 * 1024 * 1024, // 10 MB
  timeoutMs: 8000,          // per-request timeout
  totalBudgetMs: 45000,     // stop before Vercel kills us (60s limit)
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
  try {
    return new URL(relative, base).href;
  } catch {
    return null;
  }
}

function isPrivateHost(hostname) {
  // Block localhost and private IPs (basic SSRF protection)
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

    // Sanitize each segment
    const clean = p
      .split('/')
      .filter(Boolean)
      .map((seg) => seg.replace(/[^A-Za-z0-9._-]/g, '_'))
      .join('/');

    return '/' + (clean || 'index.html');
  } catch {
    return '/index.html';
  }
}

function extOf(url) {
  try {
    const p = new URL(url).pathname;
    const m = p.match(/\.([a-z0-9]{1,6})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

// ---------- FETCH WITH TIMEOUT ----------
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
  } finally {
    clearTimeout(timer);
  }
}

// ---------- HTML REWRITE ----------
function rewriteHtml(html, pageUrl, baseDomain) {
  const $ = cheerio.load(html);

  const rewriteAttr = (selector, attr) => {
    $(selector).each((_, el) => {
      const raw = $(el).attr(attr);
      if (!raw) return;
      const abs = resolveUrl(raw, pageUrl);
      if (!abs) return;
      try {
        if (new URL(abs).hostname !== baseDomain) return;
      } catch { return; }
      $(el).attr(attr, '.' + toLocalPath(abs));
    });
  };

  rewriteAttr('a[href]', 'href');
  rewriteAttr('link[href]', 'href');
  rewriteAttr('script[src]', 'src');
  rewriteAttr('img[src]', 'src');
  rewriteAttr('img[data-src]', 'data-src');
  rewriteAttr('source[src]', 'src');
  rewriteAttr('source[srcset]', 'srcset');
  rewriteAttr('video[src]', 'src');
  rewriteAttr('audio[src]', 'src');

  // Inline style url()
  $('[style]').each((_, el) => {
    let style = $(el).attr('style') || '';
    style = style.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (m, u) => {
      const abs = resolveUrl(u, pageUrl);
      if (!abs) return m;
      try {
        if (new URL(abs).hostname !== baseDomain) return m;
      } catch { return m; }
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
    try {
      if (new URL(abs).hostname !== baseDomain) return m;
    } catch { return m; }

    const target = toLocalPath(abs);
    // Make path relative to CSS file's directory
    let rel = path.posix.relative(cssDir, target);
    if (!rel.startsWith('.')) rel = './' + rel;
    return `url("${rel}")`;
  });
}

// ---------- EXTRACT LINKS FROM HTML ----------
function extractLinksFromHtml(html, pageUrl, baseDomain) {
  const $ = cheerio.load(html);
  const links = new Set();

  const add = (raw) => {
    const abs = resolveUrl(raw, pageUrl);
    if (!abs) return;
    try {
      if (new URL(abs).hostname !== baseDomain) return;
    } catch { return; }
    if (CONFIG.excludeExt.includes(extOf(abs))) return;
    links.add(abs);
  };

  $('a[href]').each((_, el) => add($(el).attr('href')));
  $('link[href]').each((_, el) => add($(el).attr('href')));
  $('script[src]').each((_, el) => add($(el).attr('src')));
  $('img[src]').each((_, el) => add($(el).attr('src')));
  $('source[src]').each((_, el) => add($(el).attr('src')));

  // Inline CSS url()
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    const re = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let m;
    while ((m = re.exec(style))) add(m[1]);
  });

  return Array.from(links);
}

function extractLinksFromCss(css, cssUrl, baseDomain) {
  const links = new Set();
  const re = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
  let m;
  while ((m = re.exec(css))) {
    const abs = resolveUrl(m[1], cssUrl);
    if (!abs) continue;
    try {
      if (new URL(abs).hostname !== baseDomain) continue;
    } catch { continue; }
    links.add(abs);
  }
  return Array.from(links);
}

// ---------- CRAWLER ----------
async function crawl(startUrl, opts, sendLog) {
  const base = sanitizeUrl(startUrl);
  const baseDomain = new URL(base).hostname;

  if (isPrivateHost(baseDomain)) {
    throw new Error('Refusing to clone local/private addresses.');
  }

  const visited = new Set();
  const files = new Map(); // localPath -> Buffer
  let queue = [base];
  let depth = 0;
  const startTime = Date.now();

  while (queue.length && depth <= CONFIG.maxDepth) {
    const next = [];

    for (const url of queue) {
      // Time budget check
      if (Date.now() - startTime > CONFIG.totalBudgetMs) {
        sendLog('⏱️ Time budget reached, stopping crawl.');
        return { files, baseDomain, truncated: true };
      }
      if (visited.has(url)) continue;
      if (visited.size >= CONFIG.maxPages) {
        sendLog(`⛔ Max pages limit (${CONFIG.maxPages}) reached.`);
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
        sendLog(`   ⚠️ File too large, skipping.`);
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
        const rewritten = rewriteHtml(text, url, baseDomain);
        files.set(localPath, Buffer.from(rewritten, 'utf8'));

        if (opts.recursive || opts.followLinks) {
          for (const link of extractLinksFromHtml(text, url, baseDomain)) {
            if (!visited.has(link)) next.push(link);
          }
        }
      } else if (isCss && opts.downloadCss) {
        const text = res.body.toString('utf8');
        const rewritten = rewriteCss(text, url, localPath, baseDomain);
        files.set(localPath, Buffer.from(rewritten, 'utf8'));

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

// ---------- VERCEL HANDLER ----------
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { url, options = {} } = req.body || {};
  if (!url) {
    res.status(400).json({ error: 'URL is required' });
    return;
  }

  // Server-Sent Events so the browser sees progress live
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  const sendLog = (msg) => {
    res.write(`data: ${JSON.stringify({ type: 'log', message: msg })}\n\n`);
  };
  const sendDone = (payload) => {
    res.write(`data: ${JSON.stringify({ type: 'done', ...payload })}\n\n`);
    res.end();
  };
  const sendError = (message) => {
    res.write(`data: ${JSON.stringify({ type: 'error', message })}\n\n`);
    res.end();
  };

  try {
    sendLog(`🚀 Starting clone of ${url}`);

    const { files, baseDomain, truncated } = await crawl(url, options, sendLog);

    if (files.size === 0) {
      sendError('No files downloaded.');
      return;
    }

    sendLog(`📦 Zipping ${files.size} files…`);

    // Build ZIP in memory
    const chunks = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('data', (chunk) => chunks.push(chunk));

    const done = new Promise((resolve, reject) => {
      archive.on('end', resolve);
      archive.on('error', reject);
    });

    for (const [name, buffer] of files) {
      archive.append(buffer, { name: name.replace(/^\//, '') });
    }
    archive.finalize();
    await done;

    const zipBuffer = Buffer.concat(chunks);
    const zipBase64 = zipBuffer.toString('base64');

    sendLog(`✅ Done! ${files.size} files, ${(zipBuffer.length / 1024).toFixed(1)} KB`);

    sendDone({
      filename: `${baseDomain}_clone.zip`,
      size: zipBuffer.length,
      files: files.size,
      truncated,
      zipBase64,
    });
  } catch (err) {
    sendError(err.message || 'Unknown error');
  }
}
