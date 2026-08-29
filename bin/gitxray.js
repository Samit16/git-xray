#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const srcEntry = path.join(projectRoot, 'src', 'index.js');

if (!fs.existsSync(srcEntry)) {
  console.error('Git X-Ray source entry is missing.');
  process.exit(1);
}

const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [srcEntry, ...args], {
  stdio: 'inherit',
  cwd: process.cwd(),
});

process.exit(result.status ?? 0);
