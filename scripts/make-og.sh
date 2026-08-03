#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════
# Rebuild public/og.jpg — the 1200×630 social card used by X,
# Discord, Telegram and iMessage previews (see the og: tags in
# index.html; bump the ?v= there whenever this is re-run).
#
# Composition: the sunset-sea plate, Rugbeard's galleon bearing
# down from the right, Ronke's boat and a keg in the lower middle,
# and a feathered navy scrim on the left for the wordmark. Type is
# Baloo 2 — the same self-hosted face the title screen uses.
#
# Needs: ImageMagick 7 (magick), woff2_decompress.
# ═════════════════════════════════════════════════════════════
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=public/og.jpg
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Baloo 2 ships as woff2; FreeType needs a ttf.
cp public/fonts/baloo2-latin.woff2 "$TMP/"
woff2_decompress "$TMP/baloo2-latin.woff2"
F="$TMP/baloo2-latin.ttf"

# ── Backdrop: the sea illustration, cover-cropped ──
magick public/sea/sea.jpg -resize 1200x630^ -gravity center -extent 1200x630 "$TMP/bg0.png"

# Left scrim: solid to x=180, linear fade to nothing by x=900.
# (Built as a real alpha ramp via CopyOpacity — rgba gradients
# tail off non-linearly and leave a visible step.)
magick \( -size 630x180 xc:white -rotate 90 \) \
       \( -size 630x720 gradient:black-white -rotate 90 \) \
       \( -size 300x630 xc:black \) +append +repage "$TMP/mask.png"
magick -size 1200x630 xc:'rgb(7,18,35)' "$TMP/mask.png" -alpha off \
  -compose CopyOpacity -composite -channel A -evaluate multiply 0.93 +channel "$TMP/scrim.png"
magick -size 1200x630 gradient:'rgba(11,31,56,0.34)-rgba(11,31,56,0.06)' "$TMP/vign.png"

# ── The fleet ──
magick public/sea/boss-galleon.png -filter Lanczos -resize x420 "$TMP/boss.png"
magick public/sea/boat.png -filter Lanczos -resize x210 "$TMP/boat.png"

magick "$TMP/bg0.png" \
  \( "$TMP/boss.png" \) -geometry +830+30 -composite \
  \( "$TMP/boat.png" \) -geometry +690+372 -composite \
  "$TMP/vign.png" -composite "$TMP/scrim.png" -composite "$TMP/bg.png"

# ── Wordmark, tagline, URL chip ──
magick "$TMP/bg.png" -font "$F" \
  -fill 'rgba(125,255,160,0.95)' -pointsize 25 -kerning 3.4 -annotate +66+124 'HEAD-STEERED · MOUTH-FIRED' \
  -kerning 0 \
  -fill 'rgba(0,0,0,0.55)' -pointsize 104 -annotate +66+244 'RONKE' \
  -fill '#25577f'          -pointsize 104 -annotate +66+238 'RONKE' \
  -fill '#ffffff'          -pointsize 104 -annotate +66+232 'RONKE' \
  -kerning 3 \
  -fill 'rgba(0,0,0,0.55)' -pointsize 64 -annotate +66+318 'BOAT BATTLE' \
  -fill '#8a5a00'          -pointsize 64 -annotate +66+312 'BOAT BATTLE' \
  -fill '#ffd94a'          -pointsize 64 -annotate +66+306 'BOAT BATTLE' \
  -kerning 0 -fill 'rgba(245,236,216,0.95)' -pointsize 29 \
  -annotate +68+380 'lean to dodge the barrels.' \
  -annotate +68+418 'tilt to aim. chomp to fire.' \
  -fill 'rgba(61,125,200,0.30)' -stroke 'rgba(61,125,200,0.85)' -strokewidth 3 \
  -draw 'roundrectangle 66,478 442,538 16,16' \
  -stroke none -pointsize 28 -fill '#f5ecd8' -annotate +92+519 'ronke-rice-rush.vercel.app' \
  -quality 90 -sampling-factor 4:4:4 -strip "$OUT"

echo "wrote $OUT ($(identify -format '%wx%h, %b' "$OUT"))"
