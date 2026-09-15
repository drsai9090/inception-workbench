import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';

await mkdir('dist/assets', { recursive: true });
await build({ entryPoints: ['src/client/main.tsx'], bundle: true, outfile: 'dist/assets/app.js', minify: true, sourcemap: false, target: ['es2023'], define: { 'process.env.NODE_ENV': '"production"' }, jsx: 'automatic' });
await copyFile('index.html', 'dist/index.html');
await cp('samples', 'dist/samples', { recursive: true });
console.log('Built React client and synthetic samples in dist/.');
