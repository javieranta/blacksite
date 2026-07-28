import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, host: '127.0.0.1' },
  // A stray postcss.config.js in the user's home dir gets picked up by Vite's
  // upward config search. Pin an empty config so it stops walking.
  css: { postcss: {} },
  build: { target: 'es2022', sourcemap: true },
  // Big GLSL strings + heavy math modules; keep esbuild from choking on them.
  esbuild: { target: 'es2022' },
});
