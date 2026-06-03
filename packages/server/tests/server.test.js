/**
 * @wison/server/tests — 集成测试
 *
 * 运行: node --test packages/server/tests/server.test.js
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

describe('Config', () => {
  it('loads with defaults', () => {
    const config = require('../src/config');
    assert.equal(typeof config.port, 'number');
    assert.ok(config.port > 0);
  });

  it('respects env vars', () => {
    process.env.WISON_PORT = '9090';
    delete require.cache[require.resolve('../src/config')];
    const config = require('../src/config');
    assert.equal(config.port, 9090);
    delete process.env.WISON_PORT;
    delete require.cache[require.resolve('../src/config')];
  });
});

describe('Session ID', () => {
  it('generates unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 1000; i++) {
      const id = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      assert.ok(!ids.has(id));
      ids.add(id);
    }
  });
});

describe('InputProxy rate limit', () => {
  it('enforces token bucket', async () => {
    const { InputProxy } = require('../src/input-proxy');
    const mockCdp = {
      dispatchMouse: async () => {},
      dispatchKey: async () => {},
      insertText: async () => {},
    };
    const proxy = new InputProxy(mockCdp, { warn() {}, trace() {}, info() {} });

    const payload = new TextEncoder().encode(JSON.stringify({ x: 100, y: 200 }));
    const buf = new Uint8Array(1 + payload.length);
    buf[0] = 0x10;
    buf.set(payload, 1);

    let allowed = 0;
    for (let i = 0; i < 500; i++) {
      const before = proxy._tokens;
      await proxy.inject(buf.buffer);
      if (proxy._tokens < before) allowed++;
    }
    assert.ok(allowed < 300, `Expected <300, got ${allowed}`);
  });
});
