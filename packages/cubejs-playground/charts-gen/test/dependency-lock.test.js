const assert = require('assert');
const fs = require('fs');
const path = require('path');

const projectPath = path.resolve(__dirname, '..');
const manifest = require(path.join(projectPath, 'package.json'));
const lock = fs.readFileSync(path.join(projectPath, 'yarn.lock'), 'utf8');

for (const name of ['shared', 'templates']) {
  const dependency = `@cubejs-backend/${name}`;
  const localPath = `file:../../cubejs-${name === 'shared' ? 'backend-shared' : 'templates'}`;
  assert.strictEqual(
    manifest.dependencies[dependency],
    localPath,
    `${dependency} must use the patched local package`
  );
  assert(
    lock.includes(`"${dependency}@${localPath}"`),
    `${dependency} must be locked to the patched local package`
  );
}

assert.strictEqual(
  manifest.resolutions['**/@cubejs-backend/shared'],
  'file:../../cubejs-backend-shared',
  'templates must use the patched local shared package'
);
assert(!/(^|\n)\s*decompress(?:-\w+)?(?:@|\s)/m.test(lock), 'lockfile must not contain the old decompress dependency chain');
