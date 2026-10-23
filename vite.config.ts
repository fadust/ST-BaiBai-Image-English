import vue from '@vitejs/plugin-vue';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vite';

// The browser loads from /scripts/extensions/third-party/ST-BaiBai-Image/dist/index.js,
// so importing host ST modules needs the relative path from dist/ back to ST's public/ root.
// `@sillytavern/scripts/xxx` -> `../../../../../scripts/xxx.js`, marked as external,
// so ST's own code is not bundled into ours; at runtime the browser follows the relative path.
const relative_sillytavern_path = '../../../../../';

// Third-party libraries ST already mounts globally map to globals to avoid bundling them twice.
const globals: Record<string, string> = {
  jquery: '$',
  lodash: '_',
  toastr: 'toastr',
};

const package_json = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8')) as {
  version?: string;
};
const package_version = String(package_json.version ?? '');

export default defineConfig(({ mode }) => ({
  define: {
    __BBI_VERSION__: JSON.stringify(package_version),
  },

  plugins: [
    vue(),
    {
      name: 'sillytavern-resolver',
      enforce: 'pre',
      resolveId(id) {
        if (id.startsWith('@sillytavern/')) {
          return {
            id:
              path
                .join(relative_sillytavern_path, id.replace('@sillytavern/', ''))
                .replaceAll('\\', '/') + '.js',
            external: true,
          };
        }
        if (id in globals) {
          return { id, external: true };
        }
      },
    },
  ],

  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },

  build: {
    rollupOptions: {
      input: 'src/index.ts',
      output: {
        format: 'es',
        entryFileNames: '[name].js',
        chunkFileNames: '[name].[hash].chunk.js',
        assetFileNames: '[name].[ext]',
        globals,
      },
      external: id => id in globals,
    },
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: mode === 'production' ? true : 'inline',
    minify: mode === 'production',
    target: 'esnext',
  },
}));
