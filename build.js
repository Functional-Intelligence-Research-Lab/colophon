import * as esbuild from 'esbuild'
import { cp, mkdir, copyFile, access, readFile, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'

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
  await mkdir('dist/viewer',      { recursive: true })
  await mkdir('dist/icons',       { recursive: true })
  await mkdir('dist/shared',      { recursive: true })

  const ctx = await esbuild.context({
    entryPoints: {
      'background/service-worker': 'src/background/service-worker.js',
      'content/content':           'src/content/content.js',
      'popup/popup':               'src/popup/popup.js',
      'options/options':           'src/options/options.js',
      'status/status':             'src/status/status.js',
      'sidepanel/sidepanel':       'src/sidepanel/sidepanel.js',
      'viewer/viewer':             'src/viewer/viewer.js',
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
  await copyFile('src/sidepanel/sidepanel.css', 'dist/sidepanel/sidepanel.css')
  await copyFile('src/viewer/viewer.html',      'dist/viewer/viewer.html')
  await copyFile('src/viewer/viewer.css',       'dist/viewer/viewer.css')
  await copyFile('src/shared/theme.css',        'dist/shared/theme.css')

  if (await exists('icons')) {
    await cp('icons', 'dist/icons', { recursive: true })
  }

  if (await exists('src/assets')) {
    await cp('src/assets', 'dist/assets', { recursive: true })
  }

  // Ship host.py source (for auditability) and the prebuilt platform binaries
  // (bin/) — skip build/, Nuitka's local scratch output, which isn't part of
  // the distributable package.
  await cp('native-host', 'dist/native-host', {
    recursive: true,
    filter: (src) => !src.includes(`native-host${path.sep}build`),
  })

  for (const os of ['win', 'mac', 'linux']) {
    if (!await exists(`native-host/bin/${os}/colophon-host.zip`)) {
      console.warn(`[colophon] WARNING: native-host/bin/${os}/colophon-host.zip missing — ${os} users cannot install the local AI.`);
    }
  }

  if (watch) {
    await ctx.watch()
    console.log('[colophon] Watching for changes…')
    return
  }

  await ctx.rebuild()
  await ctx.dispose()
  await buildFirefoxVariant()
  console.log('[colophon] Build complete → load dist/ (Chrome) or dist/firefox/ (Firefox) as unpacked extension.')
}

// Derive dist/firefox/ from the finished Chrome build: same bundles and assets,
// plus a Firefox manifest generated from manifest.json so the two never drift.
// Skipped in watch mode; dist/ stays the Chrome dev loop.
async function buildFirefoxVariant() {
  await rm('dist/firefox', { recursive: true, force: true })
  await mkdir('dist/firefox', { recursive: true })
  // Copy entry by entry (fs.cp cannot copy dist into its own subdirectory).
  // native-host is excluded: Firefox host manifests are a separate follow-up,
  // and this keeps the AMO package free of compiled binaries.
  const { readdir } = await import('node:fs/promises')
  for (const entry of await readdir('dist')) {
    if (entry === 'firefox' || entry === 'native-host') continue
    await cp(path.join('dist', entry), path.join('dist/firefox', entry), { recursive: true })
  }

  const manifest = JSON.parse(await readFile('manifest.json', 'utf8'))

  // Firefox MV3 runs the background as an event page, not a service worker.
  // The bundle is a plain IIFE, so the same file works for both.
  manifest.background = { scripts: ['background/service-worker.js'] }

  // sidebar_action is the Firefox equivalent of side_panel; the code shims
  // chrome.sidePanel vs chrome.sidebarAction at the call sites.
  delete manifest.side_panel
  manifest.sidebar_action = {
    default_panel: 'sidepanel/sidepanel.html',
    default_title: 'Colophon',
    default_icon: 'icons/icon48.png',
  }

  // sidePanel is a Chrome-only permission name.
  manifest.permissions = manifest.permissions.filter((p) => p !== 'sidePanel')

  // Required for AMO signing and native messaging allowed_extensions.
  manifest.browser_specific_settings = {
    gecko: { id: 'colophon@firl.nl', strict_min_version: '128.0' },
  }

  // Firefox uses options_ui instead of options_page.
  delete manifest.options_page
  manifest.options_ui = { page: 'options/options.html', open_in_tab: true }

  await writeFile('dist/firefox/manifest.json', JSON.stringify(manifest, null, 2) + '\n')
}

build().catch(err => { console.error(err); process.exit(1) })
