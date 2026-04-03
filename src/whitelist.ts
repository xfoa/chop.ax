const ALLOWED_DOMAINS: string[] = [
  // News
  "reuters.com",
  "apnews.com",
  "bbc.com",
  "bbc.co.uk",
  "npr.org",
  "theguardian.com",
  "nytimes.com",
  "washingtonpost.com",
  "arstechnica.com",
  "theatlantic.com",
  "mirror.co.uk",
  "yle.fi",
  "cnn.com",
  // Tech
  "news.ycombinator.com",
  "lobste.rs",
  "lwn.net",
  "phoronix.com",
  "tomshardware.com",
  // Reference
  "wikipedia.org",
  "stackoverflow.com",
  // Social
  "reddit.com",
  "redd.it",
  "imgur.com",
];

export function isAllowed(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return ALLOWED_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    );
  } catch {
    return false;
  }
}

export function getAllowedDomains(): string[] {
  return [...ALLOWED_DOMAINS];
}
