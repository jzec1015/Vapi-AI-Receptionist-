import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';

// The Railway image is built from the Dockerfile, which copies files one by one. A local module
// that server.mjs imports but the Dockerfile leaves out crashes the container at startup.
const copied = () => readFileSync('Dockerfile', 'utf8').split('\n').filter(l => /^COPY\s/.test(l))
  .flatMap(l => l.trim().split(/\s+/).slice(1, -1));

function localImports(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(/^\s*import\s[^'"]*['"](\.\/[^'"]+)['"]/gm)) localImports(spec.slice(2), seen);
  return seen;
}

test('the Dockerfile copies every local module server.mjs needs', () => {
  const files = copied();
  for (const file of localImports('server.mjs')) assert.ok(files.includes(file), `Dockerfile does not copy ${file}`);
});

test('the Dockerfile copies the trial templates the server reads at startup', () => {
  const files = copied();
  for (const [, file] of readFileSync('trial.mjs', 'utf8').matchAll(/new URL\('\.\/([^']+)', import\.meta\.url\)/g)) assert.ok(files.includes(file), `Dockerfile does not copy ${file}`);
});

test('the server starts from only the files the Dockerfile copies', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'image-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const file of copied()) { mkdirSync(dirname(join(dir, file)), { recursive: true }); copyFileSync(file, join(dir, file)); }
  const child = spawn(process.execPath, ['server.mjs'], { cwd: dir, env: { PATH: process.env.PATH, PORT: '0', DATA_DIR: join(dir, 'data') } });
  t.after(() => child.kill());
  let out = '';
  const started = await new Promise(resolve => {
    child.stdout.on('data', d => { out += d; if (out.includes('listening')) resolve(true); });
    child.stderr.on('data', d => { out += d; });
    child.on('exit', () => resolve(false));
    setTimeout(() => resolve(false), 10000);
  });
  assert.ok(started, `server did not start:\n${out}`);
});
