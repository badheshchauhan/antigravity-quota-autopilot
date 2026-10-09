const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

function copyTheme() {
  try {
    fs.mkdirSync('dist/presentation/theme', { recursive: true });
    fs.copyFileSync('src/presentation/theme/global.css', 'dist/presentation/theme/global.css');
    console.log('Copied global.css to dist/presentation/theme/global.css');
  } catch (err) {
    console.error('Failed to copy theme:', err.message);
  }
}

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['./src/extension.ts'],
    bundle: true,
    outfile: 'dist/extension.js',
    external: ['vscode', 'sql.js'],
    format: 'cjs',
    platform: 'node',
    minify: !isWatch,
    sourcemap: isWatch,
  });

  if (isWatch) {
    console.log('Watching for file changes...');
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
    copyTheme();
    console.log('Build complete.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
