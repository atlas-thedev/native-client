# Nether home background

Source of the animated home-screen background (`src/assets/backgrounds/nether-loop.webm`).
A procedural 2D pixel-art Nether drawn on a canvas inside a Remotion composition; every
frame is a function of `t = frame / 600`, so the 20 s clip loops seamlessly.

```sh
npm i remotion @remotion/cli react react-dom
npx remotion still src/index.tsx Nether still.png --frame=0
npx remotion render src/index.tsx Nether nether.webm --codec=vp9 --crf=34
ffmpeg -i nether.webm -c:v libvpx-vp9 -crf 42 -b:v 0 -row-mt 1 -an nether-loop.webm
```

The launcher repo ships the result as base64 packs in `asset-packs/` (restored by `vite.config.js`).
