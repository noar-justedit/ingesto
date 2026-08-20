const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { listAllFiles, isAppleDoubleFile } = require('../src/main/sentinel');

test('ignores AppleDouble metadata sidecars when listing source files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ingesto-sentinel-'));
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'clip.m4v'), 'media');
    fs.writeFileSync(path.join(root, '._clip.m4v'), 'AppleDouble metadata');
    fs.writeFileSync(path.join(root, 'nested', 'clip-2.m4v'), 'media');
    fs.writeFileSync(path.join(root, 'nested', '._clip-2.m4v'), 'AppleDouble metadata');

    const files = listAllFiles(root).map(file => file.p).sort();

    assert.deepEqual(files, ['clip.m4v', 'nested/clip-2.m4v']);
    assert.equal(isAppleDoubleFile('._clip.m4v'), true);
    assert.equal(isAppleDoubleFile('clip.m4v'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
