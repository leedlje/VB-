import { build, context } from 'esbuild';
import { build as buildRenderer, createServer } from 'vite';

const watch = process.argv.includes('--watch');
const jobs = [
  { entryPoints: ['src/main/index.ts'], outfile: 'dist/main.cjs', platform: 'node', format: 'cjs', packages: 'external' },
  { entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload.cjs', platform: 'node', format: 'cjs', packages: 'external' },
];

if (watch) {
  const contexts = await Promise.all(jobs.map((job) => context({ ...job, bundle: true, sourcemap: true })));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  const server = await createServer({ root: 'src/renderer', server: { port: 5173 } });
  await server.listen();
  const { spawn } = await import('node:child_process');
  const electron = spawn('node_modules/.bin/electron.cmd', ['.'], { shell: true, stdio: 'inherit', env: { ...process.env, READER_DEV_URL: 'http://localhost:5173' } });
  electron.on('exit', async () => { await server.close(); await Promise.all(contexts.map((ctx) => ctx.dispose())); process.exit(); });
} else {
  await Promise.all(jobs.map((job) => build({ ...job, bundle: true, minify: false })));
  await buildRenderer({ root: 'src/renderer', base: './', build: { outDir: '../../dist/renderer', emptyOutDir: true } });
}
