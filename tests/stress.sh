#!/bin/bash
# Stress test: ramp up concurrent uncached requests

set -eu

URLS=(
  "https://en.wikipedia.org/wiki/Cat"
  "https://en.wikipedia.org/wiki/Dog"
  "https://en.wikipedia.org/wiki/Fish"
  "https://en.wikipedia.org/wiki/Bird"
  "https://en.wikipedia.org/wiki/Horse"
  "https://en.wikipedia.org/wiki/Lion"
  "https://en.wikipedia.org/wiki/Tiger"
  "https://en.wikipedia.org/wiki/Bear"
  "https://en.wikipedia.org/wiki/Wolf"
  "https://en.wikipedia.org/wiki/Fox"
  "https://en.wikipedia.org/wiki/Deer"
  "https://en.wikipedia.org/wiki/Goat"
  "https://en.wikipedia.org/wiki/Sheep"
  "https://en.wikipedia.org/wiki/Cow"
  "https://en.wikipedia.org/wiki/Pig"
  "https://en.wikipedia.org/wiki/Rat"
  "https://en.wikipedia.org/wiki/Frog"
  "https://en.wikipedia.org/wiki/Ant"
  "https://en.wikipedia.org/wiki/Bee"
  "https://en.wikipedia.org/wiki/Fly"
  "https://en.wikipedia.org/wiki/Eel"
  "https://en.wikipedia.org/wiki/Owl"
  "https://en.wikipedia.org/wiki/Emu"
  "https://en.wikipedia.org/wiki/Yak"
  "https://en.wikipedia.org/wiki/Cod"
  "https://en.wikipedia.org/wiki/Ram"
  "https://en.wikipedia.org/wiki/Elk"
  "https://en.wikipedia.org/wiki/Jay"
  "https://en.wikipedia.org/wiki/Ape"
  "https://en.wikipedia.org/wiki/Gnu"
  "https://en.wikipedia.org/wiki/Hen"
  "https://en.wikipedia.org/wiki/Koi"
  "https://en.wikipedia.org/wiki/Pug"
  "https://en.wikipedia.org/wiki/Cob"
  "https://en.wikipedia.org/wiki/Dab"
)

COOKIE="chop_id=stress-test-user"
RESULTS="$(mktemp)"
trap "rm -f $RESULTS" EXIT

echo "Clearing cached pages"
redis-cli KEYS "chop:*" | xargs redis-cli DEL 2>/dev/null
echo ""

echo "Starting stress test: ${#URLS[@]} URLs"
echo "---"

BATCH=0
for i in "${!URLS[@]}"; do
  url="${URLS[$i]}"
  (
    start=$(date +%s%3N)
    code=$(curl -s -o /dev/null -w "%{http_code}" -b "$COOKIE" \
      --max-time 35 "http://localhost:3000/${url}")
    end=$(date +%s%3N)
    elapsed=$(( end - start ))
    echo "REQ $((i+1)): HTTP $code ${elapsed}ms $(basename "$url")"
    echo "$code $elapsed" >> "$RESULTS"
  ) &

  # Ramp: batch of 5, short pause between batches
  if (( (i + 1) % 5 == 0 )); then
    BATCH=$((BATCH + 1))
    echo "--- Batch $BATCH sent (requests $((i-3))-$((i+1))) ---"
    sleep 0.5
  fi
done

echo "--- All requests sent, waiting for completion ---"
wait

echo ""
echo "=== Results ==="
echo ""

# Compute per-code stats: count, avg, p95
awk '
function cause(code) {
  if (code == 200) return "OK - page rendered successfully"
  if (code == 429) return "Rate limited (per-user or per-IP /min exceeded)"
  if (code == 503) return "Server busy (max concurrent renders exceeded)"
  if (code == 504) return "Render timed out (page took too long to render)"
  if (code == 502) return "Render failed (puppeteer/clean error)"
  if (code == 403) return "Domain not whitelisted"
  if (code == "000") return "Connection failed / curl timeout"
  return "Unknown"
}
{
  code = $1; ms = $2
  codes[code]++
  times[code][codes[code]] = ms
  total++
}
END {
  # Sort codes by count descending
  n = 0
  for (c in codes) { sorted[++n] = c }
  # Simple insertion sort by count desc
  for (i = 2; i <= n; i++) {
    key = sorted[i]
    j = i - 1
    while (j >= 1 && codes[sorted[j]] < codes[key]) {
      sorted[j+1] = sorted[j]
      j--
    }
    sorted[j+1] = key
  }

  printf "  %-5s %5s %8s %8s   %s\n", "CODE", "COUNT", "AVG", "P95", "CAUSE"
  printf "  %-5s %5s %8s %8s   %s\n", "----", "-----", "------", "------", "-----"

  for (idx = 1; idx <= n; idx++) {
    c = sorted[idx]
    cnt = codes[c]

    # Compute avg
    sum = 0
    for (i = 1; i <= cnt; i++) sum += times[c][i]
    avg = sum / cnt

    # Sort times for p95
    for (i = 2; i <= cnt; i++) {
      v = times[c][i]
      j = i - 1
      while (j >= 1 && times[c][j] > v) {
        times[c][j+1] = times[c][j]
        j--
      }
      times[c][j+1] = v
    }
    p95_idx = int(cnt * 0.95)
    if (p95_idx < 1) p95_idx = 1
    p95 = times[c][p95_idx]

    printf "  %-5s %5d %7dms %7dms   %s\n", c, cnt, avg, p95, cause(c)
  }

  printf "\n  Total: %d requests\n", total
}
' "$RESULTS"
