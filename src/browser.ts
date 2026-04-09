import puppeteer from "puppeteer-extra";
import puppeteerVanilla from "puppeteer";
import AdblockerPlugin from "puppeteer-extra-plugin-adblocker";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser } from "puppeteer";

puppeteer.use(StealthPlugin());
puppeteer.use(
  AdblockerPlugin({
    blockTrackers: true,
    blockTrackersAndAnnoyances: true,
  })
);

const BROWSER_ARGS = [
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
  "--disable-extensions",
  "--disable-background-networking",
  "--disable-default-apps",
  "--disable-sync",
  "--disable-translate",
  "--metrics-recording-only",
  "--no-first-run",
];

// Sites where stealth/adblocker plugins cause consent walls or breakage
const NEEDS_VANILLA = new Set([
  "france24.com", "www.france24.com",
]);

const POOL_SIZE = Number(process.env.BROWSER_POOL) || 3;
console.log(`Browser pool size: ${POOL_SIZE}`);
const pool: (Browser | null)[] = new Array(POOL_SIZE).fill(null);
let robin = 0;

// Single vanilla browser instance (no plugins)
let vanillaBrowser: Browser | null = null;

async function launchBrowser(): Promise<Browser> {
  return (await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: BROWSER_ARGS,
  })) as Browser;
}

async function getVanillaBrowser(): Promise<Browser> {
  if (!vanillaBrowser || !vanillaBrowser.connected) {
    vanillaBrowser = await puppeteerVanilla.launch({
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: BROWSER_ARGS,
    });
  }
  return vanillaBrowser;
}

export async function getBrowser(): Promise<Browser> {
  const idx = robin;
  robin = (robin + 1) % POOL_SIZE;

  if (!pool[idx] || !pool[idx]!.connected) {
    pool[idx] = await launchBrowser();
  }
  return pool[idx]!;
}

export async function renderPage(
  url: string
): Promise<{ html: string; css: string; galleryPreviews?: Record<string, string> }> {
  const host = new URL(url).hostname;
  const b = NEEDS_VANILLA.has(host) ? await getVanillaBrowser() : await getBrowser();
  const page = await b.newPage();

  try {
    // Block images, fonts, and media -- they're stripped by the cleaner anyway
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const type = req.resourceType();
      if (type === "image" || type === "font" || type === "media") {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });

    // Dismiss cookie consent banners
    const dismissed = await page.evaluate(() => {
      const selectors = [
        // Didomi (france24, etc.)
        '#didomi-notice-agree-button',
        '.didomi-notice-agree-button',
        // OneTrust
        '#onetrust-accept-btn-handler',
        // Quantcast/CMP
        '.qc-cmp2-summary-buttons button[mode="primary"]',
        // Common consent frameworks
        '[id*="consent"] button[class*="accept"]',
        '[id*="consent"] button[class*="agree"]',
        '[class*="consent"] button[class*="accept"]',
        '[class*="consent"] button[class*="agree"]',
        '[id*="cookie"] button[class*="accept"]',
        '[id*="cookie"] button[class*="agree"]',
        // Generic patterns
        'button[data-testid="accept-cookies"]',
        'button[data-testid="cookie-accept"]',
        '[class*="CookieConsent"] button:first-of-type',
        '.cookie-banner button[class*="accept"]',
        '.cc-accept',
        '.cc-btn.cc-allow',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector<HTMLElement>(sel);
        if (btn) { btn.click(); return true; }
      }
      return false;
    }).catch(() => false);

    // Brief wait for content to load after consent dismissal
    if (dismissed) {
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 3000 }).catch(() => {});
    }

    // Extract all loaded CSS (inline + external stylesheets)
    const css = await page.evaluate(() => {
      let result = "";
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            result += rule.cssText + "\n";
          }
        } catch {
          // Cross-origin stylesheets throw SecurityError -- skip
        }
      }
      return result;
    });

    const html = await page.content();

    // Extract Reddit gallery preview URLs from JSON API
    let galleryPreviews: Record<string, string> | undefined;
    if (url.includes("reddit.com")) {
      galleryPreviews = await fetchGalleryPreviews(url);
    }

    return { html, css, galleryPreviews };
  } finally {
    await page.close();
  }
}

// Fetch gallery preview URLs from Reddit's JSON API
async function fetchGalleryPreviews(url: string): Promise<Record<string, string> | undefined> {
  try {
    const jsonUrl = url.replace(/\/?$/, ".json");
    const resp = await fetch(jsonUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; chop.ax/0.1)" },
      redirect: "follow",
    });
    if (!resp.ok) return undefined;
    const data = await resp.json() as any;
    const post = data?.[0]?.data?.children?.[0]?.data;
    const meta = post?.media_metadata;
    if (!meta || typeof meta !== "object") return undefined;

    const map: Record<string, string> = {};
    for (const [id, info] of Object.entries(meta) as [string, any][]) {
      const previews = info?.p;
      if (!Array.isArray(previews) || previews.length === 0) continue;
      const pick = previews.find((p: any) => p.x >= 320) || previews[previews.length - 1];
      if (pick?.u) map[id] = pick.u.replace(/&amp;/g, "&");
    }
    return Object.keys(map).length > 0 ? map : undefined;
  } catch {
    return undefined;
  }
}

// Simple HTTP fetch for server-rendered sites (no JS needed)
export async function fetchPage(
  url: string
): Promise<{ html: string; css: string; finalUrl: string; galleryPreviews?: Record<string, string> }> {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; chop.ax/0.1)",
      "Accept": "text/html",
    },
    redirect: "follow",
  });
  if (!resp.ok) {
    const err = new Error(`HTTP ${resp.status}`) as any;
    err.upstreamStatus = resp.status;
    throw err;
  }
  const html = await resp.text();
  // No external CSS extraction -- Readability/fallback don't need it for static sites
  return { html, css: "", finalUrl: resp.url };
}

// Scroll an Imgur album page and collect image IDs incrementally,
// since Imgur virtualizes the DOM and removes off-screen images.
export async function collectImgurImages(url: string): Promise<string[]> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });

    const ids = await page.evaluate(async () => {
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const seen = new Set<string>();
      const collect = () => {
        // Only grab images inside the album gallery, not suggestions/sidebar
        const container = document.querySelector(".Gallery-Content") || document;
        container.querySelectorAll("img").forEach((img) => {
          const src = img.getAttribute("src") || "";
          const m = src.match(/i\.imgur\.com\/([A-Za-z0-9]+?)(?:_d|h)?\.\w+/);
          if (m) seen.add(m[1]);
        });
      };

      // Collect at current scroll position
      collect();

      // Scroll down incrementally, collecting at each step
      let prev = 0;
      while (document.body.scrollHeight !== prev) {
        prev = document.body.scrollHeight;
        window.scrollTo(0, prev);
        await delay(400);
        collect();
      }

      return [...seen];
    });

    return ids;
  } finally {
    await page.close();
  }
}

// Kill all browser instances on process exit
async function closeAll() {
  for (const b of pool) {
    if (b && b.connected) {
      try { await b.close(); } catch {}
    }
  }
  pool.fill(null);
  if (vanillaBrowser && vanillaBrowser.connected) {
    try { await vanillaBrowser.close(); } catch {}
  }
  vanillaBrowser = null;
}

process.on("exit", () => { closeAll(); });
process.on("SIGINT", () => { closeAll().then(() => process.exit(0)); });
process.on("SIGTERM", () => { closeAll().then(() => process.exit(0)); });
