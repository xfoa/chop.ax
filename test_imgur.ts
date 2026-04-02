import { renderPage } from "./src/browser";

const { html } = await renderPage("https://imgur.com/a/do3P3jn");

const known = ["51tUHVY", "n5LJnrE", "7mwQrc6", "gxy41AK", "Ev5peR2", "jNKj5cg"];
for (const id of known) {
  const count = (html.match(new RegExp(id, "g")) || []).length;
  console.log(`${id}: ${count > 0 ? "FOUND (" + count + ")" : "MISSING"}`);
}

process.exit(0);
