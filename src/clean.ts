import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import * as cheerio from "cheerio";
import { PurgeCSS } from "purgecss";
import { transform } from "lightningcss";

const SYSTEM_FONTS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, ' +
  '"Helvetica Neue", Arial, sans-serif';

const READER_CSS = `
  body {
    font-family: ${SYSTEM_FONTS};
    max-width: 680px;
    margin: 0 auto;
    padding: 20px;
    line-height: 1.6;
    color: #222;
    background: #fff;
  }
  h1 { font-size: 1.8em; line-height: 1.2; margin-bottom: 0.3em; }
  .byline { color: #666; margin-bottom: 1.5em; }
  a { color: #06c; }
  img { max-width: 100%; height: auto; }
  pre, code { overflow-x: auto; }
  .chop-footer {
    text-align: center; padding: 20px; margin-top: 40px;
    border-top: 1px solid #ccc; font-size: 14px; color: #666;
  }
  /* Reddit comment threading */
  .comment { margin: 8px 0; padding: 4px 0; }
  .child { margin-left: 16px; padding-left: 8px; border-left: 2px solid #ddd; }
  .tagline { font-size: 0.85em; color: #888; }
  .author { color: #06c; font-weight: bold; text-decoration: none; }
  .md { margin: 4px 0; }
`;

export async function cleanHtml(
  html: string,
  css: string,
  sourceUrl: string
): Promise<string> {
  // Skip Readability for listing/index pages (e.g. subreddit fronts, HN)
  if (isListingPage(sourceUrl)) {
    return fallbackClean(html, css, sourceUrl);
  }

  // Run Readability to extract article content
  const dom = new JSDOM(html, { url: sourceUrl });
  const doc = dom.window.document;

  if (!isProbablyReaderable(doc)) {
    return fallbackClean(html, css, sourceUrl);
  }

  const reader = new Readability(doc);
  const article = reader.parse();

  if (!article) {
    return fallbackClean(html, css, sourceUrl);
  }

  // Build a clean reader-view page
  const $ = cheerio.load(`<!DOCTYPE html>
<html lang="${article.lang || "en"}" dir="${article.dir || "ltr"}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(article.title || "")}</title>
  <style>${READER_CSS}</style>
</head>
<body>
  <h1>${escapeHtml(article.title || "")}</h1>
  ${article.byline ? `<p class="byline">${escapeHtml(article.byline)}</p>` : ""}
  <article>${article.content}</article>
  <div class="chop-footer">
    <a href="${escapeHtml(sourceUrl)}">Original page</a> --
    Served by <a href="https://chop.ax">chop.ax</a> --
    <a href="https://ko-fi.com/chopax">Support this project</a>
  </div>
</body>
</html>`);

  // Strip any scripts Readability may have left
  $("script").remove();

  // Strip images without explicit small dimensions
  stripHeavyMedia($);

  // Rewrite links through proxy
  rewriteUrls($, sourceUrl);

  return $.html();
}

async function fallbackClean(
  html: string,
  css: string,
  sourceUrl: string
): Promise<string> {
  const $ = cheerio.load(html);

  // Strip scripts
  $("script, noscript").remove();
  $("video, iframe, object, embed").remove();

  // Remove common non-content elements
  $(
    "nav, header, footer, aside, .sidebar, .side, .nav, .menu, .header, " +
      ".footer, .ad, .ads, .advertisement, [role='navigation'], " +
      "[role='banner'], [role='complementary'], [role='contentinfo'], " +
      ".search, .promoted, .sponsorlink, " +
      ".midcol, .rank, .score, .loading, .expando, " +
      ".flat-list.buttons, .dropdown, .menuarea, .infobar, " +
      "[class*='reportform'], .login-required, .usertext-edit, " +
      ".footer-parent, .bottommenu, .debuginfo, .morechildren, " +
      ".numchildren, .clearleft, .parent, .child:empty, " +
      "input[type='hidden']"
  ).remove();

  // Unwrap forms (keep contents, remove the form wrapper)
  $("form").each((_, el) => {
    $(el).replaceWith($(el).html() || "");
  });

  // Strip heavy media
  stripHeavyMedia($);

  // Strip all attributes except a small whitelist
  const KEEP_ATTRS = new Set(["href", "src", "alt", "class"]);
  $("*").each((_, el) => {
    const elem = $(el);
    const attribs = (el as any).attribs || {};
    for (const attr of Object.keys(attribs)) {
      if (!KEEP_ATTRS.has(attr)) {
        elem.removeAttr(attr);
      }
    }
  });

  // Remove empty elements that served as JS hooks or decorations
  $(".userattrs, .expand, .domain").remove();
  $("[hidden]").remove();

  // Strip classes down to only the ones our CSS uses
  const KEEP_CLASSES = new Set([
    "comment", "child", "tagline", "author", "md",
    "entry", "content", "commentarea", "title",
    "chop-footer",
  ]);
  $("[class]").each((_, el) => {
    const elem = $(el);
    const classes = (elem.attr("class") || "").split(/\s+/).filter(Boolean);
    const kept = classes.filter((c) => KEEP_CLASSES.has(c));
    if (kept.length) {
      elem.attr("class", kept.join(" "));
    } else {
      elem.removeAttr("class");
    }
  });

  // Remove empty spans/divs left behind
  $("span:empty, div:empty, p:empty").remove();

  // Unwrap classless divs and spans (structural wrappers with no meaning)
  // Run twice to handle nested wrappers
  for (let i = 0; i < 2; i++) {
    $("div:not([class]), span:not([class])").each((_, el) => {
      $(el).replaceWith($(el).html() || "");
    });
  }

  // Unwrap <time> tags (keep text, remove tag)
  $("time").each((_, el) => {
    $(el).replaceWith($(el).text());
  });

  // Remove stray <style> tags in body
  $("body style").remove();

  // Clean up <head>: strip everything except <title> and <meta charset>
  const title = $("title").first().text();
  $("head").empty();
  $("head").append(
    `<meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escapeHtml(title)}</title>` +
      `<style>${READER_CSS}</style>`
  );

  // Strip classes and schema attributes from html/body
  $("html").removeAttr("class").removeAttr("xmlns").removeAttr("xml:lang");
  $("body").removeAttr("class").removeAttr("itemscope").removeAttr("itemtype");
  $("[itemscope]").removeAttr("itemscope").removeAttr("itemtype");
  $("[itemprop]").removeAttr("itemprop");

  rewriteUrls($, sourceUrl);

  $("body").append(
    `<div class="chop-footer">` +
      `<a href="${escapeHtml(sourceUrl)}">Original page</a> -- ` +
      `Served by <a href="https://chop.ax">chop.ax</a> -- ` +
      `<a href="https://ko-fi.com/chopax">Support this project</a></div>`
  );

  return $.html();
}

function stripHeavyMedia($: cheerio.CheerioAPI): void {
  $("video, iframe, object, embed").remove();

  $("img").each((_, el) => {
    const elem = $(el);
    const w = parseInt(elem.attr("width") || "0", 10);
    const h = parseInt(elem.attr("height") || "0", 10);

    if (w > 100 || h > 100) {
      elem.remove();
      return;
    }

    const style = elem.attr("style") || "";
    const sw = parsePxValue(style, "width");
    const sh = parsePxValue(style, "height");
    if (sw > 100 || sh > 100) {
      elem.remove();
      return;
    }

    // No explicit dimensions -- likely full-size. Keep small data URIs.
    if (!w && !h && !sw && !sh) {
      const src = elem.attr("src") || "";
      if (src.startsWith("data:") && src.length < 2000) return;
      elem.remove();
    }
  });

  $("img[srcset]").removeAttr("srcset");
  $("picture source").remove();
}

function parsePxValue(style: string, prop: string): number {
  const match = style.match(new RegExp(prop + "\\s*:\\s*(\\d+)\\s*px"));
  return match ? parseInt(match[1], 10) : 0;
}

async function processCss(html: string, css: string): Promise<string> {
  if (!css.trim()) return "";

  const purgeResult = await new PurgeCSS().purge({
    content: [{ raw: html, extension: "html" }],
    css: [{ raw: css }],
  });
  let purged = purgeResult.map((r) => r.css).join("\n");

  purged = purged.replace(/@font-face\s*\{[^}]*\}/g, "");
  purged = purged.replace(
    /font-family\s*:[^;}"']+/g,
    `font-family: ${SYSTEM_FONTS}`
  );

  try {
    const { code } = transform({
      filename: "styles.css",
      code: Buffer.from(purged),
      minify: true,
      errorRecovery: true,
    });
    return code.toString();
  } catch {
    return purged;
  }
}

function rewriteUrls($: cheerio.CheerioAPI, sourceUrl: string): void {
  const base = new URL(sourceUrl);

  $("a[href]").each((_, el) => {
    const elem = $(el);
    if (elem.closest(".chop-footer").length) return;
    const href = elem.attr("href");
    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("javascript:") ||
      href.startsWith("mailto:")
    )
      return;

    try {
      const absolute = new URL(href, base).href;
      elem.attr("href", "/" + absolute);
    } catch {
      // Malformed -- leave as-is
    }
  });

  $("img[src]").each((_, el) => {
    const elem = $(el);
    const src = elem.attr("src");
    if (!src || src.startsWith("data:")) return;
    try {
      elem.attr("src", new URL(src, base).href);
    } catch {
      // Malformed -- leave as-is
    }
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isListingPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const path = parsed.pathname;

    // Reddit: always use fallback (listings and comment threads both)
    if (host.includes("reddit.com")) {
      return true;
    }

    // HN front page and listing pages
    if (host === "news.ycombinator.com") {
      return !path.startsWith("/item");
    }

    // Lobsters front page
    if (host === "lobste.rs") {
      return !path.startsWith("/s/");
    }

    return false;
  } catch {
    return false;
  }
}
