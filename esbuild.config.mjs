import esbuild from 'esbuild';
import process from 'process';

const prod = process.argv[2] === 'production';

const options = {
    entryPoints: ['main.ts'],
    bundle: true,
    external: ['obsidian'],
    format: 'cjs',
    target: 'es6',
    outfile: 'main.js',
    sourcemap: prod ? false : 'inline',
    minify: prod,
    platform: 'node' // Добавляем поддержку Node.js
};

if (prod) {
    esbuild.build(options).catch(() => process.exit(1));
} else {
    esbuild.context(options).then(ctx => ctx.watch()).catch(() => process.exit(1));
}