#!/bin/sh
set -e
D=$1; mkdir -p "$D"; B=https://essentia.upf.edu/models
get() { curl -fsSL --retry 3 -o "$D/$(basename $1)" "$B/$1"; }
get feature-extractors/discogs-effnet/discogs-effnet-bs64-1.pb
get classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.pb
get classification-heads/genre_discogs400/genre_discogs400-discogs-effnet-1.json
for m in mood_happy mood_sad mood_aggressive mood_relaxed mood_party danceability; do
  get classification-heads/$m/$m-discogs-effnet-1.pb
  get classification-heads/$m/$m-discogs-effnet-1.json
done
ls -la "$D"
