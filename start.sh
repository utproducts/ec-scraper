#!/bin/sh
# Copy cookies to persistent disk if not already there
if [ ! -f /app/gc-browser-data/Default/Cookies ]; then
  echo "📋 Copying session cookies to persistent disk..."
  cp -r /app/gc-browser-data-seed/* /app/gc-browser-data/ 2>/dev/null || true
  echo "✅ Cookies copied"
else
  echo "✅ Session cookies already on disk"
fi

exec node ec-scraper-service.mjs
