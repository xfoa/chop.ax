// Worker thread for CPU-bound HTML cleaning
import { cleanHtml, ThinContentError } from "./clean";

declare var self: Worker;

self.onmessage = async (e: MessageEvent) => {
  const { html, css, sourceUrl, galleryPreviews, client } = e.data;
  try {
    const result = await cleanHtml(html, css, sourceUrl, galleryPreviews, client);
    self.postMessage({ result });
  } catch (err) {
    if (err instanceof ThinContentError) {
      self.postMessage({ error: "ThinContentError", result: err.html });
    } else {
      self.postMessage({ error: String(err) });
    }
  }
};
