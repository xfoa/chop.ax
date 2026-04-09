import { Hono } from "hono";
import { handleProxy, banMiddleware, blockMiddleware, RENDER_TIMEOUT } from "./proxy";
import { getAllowedDomainsHtml } from "./whitelist";

const app = new Hono();

// Auto-ban IPs that generate excessive 400s (vuln scanners)
app.use("*", banMiddleware);

// Block unwanted crawlers
app.use("*", blockMiddleware);

// Landing page
app.get("/", (c) => {
  const domains = getAllowedDomainsHtml();

  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>chop.ax</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
           Roboto, Arial, sans-serif; max-width: 600px; margin: 40px auto;
           padding: 0 20px; }
    input[type="text"] { width: 100%; padding: 8px; font-size: 16px;
           box-sizing: border-box; }
    button { padding: 8px 16px; font-size: 16px; margin-top: 8px; }
    h4 { margin: 12px 0 4px; }
    ul { margin: 0 0 8px; padding-left: 20px; }
  </style>
</head>
<body>
  <h1>chop.ax</h1>
  <p>Strip the bloat from web pages. Paste a URL below.
     <a href="/about">More info...</a></p>
  <form action="/go" method="get">
    <input type="text" name="url" placeholder="https://example.com/article" />
    <button type="submit">Chop it</button>
  </form>
  <h3>Allowed domains</h3>
  ${domains}
</body>
</html>`);
});

// Form redirect: /go?url=X -> /X
app.get("/go", (c) => {
  const url = c.req.query("url");
  if (!url) return c.redirect("/");
  return c.redirect("/" + url);
});

// Image proxy for cross-origin thumbnails
app.get("/img/*", async (c) => {
  const imgUrl = c.req.path.slice(5); // strip "/img/"
  if (!imgUrl) return c.text("Missing URL", 400);
  try {
    const resp = await fetch(imgUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; chop.ax/0.1)" },
      redirect: "follow",
    });
    if (!resp.ok) return c.text("Upstream error", resp.status as any);
    return new Response(resp.body, {
      headers: {
        "Content-Type": resp.headers.get("Content-Type") || "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  } catch {
    return c.text("Failed to fetch image", 502);
  }
});

// About page
app.get("/about", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>About - chop.ax</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
           Roboto, Arial, sans-serif; max-width: 600px; margin: 40px auto;
           padding: 0 20px; color: #222; line-height: 1.6; }
    a { color: #06c; }
    h1 { margin-bottom: 0.2em; }
    h1 + p { margin-top: 0; color: #666; }
    .footer { text-align: center; padding: 20px; margin-top: 40px;
              border-top: 1px solid #ccc; font-size: 14px; color: #666; }
  </style>
</head>
<body>
  <h1>chop.ax</h1>
  <p>Strip the bloat from web pages.</p>

  <h2>What's this?</h2>
  <p>chop.ax takes unreasonably large, ad-heavy web pages and returns just the content.
  This can be particularly useful for extermely low-bandwidth connections like dial-up or LoRa.</p>

  <h2>How do I use it?</h2>
  <ol>
    <li>Paste a URL or prepend <code>chop.ax/</code> to any supported URL.</li>
    <li>The server fetches the page, extracts the article content, strips
        scripts, ads, tracking, and unused CSS.</li>
    <li>You get a small, clean, somewhat-readable page.</li>
  </ol>

  <h2>What's removed?</h2>
  <ul>
    <li>JavaScript, tracking pixels, and analytics</li>
    <li>Ads, pop-ups, and cookie banners</li>
    <li>Auto-playing video and audio</li>
    <li>Custom web fonts and unused CSS</li>
    <li>Social media widgets and comment sections</li>
  </ul>

  <h2>Limitations</h2>
  <ul>
    <li>Only <a href="/">whitelisted domains</a> are supported.</li>
    <li>Pages that depend entirely on JavaScript to render may not work, but it will do a best-effort attempt to work around this.</li>
    <li>Interactive features (search, forms, login) are not preserved.</li>
  </ul>

  <h2>Links</h2>
  <ul>
    <li><a href="https://github.com/xfoa/chop.ax">Contribute, report bugs, or host it yourself (GitHub)</a></li>
    <li><a href="https://ko-fi.com/xfoax">Support this project (Ko-fi)</a></li>
  </ul>

  <div class="footer">
    <a href="/">Home</a>
  </div>
</body>
</html>`);
});

// Ignore browser-initiated requests
app.get("/favicon.ico", (c) => c.body(null, 204));
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /"));

// Everything else -> proxy handler
app.get("*", handleProxy);

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
  idleTimeout: RENDER_TIMEOUT + 5,
};
