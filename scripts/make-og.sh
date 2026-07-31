#!/usr/bin/env bash
# ═════════════════════════════════════════════════════════════
# Rebuild public/og.jpg — the 1200×630 social card used by X,
# Discord, Telegram and iMessage previews (see the og: tags in
# index.html; bump the ?v= there whenever this is re-run).
#
# Composition: the community paddy art shifted right so Ronke
# stands in the right third, a feathered navy scrim on the left
# for the wordmark, the game's own onigiri sprites falling down
# the middle, and the URL chip. Type is Baloo 2 — the same
# self-hosted face the title screen uses.
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

# ── Backdrop: blurred cover plate + the scene pushed right ──
magick public/ronke/paddy.webp -resize 1200x630^ -gravity center -extent 1200x630 -blur 0x18 "$TMP/fill.png"
magick public/ronke/paddy.webp -filter Lanczos -resize 1500x -crop 1500x630+0+90 +repage "$TMP/scene.png"
# Feather the scene's left edge so it melts into the blurred plate.
magick "$TMP/scene.png" -alpha set \
  \( -size 1500x630 xc:black -fill white -draw 'rectangle 120,0 1499,629' \
     \( -size 120x630 gradient:black-white \) -geometry +0+0 -composite -blur 0x8 \) \
  -compose CopyOpacity -composite "$TMP/scene-f.png"

# Left scrim: solid to x=180, linear fade to nothing by x=900.
# (Built as a real alpha ramp via CopyOpacity — rgba gradients
# tail off non-linearly and leave a visible step.)
magick \( -size 630x180 xc:white -rotate 90 \) \
       \( -size 630x720 gradient:black-white -rotate 90 \) \
       \( -size 300x630 xc:black \) +append +repage "$TMP/mask.png"
magick -size 1200x630 xc:'rgb(7,18,35)' "$TMP/mask.png" -alpha off \
  -compose CopyOpacity -composite -channel A -evaluate multiply 0.96 +channel "$TMP/scrim.png"
magick -size 1200x630 gradient:'rgba(11,31,56,0.42)-rgba(11,31,56,0.10)' "$TMP/vign.png"

magick "$TMP/fill.png" "$TMP/scene-f.png" -geometry +170+0 -composite \
  "$TMP/vign.png" -composite "$TMP/scrim.png" -composite "$TMP/bg.png"

# ── Onigiri sprites — same geometry as src/riceballs.ts ──
onigiri() { # $1 out  $2 fill  $3 outline
  magick -size 140x140 xc:none -strokewidth 7 -stroke "$3" -fill "$2" \
    -draw "stroke-linejoin round path 'M 47.6,34.2 Q 70,5 92.4,34.2 L 130.5,92.4 Q 137.2,114.8 112.6,114.8 L 27.4,114.8 Q 2.8,114.8 9.5,92.4 Z'" \
    -stroke none -fill 'rgba(255,255,255,0.45)' -draw "ellipse 50,42 14,8 0,360" \
    -stroke "$3" -strokewidth 5 -fill '#173318' -draw "rectangle 46.2,72.8 93.8,114.8" \
    -stroke none -fill 'rgba(255,255,255,0.14)' -draw "rectangle 53,78 60,110" \
    "$1"
}
onigiri "$TMP/rice.png" '#ffffff' '#1c1c1c'
onigiri "$TMP/gold.png" '#ffd94a' '#5a3a00'
magick "$TMP/rice.png" -background none -rotate -13 -resize 118x118 "$TMP/rice-r.png"
magick "$TMP/gold.png" -background none -rotate 11 -resize 92x92 "$TMP/gold-r.png"

# ── Wordmark, tagline, URL chip ──
magick "$TMP/bg.png" -font "$F" \
  -fill 'rgba(125,255,160,0.95)' -pointsize 25 -kerning 3.4 -annotate +66+128 'MOUTH-CONTROLLED ARCADE' \
  -kerning 0 \
  -fill 'rgba(0,0,0,0.55)' -pointsize 104 -annotate +66+248 'RONKE' \
  -fill '#25577f'          -pointsize 104 -annotate +66+242 'RONKE' \
  -fill '#ffffff'          -pointsize 104 -annotate +66+236 'RONKE' \
  -kerning 4 \
  -fill 'rgba(0,0,0,0.55)' -pointsize 76 -annotate +66+330 'RICE RUSH' \
  -fill '#8a5a00'          -pointsize 76 -annotate +66+324 'RICE RUSH' \
  -fill '#ffd94a'          -pointsize 76 -annotate +66+318 'RICE RUSH' \
  -kerning 0 -fill 'rgba(245,236,216,0.95)' -pointsize 30 \
  -annotate +68+392 'open wide. eat the rice.' \
  -annotate +68+430 'dodge the rugs. ronke provides.' \
  \( "$TMP/rice-r.png" \) -geometry +506+82 -composite \
  \( "$TMP/gold-r.png" \) -geometry +596+392 -composite \
  -fill 'rgba(61,125,200,0.30)' -stroke 'rgba(61,125,200,0.85)' -strokewidth 3 \
  -draw 'roundrectangle 66,486 442,546 16,16' \
  -stroke none -pointsize 28 -fill '#f5ecd8' -annotate +92+527 'ronke-rice-rush.vercel.app' \
  -quality 90 -sampling-factor 4:4:4 -strip "$OUT"

echo "wrote $OUT ($(identify -format '%wx%h, %b' "$OUT"))"
