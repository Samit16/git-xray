'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname);
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const OUT_FILE = path.join(DIST, 'gitxray.js');

const MODULES = [
  'git/locator.js',
  'git/objects.js',
  'git/refs.js',
  'git/pack.js',
  'git/walker.js',
  'analytics/churn.js',
  'analytics/ownership.js',
  'analytics/bus-factor.js',
  'analytics/hotspots.js',
  'analytics/overview.js',
  'analytics/complexity.js',
  'outputs/json.js',
  'outputs/terminal.js',
  'cli/args.js',
  'ui/dashboard.js',
  'index.js',
];

if (!fs.existsSync(DIST)) {
  fs.mkdirSync(DIST, { recursive: true });
}

function readModule(relPath) {
  const fullPath = path.join(SRC, relPath);
  let content = fs.readFileSync(fullPath, 'utf8');
  content = content.replace(/^#![^\r\n]*\r?\n/, '');
  content = content.replace(/^\s*['"]use strict['"]\s*;?\s*/gm, '');
  return content;
}

const moduleSources = Object.fromEntries(
  MODULES.map((moduleName) => [moduleName, readModule(moduleName)])
);

const bundle = `#!/usr/bin/env node
'use strict';

const path = require('node:path');
const moduleCache = new Map();
const moduleSources = ${JSON.stringify(moduleSources, null, 2)};

function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith('.')) {
    return specifier;
  }

  const baseDir = path.posix.dirname(fromFile || '.');
  const resolved = path.posix.normalize(path.posix.join(baseDir, specifier));
  return resolved.endsWith('.js') ? resolved : resolved + '.js';
}

function loadModule(file) {
  if (moduleCache.has(file)) {
    return moduleCache.get(file).exports;
  }

  const source = moduleSources[file];
  if (!source) {
    throw new Error('Missing bundled module: ' + file);
  }

  const module = { exports: {} };
  moduleCache.set(file, module);

  const localRequire = Object.assign((specifier) => {
    if (!specifier.startsWith('.')) {
      return require(specifier);
    }
    return loadModule(resolveRelative(file, specifier));
  }, { main: module });

  const wrapped = new Function(
    'module',
    'exports',
    'require',
    '__filename',
    '__dirname',
    source
  );

  wrapped(module, module.exports, localRequire, file, path.posix.dirname(file));
  return module.exports;
}

loadModule('index.js');
`;

fs.writeFileSync(OUT_FILE, bundle.trim() + '\n', 'utf8');

const hash = crypto.createHash('sha256').update(fs.readFileSync(OUT_FILE)).digest('hex');
console.log(`✓ Built dist/gitxray.js (SHA-256: ${hash})`);
