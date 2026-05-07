import * as esbuild from 'esbuild'
import { cp, mkdir, copyFile, access } from 'node:fs/promises'

const watch = process.argv.includes('--watch')

async function exists(path) {
  return access(path).then(() => true).catch(() => false)
}

async function build() {
  await mkdir('dist/background',  { recursive: true })
  await mkdir('dist/content',     { recursive: true })
  await mkdir('dist/popup',       { recursive: true })
  await mkdir('dist/options',     { recursive: true })
  await mkdir('dist/status',      { recursive: true })
  await mkdir('dist/sidepanel',   { recursive: true })
  await mkdir('dist/icons',       { recursive: true })

  const ctx = await esbuild.context({
    entryPoints: {
      'background/service-worker': 'src/background/service-worker.js',
      'content/content':           'src/content/content.js',
      'popup/popup':               'src/popup/popup.js',
      'options/options':           'src/options/options.js',
      'status/status':             'src/status/status.js',
      'sidepanel/sidepanel':       'src/sidepanel/sidepanel.js',
    },
    bundle:    true,
    outdir:    'dist',
    format:    'iife',
    target:    'chrome120',
    sourcemap: watch ? 'inline' : false,
    minify:    !watch,
    logLevel:  'info',
  })

  // Copy static files into dist/ (always, including watch mode)
  await copyFile('manifest.json',              'dist/manifest.json')
  await copyFile('src/popup/popup.html',       'dist/popup/popup.html')
  await copyFile('src/popup/popup.css',        'dist/popup/popup.css')
  await copyFile('src/options/options.html',   'dist/options/options.html')
  await copyFile('src/options/options.css',    'dist/options/options.css')
  await copyFile('src/status/status.html',     'dist/status/status.html')
  await copyFile('src/status/status.css',      'dist/status/status.css')
  await copyFile('src/sidepanel/sidepanel.html', 'dist/sidepanel/sidepanel.html')

  if (await exists('icons')) {
    await cp('icons', 'dist/icons', { recursive: true })
  }

  if (watch) {
    await ctx.watch()
    console.log('[colophon] Watching for changes…')
    return
  }

  await ctx.rebuild()
  await ctx.dispose()
  console.log('[colophon] Build complete → load dist/ as unpacked extension.')
}

build().catch(err => { console.error(err); process.exit(1) })
