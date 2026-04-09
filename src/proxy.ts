import { randomUUID } from "crypto";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { getConnInfo } from "hono/bun";
import { isAllowed, getAllowedDomainsHtml } from "./whitelist";
import { getCached, setCache, redis } from "./cache";
import { renderPage, fetchPage, collectImgurImages } from "./browser";
import { cleanInWorker } from "./worker-pool";
import { ThinContentError } from "./clean";

const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT) || 16;
console.log(`Maximum concurrent renders: ${MAX_CONCURRENT}`);
export const RENDER_TIMEOUT = Number(process.env.RENDER_TIMEOUT) || 10;
console.log(`Render timeout: ${RENDER_TIMEOUT} s`);
let activeRenders = 0;
const inflight = new Map<string, Promise<string>>();

// Rate limiting: sliding window counters for renders only (Redis sorted sets)
const RATE_WINDOW = Number(process.env.RATE_WINDOW) || 60;
console.log(`Rate limiting window: ${RATE_WINDOW} s`);
const RATE_PER_USER = Number(process.env.RATE_PER_USER) || 10;
console.log(`Rate limit per user: ${RATE_PER_USER}`);
const RATE_PER_IP = Number(process.env.RATE_PER_IP) || 30;
console.log(`Rate limit per IP: ${RATE_PER_IP}`);

async function checkRate(key: string, limit: number): Promise<boolean> {
  const redisKey = `rate:${key}`;
  const now = Date.now();
  const windowStart = now - RATE_WINDOW * 1000;
  const count = await redis.zcount(redisKey, windowStart, "+inf");
  return count >= limit;
}

async function recordHit(key: string): Promise<void> {
  const redisKey = `rate:${key}`;
  const now = Date.now();
  const windowStart = now - RATE_WINDOW * 1000;
  await redis
    .multi()
    .zadd(redisKey, now, `${now}:${Math.random().toString(36).slice(2, 8)}`)
    .zremrangebyscore(redisKey, "-inf", windowStart)
    .expire(redisKey, RATE_WINDOW)
    .exec();
}

// Auto-ban: IPs that send too many 400s get blocked (vuln scanners)
const BAN_THRESHOLD = 10;
const BAN_WINDOW = 60;
const BAN_DURATION = 3600;

export function extractIp(c: Context): string {
  const raw = c.req.raw.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || c.req.header("x-real-ip")
    || getConnInfo(c).remote.address
    || "unknown";
  return raw.replace(/^::ffff:/, "");
}

export async function banMiddleware(c: Context, next: () => Promise<void>): Promise<Response | void> {
  const ip = extractIp(c);
  const banned = await redis.exists(`ban:${ip}`);
  if (banned) return c.body("Weird Barbie error: You played with me too hard.", 403);

  await next();

  if (c.res.status === 400) {
    const now = Date.now();
    const redisKey = `banhits:${ip}`;
    const windowStart = now - BAN_WINDOW * 1000;
    await redis
      .multi()
      .zadd(redisKey, now, `${now}:${Math.random().toString(36).slice(2, 8)}`)
      .zremrangebyscore(redisKey, "-inf", windowStart)
      .expire(redisKey, BAN_WINDOW * 2)
      .exec();
    const count = await redis.zcount(redisKey, windowStart, "+inf");
    if (count >= BAN_THRESHOLD) {
      await redis.set(`ban:${ip}`, "1", "EX", BAN_DURATION);
      await redis.del(redisKey);
      console.warn(`[ban] Banned ${ip} for ${BAN_DURATION}s after ${BAN_THRESHOLD} 400s`);
    }
  }
}

export async function handleProxy(c: Context): Promise<Response> {
  let reqUrl: URL;
  try {
    reqUrl = new URL(c.req.url);
  } catch {
    return c.text("Invalid URL", 400);
  }
  const rawUrl = reqUrl.pathname.slice(1) + reqUrl.search;

  // Resolve client identity early so all log lines can include it
  let userId = getCookie(c, "chop_id");
  if (!userId) {
    userId = randomUUID();
    setCookie(c, "chop_id", userId, { maxAge: 86400 * 365, httpOnly: true, sameSite: "Lax" });
  }
  const clientIp = extractIp(c);
  const client = `ip=${clientIp} user=${userId}`;

  if (!rawUrl || rawUrl === "?") {
    console.warn(`[400] No URL provided ${client}`);
    return c.text("No URL provided", 400);
  }

  let url: string;
  try {
    url = normalizeUrl(rawUrl);
  } catch {
    console.warn(`[400] Invalid URL: ${rawUrl} ${client}`);
    return c.text("Invalid URL", 400);
  }

  if (!isAllowed(url)) {
    console.warn(`[403] Domain not allowed: ${url} ${client}`);
    const domains = getAllowedDomainsHtml();
    const escaped = url.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
    return c.html(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Domain not allowed - chop.ax</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;max-width:680px;margin:0 auto;padding:40px 20px;color:#222}a{color:#06c}h4{margin:12px 0 4px}ul{margin:0 0 8px;padding-left:20px}</style>
</head><body>
<h1>Domain not allowed</h1>
<p>You can still visit the original page: <a href="${escaped}">${escaped}</a></p>
<h3>Whitelisted domains</h3>
${domains}
</body></html>`, 403);
  }

  // Reddit video URLs -- serve a lightweight HLS player page
  if (isRedditVideo(url)) {
    const videoId = new URL(url).pathname.split("/")[1];
    const hlsUrl = `https://v.redd.it/${videoId}/HLSPlaylist.m3u8`;
    return c.html(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>chop.ax</title>
<style>body{margin:0;display:flex;justify-content:center;align-items:center;min-height:100vh;background:#111}video{max-width:100%;max-height:100vh}</style>
<script src="https://cdn.jsdelivr.net/npm/hls.js@latest/dist/hls.min.js"></script>
</head><body>
<video id="v" controls autoplay playsinline></video>
<script>
var v=document.getElementById("v"),u="${hlsUrl}";
if(v.canPlayType("application/vnd.apple.mpegurl")){v.src=u}
else if(Hls.isSupported()){var h=new Hls();h.loadSource(u);h.attachMedia(v)}
</script>
</body></html>`);
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

  // Rate limit renders: per-user (cookie) and per-IP
  const userKey = `user:${userId}`;
  const ipKey = `ip:${clientIp}`;
  const [userLimited, ipLimited] = await Promise.all([
    checkRate(userKey, RATE_PER_USER),
    checkRate(ipKey, RATE_PER_IP),
  ]);

  if (userLimited) {
    console.warn(`[429] Rate limited (per-user): ${url} ${client}`);
    return c.text("Rate limit exceeded. Please wait a moment.", 429);
  }
  if (ipLimited) {
    console.warn(`[429] Rate limited (per-IP): ${url} ${client}`);
    return c.text("Rate limit exceeded. Please wait a moment.", 429);
  }

  await Promise.all([recordHit(userKey), recordHit(ipKey)]);

  // Dedup in-flight requests for the same URL
  if (inflight.has(url)) {
    try {
      const html = await inflight.get(url)!;
      return c.html(html);
    } catch {
      console.warn(`[502] In-flight render failed: ${url} ${client}`);
      return c.text("Failed to process page", 502);
    }
  }

  if (activeRenders >= MAX_CONCURRENT) {
    console.warn(`[503] Server busy (${activeRenders}/${MAX_CONCURRENT} renders): ${url} ${client}`);
    return c.text("Server busy, try again shortly", 503);
  }

  const promise = processPage(url, client);
  inflight.set(url, promise);
  // Prevent unhandled rejection if timeout wins the race
  promise.catch(() => {});

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Render timed out")), RENDER_TIMEOUT * 1000)
  );

  try {
    const html = await Promise.race([promise, timeout]);
    return c.html(html);
  } catch (err) {
    const isTimeout = err instanceof Error && err.message === "Render timed out";
    const upstream = (err as any)?.upstreamStatus as number | undefined;
    const msg = isTimeout
      ? "Page took too long to render"
      : upstream
        ? `Origin returned HTTP ${upstream}`
        : "Failed to fetch and process the page";
    const code = isTimeout ? 524 : upstream || 502;
    console.warn(`[${code}] ${msg}: ${url} ${client}`);
    return c.text(msg, code as any);
  } finally {
    inflight.delete(url);
  }
}

// Sites that need JS rendering (Puppeteer). Everything else uses simple fetch.
const NEEDS_PUPPETEER = new Set([
  "reddit.com", "old.reddit.com", "www.reddit.com",
  "imgur.com", "www.imgur.com",
  "france24.com", "www.france24.com",
  "aljazeera.com", "www.aljazeera.com",
  "lemonde.fr", "www.lemonde.fr",
  "reuters.com", "www.reuters.com",
  "mayoclinic.org", "www.mayoclinic.org",
  "washingtonpost.com", "www.washingtonpost.com",
  "nytimes.com", "www.nytimes.com",
  "blog.adafruit.com",
  "stacks.cdc.gov",
]);

function needsPuppeteer(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return NEEDS_PUPPETEER.has(host);
  } catch {
    return true; // default to Puppeteer if unsure
  }
}

async function processPage(url: string, client?: string): Promise<string> {
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

    const usePuppeteer = needsPuppeteer(url);
    let rendered = usePuppeteer
      ? await renderPage(url)
      : await fetchPage(url);
    let cleaned: string;
    try {
      cleaned = await cleanInWorker(rendered.html, rendered.css, url, rendered.galleryPreviews, client);
    } catch (err) {
      // Thin content from plain fetch -- retry with Puppeteer
      if (err instanceof ThinContentError && !usePuppeteer) {
        console.warn(`[retry] Thin content, retrying with Puppeteer: ${url} ${client || ""}`);
        rendered = await renderPage(url);
        try {
          cleaned = await cleanInWorker(rendered.html, rendered.css, url, rendered.galleryPreviews, client);
        } catch (err2) {
          if (err2 instanceof ThinContentError) {
            cleaned = err2.html;
          } else {
            throw err2;
          }
        }
      } else if (err instanceof ThinContentError) {
        // Already used Puppeteer; serve whatever we got
        cleaned = err.html;
      } else {
        throw err;
      }
    }
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
  <a href="https://ko-fi.com/xfoax">Support this project</a> --
  <a href="https://github.com/xfoa/chop.ax">Contribute</a>
</div>
</body></html>`;
}

function normalizeUrl(raw: string): string {
  let u = raw;
  if (!u.startsWith("http://") && !u.startsWith("https://")) {
    u = "https://" + u;
  }
  const parsed = new URL(u);

  // Reject URLs whose hostname has no dot -- these are mangled relative paths
  // (e.g. "build/images/sprite.svg" -> "https://build/images/sprite.svg")
  if (!parsed.hostname.includes(".")) {
    throw new Error("Invalid hostname");
  }

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

function isRedditVideo(url: string): boolean {
  try {
    return new URL(url).hostname === "v.redd.it";
  } catch {
    return false;
  }
}

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
