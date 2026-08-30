import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { login: 'src/login/main.tsx' },
  outDir: 'lib',
  format: ['iife'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  outputOptions: { entryFileNames: 'login.js' },
  deps: { alwaysBundle: () => true },
})
