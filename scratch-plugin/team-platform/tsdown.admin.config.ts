import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: { admin: 'src/admin/main.tsx' }, outDir: 'lib', format: ['iife'], platform: 'browser', target: 'es2024',
  dts: false, clean: false, sourcemap: true, outputOptions: { entryFileNames: 'admin.js' },
  deps: { alwaysBundle: () => true },
})
