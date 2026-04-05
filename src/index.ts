import { Hono } from "hono";
import { handleProxy, RENDER_TIMEOUT } from "./proxy";
import { getAllowedDomains } from "./whitelist";

const app = new Hono();

// Landing page
app.get("/", (c) => {
  const domains = getAllowedDomains()
    .map((d) => `<li>${d}</li>`)
    .join("");

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
  </style>
</head>
<body>
  <h1>chop.ax</h1>
  <p>Strip the bloat from web pages. Paste a URL below.</p>
  <form action="/go" method="get">
    <input type="text" name="url" placeholder="https://example.com/article" />
    <button type="submit">Chop it</button>
  </form>
  <h3>Allowed domains</h3>
  <ul>${domains}</ul>
</body>
</html>`);
});

// Form redirect: /go?url=X -> /X
app.get("/go", (c) => {
  const url = c.req.query("url");
  if (!url) return c.redirect("/");
  return c.redirect("/" + url);
});

// Ignore browser-initiated requests
app.get("/favicon.ico", (c) => c.body(null, 204));
app.get("/robots.txt", (c) => c.text("User-agent: *\nDisallow: /"));

// Everything else -> proxy handler
app.get("*", handleProxy);

export default {
  port: Number(process.env.PORT) || 3000,
  fetch: app.fetch,
  idleTimeout: Math.ceil(RENDER_TIMEOUT / 1000) + 5,
};
