#!/usr/bin/env bash
set -eu

# Test script: crawl each whitelisted domain, find article links, test rendering
BASE="http://localhost:3000"
COOKIE="chop_id=domain-test-runner"
RESULTS_FILE=$(mktemp)
LINKS_FILE=$(mktemp)

# Minimum content length (bytes) to consider a render successful
MIN_CONTENT=500

# Timeout per request
TIMEOUT=30

domains=(
  # News
  "abc.net.au"
  "aljazeera.com"
  "apnews.com"
  "arstechnica.com"
  "bbc.com"
  "cbc.ca"
  "cnn.com"
  "dw.com"
  "elpais.com"
  "france24.com"
  "japantimes.co.jp"
  "lemonde.fr"
  "mirror.co.uk"
  "npr.org"
  "nytimes.com"
  "propublica.org"
  "reuters.com"
  "rnz.co.nz"
  "scmp.com"
  "spiegel.de"
  "theatlantic.com"
  "theguardian.com"
  "theintercept.com"
  "thejournal.ie"
  "thelocal.com"
  "washingtonpost.com"
  # Tech
  "lobste.rs"
  "lwn.net"
  "news.ycombinator.com"
  "phoronix.com"
  "tomshardware.com"
  # Reference
  "stackoverflow.com"
  "wikipedia.org"
  # Programming docs
  "cppreference.com"
  "developer.mozilla.org"
  "doc.rust-lang.org"
  "docs.python.org"
  "learn.microsoft.com"
  "man7.org"
  "pkg.go.dev"
  # Health
  "cdc.gov"
  "clevelandclinic.org"
  "mayoclinic.org"
  "medlineplus.gov"
  "nhs.uk"
  "nutritionfacts.org"
  "webmd.com"
  "who.int"
  # Preparedness
  "ready.gov"
  "redcross.org"
  # Government
  "usa.gov"
  # Repair
  "ifixit.com"
  # Recipes
  "allrecipes.com"
  "budgetbytes.com"
  "kingarthurbaking.com"
  "seriouseats.com"
  "simplyrecipes.com"
  # Gardening
  "almanac.com"
  "gardeningknowhow.com"
  # Electronics
  "adafruit.com"
  "hackaday.com"
  "instructables.com"
  "sparkfun.com"
  # Social (skip reddit/imgur - need puppeteer, slow)
)

# Step 1: For each domain, fetch homepage and extract up to 5 article-like links
echo "=== Phase 1: Crawling domains for article links ==="
for domain in "${domains[@]}"; do
  echo -n "  $domain ... "

  # Fetch the homepage directly and extract links
  links=$(curl -sL --connect-timeout 10 --max-time 15 \
    -H "User-Agent: Mozilla/5.0 (compatible; chop.ax/0.1)" \
    "https://$domain/" 2>/dev/null \
    | grep -oP 'href="(https?://[^"]*'"$domain"'[^"]*)"' \
    | sed 's/href="//;s/"$//' \
    | grep -vE '\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|xml|json|rss|pdf)' \
    | grep -vE '(login|signup|subscribe|account|auth|privacy|terms|cookie|#)' \
    | grep -vE '(facebook\.com|twitter\.com|instagram\.com|bsky\.app|google\.com|youtube\.com|linkedin\.com|tiktok\.com)' \
    | grep -E '/[a-z0-9].*/' \
    | sort -u \
    | head -5)

  count=$(echo "$links" | grep -c 'http' || true)
  echo "$count links found"

  if [ "$count" -gt 0 ]; then
    echo "$links" >> "$LINKS_FILE"
  else
    # Fallback: just test the homepage
    echo "https://$domain/" >> "$LINKS_FILE"
  fi
done

total=$(wc -l < "$LINKS_FILE")
echo ""
echo "=== Phase 2: Testing $total URLs through proxy ==="
echo ""

pass=0
fail=0
error=0
skipped=0

printf "%-60s %6s %8s %s\n" "URL" "STATUS" "SIZE" "RESULT"
printf "%-60s %6s %8s %s\n" "---" "------" "----" "------"

while IFS= read -r url; do
  # Truncate URL for display
  display=$(echo "$url" | cut -c1-60)

  # Request through proxy
  response=$(curl -s -o /dev/null \
    -w "%{http_code} %{size_download}" \
    --connect-timeout 10 \
    --max-time "$TIMEOUT" \
    -b "$COOKIE" \
    "$BASE/$url" 2>/dev/null) || response="000 0"

  code=$(echo "$response" | awk '{print $1}')
  size=$(echo "$response" | awk '{print $2}')

  if [ "$code" = "429" ]; then
    result="RATE_LIMITED"
    skipped=$((skipped + 1))
    # Wait a bit before continuing
    sleep 5
  elif [ "$code" = "200" ] && [ "$size" -gt "$MIN_CONTENT" ]; then
    result="PASS"
    pass=$((pass + 1))
  elif [ "$code" = "200" ]; then
    result="FAIL (too small)"
    fail=$((fail + 1))
  elif [ "$code" = "504" ]; then
    result="TIMEOUT"
    fail=$((fail + 1))
  elif [ "$code" = "000" ]; then
    result="CONN_ERR"
    error=$((error + 1))
  else
    result="FAIL ($code)"
    fail=$((fail + 1))
  fi

  printf "%-60s %6s %8s %s\n" "$display" "$code" "$size" "$result"
  echo "$code $size $url $result" >> "$RESULTS_FILE"

  # Small delay to avoid hammering
  sleep 0.3
done < "$LINKS_FILE"

echo ""
echo "=== Summary ==="
echo "  Pass:         $pass"
echo "  Fail:         $fail"
echo "  Error:        $error"
echo "  Rate limited: $skipped"
echo "  Total:        $total"
echo ""

# Per-domain summary
echo "=== Per-domain breakdown ==="
printf "%-35s %5s %5s %5s\n" "DOMAIN" "PASS" "FAIL" "ERR"
printf "%-35s %5s %5s %5s\n" "------" "----" "----" "---"

for domain in "${domains[@]}"; do
  d_pass=$(grep "$domain" "$RESULTS_FILE" | grep "PASS$" | wc -l || true)
  d_fail=$(grep "$domain" "$RESULTS_FILE" | grep -E "FAIL|TIMEOUT" | wc -l || true)
  d_err=$(grep "$domain" "$RESULTS_FILE" | grep -E "CONN_ERR|RATE_LIMITED" | wc -l || true)
  d_total=$((d_pass + d_fail + d_err))
  if [ "$d_total" -gt 0 ]; then
    printf "%-35s %5s %5s %5s\n" "$domain" "$d_pass" "$d_fail" "$d_err"
  fi
done

rm -f "$RESULTS_FILE" "$LINKS_FILE"
