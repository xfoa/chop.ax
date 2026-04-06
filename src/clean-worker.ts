// Worker thread for CPU-bound HTML cleaning
import { cleanHtml } from "./clean";

declare var self: Worker;

self.onmessage = async (e: MessageEvent) => {
  const { html, css, sourceUrl, galleryPreviews, client } = e.data;
  try {
    const result = await cleanHtml(html, css, sourceUrl, galleryPreviews, client);
    self.postMessage({ result });
  } catch (err) {
    self.postMessage({ error: String(err) });
  }
};
