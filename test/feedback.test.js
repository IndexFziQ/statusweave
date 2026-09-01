'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const feedback = require('../src/feedback');

test('first-run feedback invite is local, optional, and shown only once', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusweave-feedback-'));
  const env = { STATUSWEAVE_STATE_DIR: dir };
  const first = feedback.firstRunInvite(env);
  assert.match(first.join('\n'), /No telemetry/);
  assert.match(first.join('\n'), /install_report\.md/);
  assert.equal(feedback.firstRunInvite(env), null);
  assert.equal(fs.statSync(path.join(dir, 'install-feedback-invited')).mode & 0o777, 0o600);
});

test('first-run feedback invite can be disabled', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'statusweave-feedback-off-'));
  assert.equal(feedback.firstRunInvite({ STATUSWEAVE_STATE_DIR: dir, STATUSWEAVE_FEEDBACK_INVITE: '0' }), null);
  assert.equal(fs.existsSync(path.join(dir, 'install-feedback-invited')), false);
});
