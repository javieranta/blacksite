import { defineConfig } from 'vite';

export default defineConfig({
  // Relative base so the build works from any path — GitHub Pages serves this
  // from /<repo>/, not from the domain root.
  base: './',
  server: { port: 5180, host: '127.0.0.1' },
  // A stray postcss.config.js in the user's home dir gets picked up by Vite's
  // upward config search. Pin an empty config so it stops walking.
  css: { postcss: {} },
  // Sourcemaps are 7MB and quadruple the Pages payload; enable locally if debugging.
  build: { target: 'es2022', sourcemap: false },
  // Big GLSL strings + heavy math modules; keep esbuild from choking on them.
  esbuild: { target: 'es2022' },
});
