import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: {
      main: 'src/main.ts',
      preload: 'src/preload.ts',
      'picker-preload': 'src/picker-preload.ts',
    },
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    outDir: 'dist',
    clean: true,
    splitting: false,
    sourcemap: false,
    external: ['electron'],
    noExternal: ['electron-updater'],
  },
  {
    entry: { 'picker-renderer': 'src/picker-renderer.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'chrome140',
    outDir: 'renderer-dist',
    clean: true,
    splitting: false,
    minify: true,
  },
]);
