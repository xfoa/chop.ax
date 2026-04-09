import { Readability, isProbablyReaderable } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import * as cheerio from "cheerio";
import { PurgeCSS } from "purgecss";
import { transform } from "lightningcss";

export class ThinContentError extends Error {
  constructor() { super("Thin content"); this.name = "ThinContentError"; }
}

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
  .gallery-img { max-width: 200px; height: auto; display: inline-block; margin: 4px; }
`;

export async function cleanHtml(
  html: string,
  css: string,
  sourceUrl: string,
  galleryPreviews?: Record<string, string>,
  client?: string
): Promise<string> {
  // HN comment pages get special treatment to preserve threading
  const parsedUrl = new URL(sourceUrl);
  if (parsedUrl.hostname === "news.ycombinator.com" && parsedUrl.pathname.startsWith("/item")) {
    return cleanHnComments(html, sourceUrl);
  }

  let result: string;

  // Skip Readability for listing/index pages (e.g. subreddit fronts, HN)
  if (isListingPage(sourceUrl)) {
    result = await fallbackClean(html, css, sourceUrl, galleryPreviews);
  } else {
    // Run Readability to extract article content
    const virtualConsole = new VirtualConsole();
    virtualConsole.on("error", (msg: string) => {
      console.warn(`[jsdom] ${msg} url=${sourceUrl} ${client || ""}`);
    });
    const dom = new JSDOM(html, { url: sourceUrl, virtualConsole });
    const doc = dom.window.document;

    if (!isProbablyReaderable(doc)) {
      result = await fallbackClean(html, css, sourceUrl, galleryPreviews);
    } else {
      const reader = new Readability(doc);
      const article = reader.parse();

      if (!article) {
        result = await fallbackClean(html, css, sourceUrl, galleryPreviews);
      } else {
        result = cleanReadabilityArticle(article, sourceUrl);
      }
    }
  }

  // Detect near-empty output (JS-dependent pages that render nothing useful).
  // Skip this check if paywall content was detected -- partial articles are
  // expected to be short and we should serve what we have.
  const isPaywalled = result.includes("behind a paywall");
  if (!isPaywalled) {
    const visible = result
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    const wordCount = visible.split(" ").length;
    if (wordCount < 80) {
      throw new ThinContentError();
    }
  }

  return result;
}

function cleanReadabilityArticle(
  article: { title?: string | null; byline?: string | null; content?: string | null; lang?: string | null; dir?: string | null },
  sourceUrl: string
): string {
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
    <a href="https://ko-fi.com/chopax">Support this project</a> --
    <a href="https://github.com/xfoa/chop.ax">Contribute</a>
  </div>
</body>
</html>`);

  $("script").remove();
  stripHeavyMedia($);
  const hadPaywall = stripPaywallNoise($);
  rewriteUrls($, sourceUrl);

  if (hadPaywall) {
    $("body > article").last().append(
      `<p style="margin-top:2em;padding:12px;background:#fff3cd;border:1px solid #e0c36e;border-radius:4px;font-size:0.9em">` +
      `This article is behind a paywall. Only the freely available portion is shown above. ` +
      `<a href="${escapeHtml(sourceUrl)}">View the full article on the original site.</a></p>`
    );
  }

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
  <a href="https://ko-fi.com/xfoax">Support this project</a> --
  <a href="https://github.com/xfoa/chop.ax">Contribute</a>
</div>
</body></html>`);

  rewriteUrls(page, sourceUrl);
  return page.html();
}

async function fallbackClean(
  html: string,
  css: string,
  sourceUrl: string,
  galleryPreviews?: Record<string, string>
): Promise<string> {
  // Strip IE conditional comments (can hide scripts)
  html = html.replace(/<!--\[if[^\]]*\]>[\s\S]*?<!\[endif\]-->/gi, "");

  const $ = cheerio.load(html);

  // Strip scripts
  $("script, noscript").remove();
  $("video, iframe, object, embed").remove();

  // Preserve Reddit "N comments" links before stripping button bars
  $(".flat-list.buttons").each((_, el) => {
    const list = $(el);
    const commentsLink = list.find("a.comments").first();
    if (commentsLink.length) {
      list.before(commentsLink);
    }
  });

  // Expand Reddit gallery posts: use preview thumbnails when available
  $(".media-gallery").each((_, el) => {
    const gallery = $(el);
    const ids: string[] = [];
    gallery.find(".gallery-tile[data-media-id]").each((_, tile) => {
      const mediaId = $(tile).attr("data-media-id");
      if (mediaId) ids.push(mediaId);
    });
    if (ids.length) {
      const images = ids
        .map((id) => {
          const full = `https://i.redd.it/${id}.jpg`;
          const thumb = galleryPreviews?.[id] || full;
          return `<a href="${full}"><img class="gallery-img" src="${thumb}" alt="" loading="lazy"></a>`;
        })
        .join("\n");
      // Insert images before the .expando parent (which gets removed later)
      const expando = gallery.closest(".expando");
      if (expando.length) {
        expando.after(images);
      } else {
        gallery.after(images);
      }
      gallery.remove();
    }
  });

  // Remove common non-content elements
  // On listing pages, keep <aside> -- news sites often use it for content sections
  const isListing = isListingPage(sourceUrl);
  const removeSelectors =
    "nav, footer, .sidebar, .side, .nav, .menu, .header, " +
    ".footer, .ad, .ads, .advertisement, [role='navigation'], " +
    "[role='banner'], [role='complementary'], [role='contentinfo'], " +
    ".search, .promoted, .sponsorlink, " +
    "[class*='contribution-prompt'], [class*='login-ribbon'], " +
    "[class*='auth-flow'], [class*='daily-poll'], " +
    "[class*='navigation-modal'], [class*='navigation-overlay'], " +
    "[class*='sponsor'], [class*='native-ad'], " +
    "[class*='statistics'], [class*='share-pulldown'], " +
    "[class*='social-container'], " +
    ".midcol, .rank, .score, .loading, .expando, " +
    ".flat-list.buttons, .dropdown, .menuarea, .infobar, " +
    "[class*='reportform'], .login-required, .usertext-edit, " +
    ".footer-parent, .bottommenu, .debuginfo, .morechildren, " +
    ".numchildren, .clearleft, .parent, .child:empty, " +
    "input[type='hidden']" +
    (isListing ? "" : ", aside, header");
  $(removeSelectors).remove();

  // Fix empty overlay links before classes are stripped (needs [class*='title'])
  $("a[href]").each((_, el) => {
    const elem = $(el);
    if (elem.text().trim()) return;
    const parent = elem.parent();
    if (!parent.length) return;
    const titleEl = parent.find("[class*='title'], h1, h2, h3, h4").first();
    if (titleEl.length) {
      elem.text(titleEl.text().trim());
      titleEl.remove();
      // Add separator before the card container
      parent.before("<hr>");
    } else {
      const text = parent.text().trim();
      if (text) {
        const label = text.split("\n")[0].trim().slice(0, 200);
        if (label) elem.text(label);
      }
    }
  });

  // Unwrap forms (keep contents, remove the form wrapper)
  $("form").each((_, el) => {
    $(el).replaceWith($(el).html() || "");
  });

  // Strip heavy media and paywall noise
  stripHeavyMedia($);
  const hadPaywall = stripPaywallNoise($);

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
    "chop-footer", "gallery-img",
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
  const originTitle = $("title").first().text();
  const host = new URL(sourceUrl).hostname.replace(/^www\./, "");
  const pageTitle = isListing ? host : originTitle;
  $("head").empty();
  $("head").append(
    `<meta charset="utf-8">` +
      `<meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${escapeHtml(pageTitle)}</title>` +
      `<style>${READER_CSS}</style>`
  );

  // Add site heading for listing pages
  if (isListing) {
    $("body").prepend(`<h1>${escapeHtml(host)}</h1>`);
  }

  // Strip classes and schema attributes from html/body
  $("html").removeAttr("class").removeAttr("xmlns").removeAttr("xml:lang");
  $("body").removeAttr("class").removeAttr("itemscope").removeAttr("itemtype");
  $("[itemscope]").removeAttr("itemscope").removeAttr("itemtype");
  $("[itemprop]").removeAttr("itemprop");

  rewriteUrls($, sourceUrl);

  // Final safety pass: remove any scripts that survived earlier stripping
  // (e.g. inside conditional comments, re-exposed by DOM unwrapping)
  $("script").remove();

  if (hadPaywall) {
    $("body").append(
      `<p style="margin-top:2em;padding:12px;background:#fff3cd;border:1px solid #e0c36e;border-radius:4px;font-size:0.9em">` +
      `This article is behind a paywall. Only the freely available portion is shown above. ` +
      `<a href="${escapeHtml(sourceUrl)}">View the full article on the original site.</a></p>`
    );
  }

  $("body").append(
    `<div class="chop-footer">` +
      `<a href="${escapeHtml(sourceUrl)}">Original page</a> -- ` +
      `Served by <a href="https://chop.ax">chop.ax</a> -- ` +
      `<a href="https://ko-fi.com/chopax">Support this project</a> -- ` +
      `<a href="https://github.com/xfoa/chop.ax">Contribute</a></div>`
  );

  let out = $.html();

  // Final safety: regex-strip any <script> tags that survived DOM-based removal
  // (e.g. scripts inside HTML comments that Cheerio can't reach as DOM nodes)
  // Match paired <script>...</script> first, then any remaining opener tags
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<script\b[^>]*>[^]*?(?=<[a-z])/gi, "");
  out = out.replace(/<script\b[^>]*>[\s\S]*$/gi, "");

  return out;
}

function stripHeavyMedia($: cheerio.CheerioAPI): void {
  $("video, iframe, object, embed").remove();

  $("img").each((_, el) => {
    const elem = $(el);
    // Preserve gallery images we injected
    if (elem.hasClass("gallery-img")) return;
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

// Paywall / subscription UI patterns to strip from article content.
// These match text that paywalled sites inject into the DOM (login prompts,
// subscription offers, device-limit warnings, "X% remaining" teasers).
const PAYWALL_PATTERNS = [
  // French paywalls (Le Monde, Le Figaro, etc.)
  /il vous reste \d+[\.,]?\d*\s*% de cet article/i,
  /la suite est r[e\u00e9]serv[e\u00e9]e aux abonn[e\u00e9]s/i,
  /article r[e\u00e9]serv[e\u00e9] aux abonn[e\u00e9]s/i,
  /cet article vous est offert/i,
  /lecture restreinte/i,
  /connectez-vous.*inscrivez-vous/is,
  /se connecter.*inscrivez-vous/is,
  /vous n.+tes pas inscrit/i,
  /^se connecter$/i,
  /temps de lecture.*\d+\s*min/i,
  /vous ne pouvez lire .+ que sur un seul appareil/i,
  /d[e\u00e9]couvrir l.offre/i,
  /d[e\u00e9]couvrir les offres/i,
  /votre abonnement n.autorise pas/i,
  /ce message s.affichera sur l.autre appareil/i,
  /comment ne plus voir ce message/i,
  /modifier votre mot de passe/i,
  /vous pouvez vous connecter avec votre compte sur autant/i,
  // English paywalls (generic)
  /subscribe to continue reading/i,
  /this article is for (paid )?subscribers/i,
  /you.ve (reached|hit) your (free )?article limit/i,
  /create a free account to continue/i,
  /already a subscriber\? (sign|log) in/i,
];

// IDs and selectors commonly used by paywall overlays
const PAYWALL_SELECTORS = [
  "[id*='capping']",
  "[id*='paywall']",
  "[id*='metered']",
  "[class*='paywall']",
  "[class*='metered']",
  "[class*='premium-wall']",
  "[class*='subscribe-wall']",
  "[class*='piano-']",
].join(", ");

function stripPaywallNoise($: cheerio.CheerioAPI): boolean {
  let found = false;

  // Remove elements matching paywall selectors
  const paywallEls = $(PAYWALL_SELECTORS);
  if (paywallEls.length) found = true;
  paywallEls.remove();

  // Remove leaf-ish elements whose text matches paywall patterns.
  // Only target elements with no block-level children to avoid nuking
  // a container that wraps both paywall UI and real article paragraphs.
  const blockTags = new Set(["div", "p", "section", "article", "ul", "ol", "table", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);
  const root = $("article").length ? "article" : "body";
  $(`${root} *`).each((_, el) => {
    const elem = $(el);
    // Skip if this element has block-level children -- it's a wrapper
    let hasBlockChild = false;
    elem.children().each((_, child) => {
      if (blockTags.has((child as any).tagName)) { hasBlockChild = true; }
    });
    if (hasBlockChild) return;

    const text = elem.text();
    if (text.length > 2000) return;
    for (const re of PAYWALL_PATTERNS) {
      if (re.test(text)) {
        found = true;
        elem.remove();
        return;
      }
    }
  });

  return found;
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
      const host = new URL(absolute).hostname;
      // Skip broken URLs like "https://undefined" (no dot = not a real domain)
      if (!host.includes(".")) {
        elem.removeAttr("href");
        return;
      }
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

  // Resolve any other relative resource URLs so the browser fetches from
  // the original server instead of requesting them through the proxy
  $("link[href]").each((_, el) => {
    const elem = $(el);
    const href = elem.attr("href");
    if (!href) return;
    try {
      elem.attr("href", new URL(href, base).href);
    } catch {}
  });

  $("[src]").each((_, el) => {
    const elem = $(el);
    if (elem.is("img")) return; // already handled
    const src = elem.attr("src");
    if (!src || src.startsWith("data:")) return;
    try {
      elem.attr("src", new URL(src, base).href);
    } catch {}
  });

  // SVG <use> references (href or xlink:href)
  $("use").each((_, el) => {
    const elem = $(el);
    for (const attr of ["href", "xlink:href"]) {
      const val = elem.attr(attr);
      if (!val || val.startsWith("#")) continue;
      try {
        elem.attr(attr, new URL(val, base).href);
      } catch {}
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

    // Lobsters: always use fallback (front page and comment threads both)
    if (host === "lobste.rs") {
      return true;
    }

    // Root paths and short section paths are typically listings, not articles
    // e.g. /, /en/, /news/, /tech/
    // But long single-segment paths with digits are usually articles
    // e.g. /tributes-paddy-conaghan-world-swimming-7004700-Apr2026/
    const trimmed = path.replace(/\/$/, "");
    const segments = trimmed.split("/").filter(Boolean);
    if (segments.length === 0) return true;
    if (segments.length === 1) {
      const slug = segments[0];
      return slug.length < 20 && !/\d/.test(slug);
    }

    return false;
  } catch {
    return false;
  }
}
