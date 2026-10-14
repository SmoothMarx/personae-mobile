# Personae logo kit - F1 original

Master artwork: `../ideas-david-turn/f1-face-blue-bright-onbg.png` (F1, 1024x1024, `#1181F3` on `#0B0F14`).
All files here are resampled from that master with Lanczos - never upscaled beyond its 1024 native.

## What to use where

| File | Use |
|---|---|
| `logo/personae-f1-logo-2048.png` | print / large, upsized master (2x) |
| `logo/personae-f1-logo-1024.png` | the master, pixel-identical framing |
| `logo/personae-f1-logo-512.png` | web hero, decks |
| `icon/personae-f1-icon-1024.png` | iOS App Store icon |
| `icon/personae-f1-icon-512.png` | Android / Play Store icon |
| `icon/personae-f1-icon-256.png` `192` | PWA / Windows tile |
| `icon/personae-f1-icon-180.png` | Apple touch icon (iOS home screen) |
| `icon/personae-f1-icon-152` `144` `120` `96` `76` `60` `64` `48` `32` `16` | legacy iOS / Android densities (mdpi..xxxhdpi), Windows, macOS |
| `favicon/favicon.ico` | multi-res ico (64/48/32/16) - full bust |
| `favicon/favicon-tight.ico` | multi-res ico, tight face crop - better at 16 px |
| `favicon/favicon-16.png` `favicon-32.png` | browser tab PNGs |
| `favicon/apple-touch-icon.png` `apple-touch-icon-tight.png` | 180 px iOS |
| `favicon/personae-f1-tight-*.png` | tight face crop, 16-512 px, for the very small slots |
| `transparent/personae-f1-logo-transparent-*.png` | background keyed out (2048/1024/512/256), for light surfaces |
| `transparent/personae-f1-icon-transparent-*.png` | keyed icon, 512/192 |

Two framings: `logo/` keeps F1's exact original framing; `icon/` re-centres the mark with 6% breathing space;
`favicon/personae-f1-tight-*` crops to the mark so the face fills the frame.

Small-size caveat: at 16 px the full bust turns to mush - that is inherent to a detailed line drawing, not a
resampling fault. Use the tight crop (`favicon-tight.ico`) below 48 px.

Regenerate: `~/.hermes/venv/bin/python ~/.hermes/cache/scratch/kit.py` then `kit3.py`.
