const ALLOWED_BY_CATEGORY: Record<string, string[]> = {
  "News": [
    "abc.net.au",
    "aljazeera.com",
    "apnews.com",
    "arstechnica.com",
    "bbc.co.uk",
    "bbc.com",
    "cbc.ca",
    "cnn.com",
    "dw.com",
    "elpais.com",
    "france24.com",
    "japantimes.co.jp",
    "lemonde.fr",
    "mirror.co.uk",
    "mtvuutiset.fi",
    "npr.org",
    "nytimes.com",
    "propublica.org",
    "reuters.com",
    "rnz.co.nz",
    "rte.ie",
    "scmp.com",
    "spiegel.de",
    "theatlantic.com",
    "theguardian.com",
    "theintercept.com",
    "thejournal.ie",
    "thelocal.com",
    "timesofindia.indiatimes.com",
    "washingtonpost.com",
    "yle.fi",
  ],
  "Tech": [
    "lobste.rs",
    "lwn.net",
    "news.ycombinator.com",
    "phoronix.com",
    "tomshardware.com",
  ],
  "Reference": [
    "stackexchange.com",
    "stackoverflow.blog",
    "stackoverflow.com",
    "wikipedia.org",
    "wikimedia.org",
    "wiktionary.org",
  ],
  "Programming docs": [
    "cppreference.com",
    "developer.mozilla.org",
    "doc.rust-lang.org",
    "docs.oracle.com",
    "docs.python.org",
    "learn.microsoft.com",
    "typescriptlang.org",
  ],
  "Health": [
    "cdc.gov",
    "clevelandclinic.org",
    "mayoclinic.org",
    "medlineplus.gov",
    "nhs.uk",
    "nih.gov",
    "nutritionfacts.org",
    "webmd.com",
    "who.int",
  ],
  "Preparedness": [
    "getprepared.gc.ca",
    "ready.gov",
    "redcross.org",
  ],
  "Government": [
    "bund.de",
    "canada.ca",
    "finland.fi",
    "gobierno.es",
    "gov.au",
    "gov.ie",
    "gov.uk",
    "governo.it",
    "government.nl",
    "govt.nz",
    "norway.no",
    "regeringen.dk",
    "service-public.fr",
    "sweden.se",
    "usa.gov",
  ],
  "Repair": [
    "ifixit.com",
  ],
  "Recipes": [
    "allrecipes.com",
    "budgetbytes.com",
    "kingarthurbaking.com",
    "seriouseats.com",
    "simplyrecipes.com",
  ],
  "Gardening / Farming": [
    "almanac.com",
    "extension.org",
    "gardeningknowhow.com",
    "rhs.org.uk",
  ],
  "Electronics": [
    "adafruit.com",
    "hackaday.com",
    "sparkfun.com",
  ],
  "Social": [
    "imgur.com",
    "redd.it",
    "reddit.com",
  ],
};

const ALL_DOMAINS = Object.values(ALLOWED_BY_CATEGORY).flat();

export function isAllowed(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    return ALL_DOMAINS.some(
      (d) => hostname === d || hostname.endsWith("." + d)
    );
  } catch {
    return false;
  }
}

export function getAllowedDomains(): string[] {
  return [...ALL_DOMAINS];
}

export function getAllowedDomainsHtml(): string {
  return Object.entries(ALLOWED_BY_CATEGORY)
    .map(([cat, domains]) => {
      const items = domains.map((d) => `<li><a href="/https://${d}">${d}</a></li>`).join("");
      return `<h4>${cat}</h4><ul>${items}</ul>`;
    })
    .join("");
}
