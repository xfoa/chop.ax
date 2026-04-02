import puppeteer from "puppeteer-extra";
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

let browser: Browser | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.connected) {
    browser = (await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    })) as Browser;
  }
  return browser;
}

export async function renderPage(
  url: string
): Promise<{ html: string; css: string }> {
  const b = await getBrowser();
  const page = await b.newPage();

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 15000 });

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
    return { html, css };
  } finally {
    await page.close();
  }
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
