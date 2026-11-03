import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'cli/bin': 'src/cli/bin.ts',
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts' } },
  clean: true,
  sourcemap: true,
  splitting: true,
});
