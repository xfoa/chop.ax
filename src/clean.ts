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
  /* HN comment threading */
  .comment { margin: 8px 0; padding: 4px 0; }
  .child { margin-left: 16px; padding-left: 8px; border-left: 2px solid #ddd; }
  .tagline { font-size: 0.85em; color: #888; }
  .author { color: #06c; font-weight: bold; text-decoration: none; }
  .md { margin: 4px 0; }
  /* HN comment depth */
  .hn-comment { margin: 8px 0; padding: 4px 0; }
  .hn-indent { margin-left: 20px; padding-left: 8px; border-left: 2px solid #ddd; }
`;

export async function cleanHtml(
  html: string,
  css: string,
  sourceUrl: string
): Promise<string> {
  // HN comment pages get special treatment to preserve threading
  const parsedUrl = new URL(sourceUrl);
  if (parsedUrl.hostname === "news.ycombinator.com" && parsedUrl.pathname.startsWith("/item")) {
    return cleanHnComments(html, sourceUrl);
  }

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
  <title>${article.title || ""}</title>
  <style>${READER_CSS}</style>
</head>
<body>
  <h1>${article.title || ""}</h1>
  ${article.byline ? `<p class="byline">${article.byline}</p>` : ""}
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

function cleanHnComments(html: string, sourceUrl: string): string {
  const $ = cheerio.load(html);

  // Extract post title and link
  const titleLink = $(".titleline a").first();
  const postTitle = titleLink.text() || $("title").text() || "";
  const postHref = titleLink.attr("href") || "";

  // Extract submission text if present
  const topText = $(".toptext").html() || "";

  // Build comment list with indent levels
  const comments: { indent: number; user: string; age: string; text: string }[] = [];
  $("tr.athing.comtr").each((_, el) => {
    const row = $(el);
    const indent = parseInt(row.find("td.ind").attr("indent") || "0", 10);
    const user = row.find(".hnuser").text();
    const age = row.find(".age a").text();
    const text = row.find(".commtext").html() || "";
    if (text) {
      comments.push({ indent, user, age, text });
    }
  });

  // Nest comments into indented divs
  let commentsHtml = "";
  let prevIndent = 0;
  let openDivs = 0;

  for (const c of comments) {
    // Close divs to get back to the right level
    while (prevIndent > c.indent) {
      commentsHtml += "</div>";
      openDivs--;
      prevIndent--;
    }
    // Open indent wrapper if going deeper
    if (c.indent > prevIndent) {
      for (let i = prevIndent; i < c.indent; i++) {
        commentsHtml += '<div class="hn-indent">';
        openDivs++;
      }
    }
    prevIndent = c.indent;

    const userHtml = c.user ? `<a href="user?id=${escapeHtml(c.user)}" class="author">${escapeHtml(c.user)}</a>` : "";
    commentsHtml += `<div class="hn-comment"><div class="tagline">${userHtml} ${escapeHtml(c.age)}</div><div class="md">${c.text}</div></div>`;
  }
  // Close remaining open divs
  while (openDivs > 0) {
    commentsHtml += "</div>";
    openDivs--;
  }

  // Clean the comment HTML (strip heavy media, fix links)
  const page = cheerio.load(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(postTitle)}</title>
<style>${READER_CSS}</style>
</head><body>
<p class="byline"><a href="/">Hacker News</a></p>
<h1>${postHref ? `<a href="${escapeHtml(postHref)}">${escapeHtml(postTitle)}</a>` : escapeHtml(postTitle)}</h1>
${topText ? `<div class="md">${topText}</div><hr>` : ""}
${commentsHtml}
<div class="chop-footer">
  <a href="${escapeHtml(sourceUrl)}">Original page</a> --
  Served by <a href="https://chop.ax">chop.ax</a> --
  <a href="https://ko-fi.com/chopax">Support this project</a>
</div>
</body></html>`);

  rewriteUrls(page, sourceUrl);
  return page.html();
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
