#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import sass from 'sass';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

const SRC_DIR = path.join(projectRoot, 'src');
const SRC_JS_DIR = path.join(SRC_DIR, 'js');
const SRC_STYLES_DIR = path.join(SRC_DIR, 'styles');
const SRC_SCSS = path.join(SRC_STYLES_DIR, 'main.scss');
const SRC_MANIFEST = path.join(SRC_DIR, 'manifest.json');
const SRC_ICONS_DIR = path.join(SRC_DIR, 'icons');
const SRC_DESCRIPTION = path.join(SRC_DIR, 'STORE_DESCRIPTION.md');

const BUILD_ROOT = path.join(projectRoot, 'build');
const DEV_OUTPUT = path.join(BUILD_ROOT, 'dev');
const PROD_OUTPUT = path.join(BUILD_ROOT, 'prod');
const DIST_ROOT = path.join(projectRoot, 'dist');

const mode = process.argv[2] || 'dev';

function log(message) {
  console.log(`[build] ${message}`);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function cleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
}

function readJsSources() {
  if (!fs.existsSync(SRC_JS_DIR)) return [];
  return fs.readdirSync(SRC_JS_DIR)
    .filter(file => file.endsWith('.js'))
    .map(file => ({
      name: file,
      path: path.join(SRC_JS_DIR, file)
    }));
}

function stripConsoleStatements(code) {
  return code.replace(/^[ \t]*console\.(info|log|warn|error|debug)\([^;]*?\);\s*$/gm, '');
}

function removeJsComments(code) {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1')
    .replace(/\n{3,}/g, '\n\n');
}

function basicJsMinify(code) {
  return removeJsComments(stripConsoleStatements(code))
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n');
}

function copyManifest(outDir) {
  if (!fs.existsSync(SRC_MANIFEST)) return;
  ensureDir(outDir);
  fs.copyFileSync(SRC_MANIFEST, path.join(outDir, 'manifest.json'));
}

function copyStoreDescription(outDir) {
  if (!fs.existsSync(SRC_DESCRIPTION)) return;
  fs.copyFileSync(SRC_DESCRIPTION, path.join(outDir, 'STORE_DESCRIPTION.md'));
}

function copyIcons(outDir) {
  if (!fs.existsSync(SRC_ICONS_DIR)) return;
  fs.cpSync(SRC_ICONS_DIR, path.join(outDir, 'icons'), { recursive: true });
}

function writeJs(outDir, { minify }) {
  const sources = readJsSources();
  sources.forEach(({ name, path: srcPath }) => {
    const destPath = path.join(outDir, name);
    ensureDir(path.dirname(destPath));
    let code = fs.readFileSync(srcPath, 'utf8');
    if (minify) {
      code = basicJsMinify(code);
    }
    fs.writeFileSync(destPath, code, 'utf8');
  });
}

function compileStyles(outDir, { minify }) {
  if (!fs.existsSync(SRC_SCSS)) return;
  const result = sass.compile(SRC_SCSS, {
    style: minify ? 'compressed' : 'expanded',
    loadPaths: [SRC_STYLES_DIR]
  });
  ensureDir(outDir);
  fs.writeFileSync(path.join(outDir, 'styles.css'), `${result.css}\n`, 'utf8');
}

function copyMisc(outDir) {
  ['AGENTS.md', 'PLAN.md'].forEach(file => {
    const srcPath = path.join(projectRoot, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(outDir, file));
    }
  });
}

function buildDev() {
  cleanDir(DEV_OUTPUT);
  ensureDir(DEV_OUTPUT);
  writeJs(DEV_OUTPUT, { minify: false });
  compileStyles(DEV_OUTPUT, { minify: false });
  copyManifest(DEV_OUTPUT);
  copyStoreDescription(DEV_OUTPUT);
  copyIcons(DEV_OUTPUT);
  copyMisc(DEV_OUTPUT);
  log('Built development extension into build/dev');
}

function buildProd() {
  cleanDir(PROD_OUTPUT);
  ensureDir(PROD_OUTPUT);
  writeJs(PROD_OUTPUT, { minify: true });
  compileStyles(PROD_OUTPUT, { minify: true });
  copyManifest(PROD_OUTPUT);
  copyStoreDescription(PROD_OUTPUT);
  copyIcons(PROD_OUTPUT);
  copyMisc(PROD_OUTPUT);

  ensureDir(DIST_ROOT);
  const zipName = 'redmana-extension-prod.zip';
  const zipPath = path.join(DIST_ROOT, zipName);
  fs.rmSync(zipPath, { force: true });

  const zipResult = spawnSync('zip', ['-r', zipPath, '.'], {
    cwd: PROD_OUTPUT,
    stdio: 'inherit'
  });

  if (zipResult.status !== 0) {
    log('Failed to create production archive.');
  } else {
    log(`Created production archive at dist/${zipName}`);
  }
}

function watchSources() {
  buildDev();
  log('Watching src for changes...');

  let timeout = null;

  fs.watch(SRC_DIR, { recursive: true }, (eventType, filename) => {
    if (!filename) return;
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => {
      try {
        buildDev();
      } catch (error) {
        console.error('[build] Watch rebuild failed:', error);
      }
    }, 150);
  });
}

switch (mode) {
  case 'dev':
    buildDev();
    break;
  case 'prod':
    buildProd();
    break;
  case 'watch':
    watchSources();
    break;
  default:
    console.error(`[build] Unknown mode "${mode}". Use dev | watch | prod.`);
    process.exit(1);
}
