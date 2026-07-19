import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'es2022',
    // TF.js + MediaPipe are heavy; silence the default 500kB warning —
    // the models in /public dwarf the JS bundle anyway.
    chunkSizeWarningLimit: 2000,
  },
});
