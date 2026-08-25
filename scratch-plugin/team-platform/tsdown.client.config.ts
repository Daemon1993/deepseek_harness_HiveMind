import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-team-platform'

const sharedModules = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-runtime/client',
])

export default defineConfig({
  name: `${PLUGIN_ID}/client`,
  entry: {
    client: 'src/client/index.ts',
  },
  outDir: 'lib',
  format: ['cjs'],
  platform: 'browser',
  target: 'es2024',
  dts: false,
  clean: false,
  sourcemap: true,
  deps: {
    neverBundle: specifier => sharedModules.has(specifier),
    alwaysBundle: specifier => !sharedModules.has(specifier),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner:
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro:
      'var module = { exports: {} }; var exports = module.exports;',
    footer:
      'return module.exports; } });',
  },
})