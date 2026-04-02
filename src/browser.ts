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
