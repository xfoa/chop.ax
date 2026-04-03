import type { Context } from "hono";
import { isAllowed, getAllowedDomains } from "./whitelist";
import { getCached, setCache } from "./cache";
import { renderPage, collectImgurImages } from "./browser";
import { cleanHtml } from "./clean";

const MAX_CONCURRENT = 5;
let activeRenders = 0;
const inflight = new Map<string, Promise<string>>();

export async function handleProxy(c: Context): Promise<Response> {
  const reqUrl = new URL(c.req.url);
  const rawUrl = reqUrl.pathname.slice(1) + reqUrl.search;
  if (!rawUrl || rawUrl === "?") return c.text("No URL provided", 400);

  let url: string;
  try {
    url = normalizeUrl(rawUrl);
  } catch {
    return c.text("Invalid URL", 400);
  }

  if (!isAllowed(url)) {
    const domains = getAllowedDomains().map(d => `<li>${d}</li>`).join("\n");
    const escaped = url.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Domain not allowed - chop.ax</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;max-width:680px;margin:0 auto;padding:40px 20px;color:#222}a{color:#06c}</style>
</head><body>
<h1>Domain not allowed</h1>
<p>You can still visit the original page: <a href="${escaped}">${escaped}</a></p>
<p>Whitelisted domains:</p>
<ul>${domains}</ul>
</body></html>`, 403);
  }

  // Direct media URLs -- serve a lightweight wrapper page.
  // Embedding as <img> makes the browser send Sec-Fetch-Dest: image
  // and a Referer header, so Reddit/Imgur serve the file normally.
  if (isDirectMedia(url)) {
    const escaped = url.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
    return c.html(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>chop.ax</title>
<style>body{margin:0;display:flex;justify-content:center;background:#111}img{max-width:100%;max-height:100vh;object-fit:contain}</style>
</head><body><img src="${escaped}" alt=""></body></html>`);
  }

  // Cache hit
  const cached = await getCached(url);
  if (cached) return c.html(cached);

  // Dedup in-flight requests for the same URL
  if (inflight.has(url)) {
    try {
      const html = await inflight.get(url)!;
      return c.html(html);
    } catch {
      return c.text("Failed to process page", 502);
    }
  }

  if (activeRenders >= MAX_CONCURRENT) {
    return c.text("Server busy, try again shortly", 503);
  }

  const promise = processPage(url);
  inflight.set(url, promise);

  try {
    const html = await promise;
    return c.html(html);
  } catch (err) {
    console.error(`Failed to process ${url}:`, err);
    return c.text("Failed to fetch and process the page", 502);
  } finally {
    inflight.delete(url);
  }
}

async function processPage(url: string): Promise<string> {
  activeRenders++;
  try {
    // Imgur pages: scroll and collect image IDs incrementally
    const parsed = new URL(url);
    if (parsed.hostname === "imgur.com" || parsed.hostname === "www.imgur.com") {
      const ids = await collectImgurImages(url);
      if (ids.length > 0) {
        const gallery = buildImgurGallery(ids, url);
        await setCache(url, gallery);
        return gallery;
      }
      // Single-image post: Gallery-Content doesn't exist, extract og:image
      const { html: imgurHtml } = await renderPage(url);
      const ogMatch = imgurHtml.match(/<meta\s+property="og:image"\s+content="([^"]+)"/);
      if (ogMatch) {
        const imgUrl = ogMatch[1];
        const idMatch = imgUrl.match(/i\.imgur\.com\/([A-Za-z0-9]+)/);
        if (idMatch) {
          const gallery = buildImgurGallery([idMatch[1]], url);
          await setCache(url, gallery);
          return gallery;
        }
      }
    }

    const { html, css } = await renderPage(url);
    const cleaned = await cleanHtml(html, css, url);
    await setCache(url, cleaned);
    return cleaned;
  } finally {
    activeRenders--;
  }
}

function buildImgurGallery(ids: string[], sourceUrl: string): string {
  const images = ids
    .map(
      (id) =>
        `<img src="https://i.imgur.com/${id}.jpg" alt="" loading="lazy">`
    )
    .join("\n  ");

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Imgur Album - chop.ax</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;
max-width:680px;margin:0 auto;padding:20px;background:#fff;color:#222}
h1{font-size:1.4em;margin-bottom:1em}
img{max-width:100%;height:auto;display:block;margin:12px 0;border-radius:4px}
.chop-footer{text-align:center;padding:20px;margin-top:40px;
border-top:1px solid #ccc;font-size:14px;color:#666}
</style>
</head><body>
<h1>Imgur Album</h1>
  ${images}
<div class="chop-footer">
  <a href="${sourceUrl}">Original page</a> --
  Served by <a href="https://chop.ax">chop.ax</a> --
  <a href="https://ko-fi.com/chopax">Support this project</a>
</div>
</body></html>`;
}

function normalizeUrl(raw: string): string {
  let u = raw;
  if (!u.startsWith("http://") && !u.startsWith("https://")) {
    u = "https://" + u;
  }
  const parsed = new URL(u);

  // Redirect reddit.com to old.reddit.com (lighter, less bot-hostile)
  if (
    parsed.hostname === "reddit.com" ||
    parsed.hostname === "www.reddit.com"
  ) {
    // /gallery/ID -> /comments/ID (old Reddit has no gallery route)
    const galleryMatch = parsed.pathname.match(/^\/gallery\/(\w+)/);
    if (galleryMatch) {
      parsed.pathname = `/comments/${galleryMatch[1]}`;
    }
    parsed.hostname = "old.reddit.com";
  }

  return parsed.href;
}

const MEDIA_EXTENSIONS = new Set([
  ".gif", ".jpg", ".jpeg", ".png", ".webp", ".svg",
  ".mp4", ".webm", ".mp3", ".ogg",
  ".pdf",
]);

const MEDIA_HOSTS = new Set([
  "i.redd.it",
  "preview.redd.it",
  "i.imgur.com",
]);

function isDirectMedia(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (MEDIA_HOSTS.has(parsed.hostname)) return true;
    const ext = parsed.pathname.substring(parsed.pathname.lastIndexOf(".")).toLowerCase();
    return MEDIA_EXTENSIONS.has(ext);
  } catch {
    return false;
  }
}
