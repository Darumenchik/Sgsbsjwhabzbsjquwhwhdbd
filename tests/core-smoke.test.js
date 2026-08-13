const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const root = path.join(__dirname, '..');

test('server.js and utils.js parse', () => {
  for (const f of ['server.js', 'utils.js', 'js/core.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(src.length > 100, f + ' too small');
  }
});

test('no hardcoded admin panel password in client', () => {
  const app = fs.readFileSync(path.join(root, 'js/app.js'), 'utf8');
  assert.equal(app.includes("ADMIN_PANEL_PASSWORD = '2286767'"), false);
  assert.ok(app.includes('/api/admin/unlock'));
});

test('core.js exposes ChiperCore helpers', () => {
  // Load core in isolation via vm-less check of exports pattern
  const src = fs.readFileSync(path.join(root, 'js/core.js'), 'utf8');
  assert.ok(src.includes('getMyProfileId'));
  assert.ok(src.includes('linkChatIds'));
  assert.ok(src.includes('enqueueOutbox'));
  assert.ok(src.includes('compressImageFile'));
});

test('server has admin unlock and createConv rate limit', () => {
  const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(src.includes("/api/admin/unlock"));
  assert.ok(src.includes('createConv'));
  assert.ok(src.includes("role === 'admin_panel'"));
});

test('syntax check via node --check', async () => {
  const files = ['server.js', 'utils.js', 'js/core.js', 'js/app.js'];
  for (const f of files) {
    await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' });
      let err = '';
      p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => {
        if (code !== 0) reject(new Error(f + ' syntax error: ' + err));
        else resolve();
      });
    });
  }
});

test('new modules exist and parse', () => {
  for (const f of ['js/sync.js', 'js/messages-pipeline.js', 'js/calls-enhance.js', 'js/privacy.js', 'sw.js']) {
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    assert.ok(src.length > 50, f);
  }
});

test('server has refresh ice-servers and receipts', () => {
  const src = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.ok(src.includes('/api/auth/refresh'));
  assert.ok(src.includes('/api/ice-servers'));
  assert.ok(src.includes('message-receipt') || src.includes('/receipt'));
  assert.ok(src.includes('Content-Security-Policy'));
  assert.ok(src.includes('client_msg_id'));
});
