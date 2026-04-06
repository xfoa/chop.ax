#!/usr/bin/env bash
set -eu

# Content quality test: crawl domains 3 levels deep, test rendered output
BASE="http://localhost:3000"
COOKIE="chop_id=content-test-runner"
TIMEOUT=60
TMPDIR_BASE=$(mktemp -d)
LINKS_FILE="$TMPDIR_BASE/links"
ISSUES_FILE="$TMPDIR_BASE/issues"
touch "$ISSUES_FILE"

# Crawl settings
CRAWL_DEPTH=3
LINKS_PER_LEVEL=3       # follow this many links per level
MAX_PER_DOMAIN=5         # total URLs to test per domain

EXCLUDE_EXTENSIONS='\.(css|js|png|jpg|jpeg|gif|svg|ico|woff|woff2|xml|json|rss|atom|pdf|mp3|mp4|ogg|webm|zip|tar|gz)'
EXCLUDE_PATHS='(login|signup|subscribe|account|auth|privacy|terms|cookie|#|mailto:|/rss|/feed|/atom|UserLogin|RecentChanges|action=edit)'
EXCLUDE_DOMAINS='(facebook\.com|twitter\.com|instagram\.com|bsky\.app|google\.com|youtube\.com|linkedin\.com|tiktok\.com)'
EXCLUDE_SUBDOMAINS='(assets\.nhs\.uk|classes\.kingarthurbaking\.com|help\.npr\.org|redcrossblood\.org|shopnpr\.org|cdn[0-9]*\.i-scmp\.com|img\.i-scmp\.com|assets[^.]*\.i-scmp\.com|apigw\.scmp\.com|ad-tech\.scmp\.com|assets\.cdn\.ifixit\.com|forums\.adafruit\.com|commons\.dw\.com|stackoverflow\.co|stackoverflowteams\.com|cdn\.who\.int|uie\.data\.cbc\.ca)'

# Extract same-domain links from an HTML page
extract_links() {
  local domain="$1"
  local url="$2"
  curl -sL --connect-timeout 10 --max-time 15 \
    -H "User-Agent: Mozilla/5.0 (compatible; chop.ax/0.1)" \
    "$url" 2>/dev/null \
    | grep -oP 'href="(https?://[^"]*'"$domain"'[^"]*)"' \
    | sed 's/href="//;s/"$//' \
    | sed 's/&amp;/\&/g' \
    | grep -vE "$EXCLUDE_EXTENSIONS" \
    | grep -vE "$EXCLUDE_PATHS" \
    | grep -vE "$EXCLUDE_DOMAINS" \
    | grep -vE "$EXCLUDE_SUBDOMAINS" \
    | sort -u
}

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
  "typescriptlang.org"
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
  "sparkfun.com"
)

echo "=== Phase 1: Crawling domains (depth $CRAWL_DEPTH, max $MAX_PER_DOMAIN per domain) ==="
for domain in "${domains[@]}"; do
  echo -n "  $domain "

  # Track all seen URLs for this domain (dedup across levels)
  seen_file="$TMPDIR_BASE/seen_${domain//[^a-zA-Z0-9]/_}"
  candidates_file="$TMPDIR_BASE/cand_${domain//[^a-zA-Z0-9]/_}"
  touch "$seen_file" "$candidates_file"

  # Seed: homepage
  frontier=("https://$domain/")
  echo "https://$domain/" >> "$seen_file"

  for level in $(seq 1 "$CRAWL_DEPTH"); do
    next_frontier=()
    for seed_url in "${frontier[@]}"; do
      # Extract links from this page
      page_links=$(extract_links "$domain" "$seed_url" || true)
      if [ -z "$page_links" ]; then
        continue
      fi

      while IFS= read -r link; do
        # Skip if already seen
        if grep -qxF "$link" "$seen_file" 2>/dev/null; then
          continue
        fi
        echo "$link" >> "$seen_file"
        echo "$link" >> "$candidates_file"
        next_frontier+=("$link")
      done <<< "$page_links"
    done

    # Limit frontier width for next level to avoid explosion
    if [ "${#next_frontier[@]}" -gt "$LINKS_PER_LEVEL" ]; then
      # Shuffle and pick LINKS_PER_LEVEL
      frontier=()
      while IFS= read -r line; do
        frontier+=("$line")
      done < <(printf '%s\n' "${next_frontier[@]}" | shuf | head -"$LINKS_PER_LEVEL")
    else
      frontier=("${next_frontier[@]+"${next_frontier[@]}"}")
    fi

    echo -n "."

    # Stop crawling if we have enough candidates
    cand_count=$(wc -l < "$candidates_file" | tr -d ' ')
    if [ "$cand_count" -ge "$MAX_PER_DOMAIN" ]; then
      break
    fi

    # Stop if frontier is empty
    if [ "${#frontier[@]}" -eq 0 ]; then
      break
    fi
  done

  # Pick up to MAX_PER_DOMAIN from candidates (shuffled for variety)
  selected=$(shuf "$candidates_file" 2>/dev/null | head -"$MAX_PER_DOMAIN")
  count=$(echo "$selected" | grep -c 'http' || true)

  if [ "$count" -gt 0 ]; then
    echo "$selected" >> "$LINKS_FILE"
  else
    # Fallback: just test the homepage
    echo "https://$domain/" >> "$LINKS_FILE"
    count=1
  fi

  echo " $count URLs"
done

total=$(wc -l < "$LINKS_FILE")
echo ""
echo "=== Phase 2: Content quality checks on $total URLs ==="
echo ""

pass=0
warn=0
fail=0
idx=0

check_content() {
  local url="$1"
  local html_file="$2"
  local issues=""

  # Strip style blocks and HTML tags to get visible text
  local text
  text=$(sed '/<style/,/<\/style>/d' "$html_file" | sed 's/<[^>]*>//g' | sed '/^[[:space:]]*$/d')
  local word_count
  word_count=$(echo "$text" | wc -w | tr -d ' ')

  # Check 1: Has the chop-footer (cleaning pipeline completed)
  if ! grep -q 'chop-footer' "$html_file"; then
    issues="${issues}NO_FOOTER "
  fi

  # Check 2: Has a <title> with content
  local title
  title=$(grep -oP '<title>\K[^<]+' "$html_file" | head -1 || true)
  if [ -z "$title" ]; then
    issues="${issues}NO_TITLE "
  fi

  # Check 3: Word count -- articles should have substantial text
  if [ "$word_count" -lt 50 ]; then
    issues="${issues}LOW_WORDS(${word_count}) "
  fi

  # Check 4: No leftover <script> tags
  local script_count
  script_count=$(grep -c '<script' "$html_file" || true)
  if [ "$script_count" -gt 0 ]; then
    issues="${issues}HAS_SCRIPTS(${script_count}) "
  fi

  # Check 5: No broken proxy links (href="/https://build/..." or similar)
  local broken_links
  broken_links=$(grep -oP 'href="/https?://[^"]*"' "$html_file" \
    | grep -oP '://[^/"]+' \
    | grep -v '\.' \
    | head -5 || true)
  if [ -n "$broken_links" ]; then
    issues="${issues}BROKEN_LINKS "
  fi

  # Check 6: No inline event handlers (onclick, onload, etc.)
  local handlers
  handlers=$(grep -ciE ' on(click|load|error|mouseover|submit|change)=' "$html_file" || true)
  if [ "$handlers" -gt 0 ]; then
    issues="${issues}EVENT_HANDLERS(${handlers}) "
  fi

  # Check 7: No <iframe> tags
  if grep -qi '<iframe' "$html_file"; then
    issues="${issues}HAS_IFRAMES "
  fi

  # Check 8: No <video> tags
  if grep -qi '<video' "$html_file"; then
    issues="${issues}HAS_VIDEO "
  fi

  # Check 9: No @font-face rules (should be stripped)
  if grep -qi '@font-face' "$html_file"; then
    issues="${issues}HAS_FONTFACE "
  fi

  # Check 10: <a> links should be proxied (href="/https://..." prefix)
  # Only count <a> tags, not <link> or <use> which intentionally resolve to origin
  local unproxied
  unproxied=$(grep -oP '<a [^>]*href="https?://[^"]*"' "$html_file" \
    | grep -v 'chop\.ax' \
    | grep -v 'ko-fi\.com' \
    | grep -v 'chop-footer' \
    | wc -l || true)
  if [ "$unproxied" -gt 3 ]; then
    issues="${issues}UNPROXIED_LINKS(${unproxied}) "
  fi

  # Check 11: Detect form/widget pages with no readable content
  # Pages where form elements dominate and there's very little readable text
  local form_elements
  form_elements=$(grep -ciE '<(input|button|select|textarea)' "$html_file" || true)
  form_elements=${form_elements:-0}
  if [ "$form_elements" -gt 2 ] && [ "$word_count" -lt 100 ]; then
    issues="${issues}FORM_ONLY(words=${word_count},forms=${form_elements}) "
  fi

  echo "$issues"
}

printf "%-55s %6s %6s %s\n" "URL" "WORDS" "SIZE" "ISSUES"
printf "%-55s %6s %6s %s\n" "---" "-----" "----" "------"

while IFS= read -r url; do
  idx=$((idx + 1))
  display=$(echo "$url" | cut -c1-55)
  html_file="$TMPDIR_BASE/page_${idx}.html"

  # Fetch through proxy, saving body
  http_code=$(curl -s -o "$html_file" \
    -w "%{http_code}" \
    --connect-timeout 10 \
    --max-time "$TIMEOUT" \
    -b "$COOKIE" \
    "$BASE/$url" 2>/dev/null) || http_code="000"

  if [ "$http_code" != "200" ]; then
    printf "%-55s %6s %6s %s\n" "$display" "-" "-" "HTTP_${http_code}"
    echo "$url HTTP_${http_code}" >> "$ISSUES_FILE"
    fail=$((fail + 1))
    sleep 0.3
    continue
  fi

  size=$(wc -c < "$html_file" | tr -d ' ')
  text=$(sed '/<style/,/<\/style>/d' "$html_file" | sed 's/<[^>]*>//g' | sed '/^[[:space:]]*$/d')
  words=$(echo "$text" | wc -w | tr -d ' ')

  issues=$(check_content "$url" "$html_file")

  if [ -z "$issues" ]; then
    printf "%-55s %6s %6s %s\n" "$display" "$words" "$size" "OK"
    pass=$((pass + 1))
  elif echo "$issues" | grep -qE 'NO_FOOTER|BROKEN_LINKS|HAS_SCRIPTS|HAS_IFRAMES|FORM_ONLY'; then
    printf "%-55s %6s %6s %s\n" "$display" "$words" "$size" "FAIL: $issues"
    echo "$url $issues" >> "$ISSUES_FILE"
    fail=$((fail + 1))
  else
    printf "%-55s %6s %6s %s\n" "$display" "$words" "$size" "WARN: $issues"
    echo "$url $issues" >> "$ISSUES_FILE"
    warn=$((warn + 1))
  fi

  sleep 0.3
done < "$LINKS_FILE"

echo ""
echo "=== Summary ==="
echo "  OK:       $pass"
echo "  Warnings: $warn"
echo "  Failures: $fail"
echo "  Total:    $total"

if [ -s "$ISSUES_FILE" ]; then
  echo ""
  echo "=== Issues ==="
  cat "$ISSUES_FILE"
fi

rm -rf "$TMPDIR_BASE"
