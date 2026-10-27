import { build } from 'esbuild';

const result = await build({
  entryPoints: [new URL('./surface-placement.test.ts', import.meta.url).pathname],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  write: false,
  logLevel: 'silent',
});

const source = Buffer.from(result.outputFiles[0].contents).toString('base64');
await import(`data:text/javascript;base64,${source}`);
