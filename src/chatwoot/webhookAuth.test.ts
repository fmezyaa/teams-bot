import assert from 'assert';
import { Request, Response } from 'express';
import {
  createWebhookAuthMiddleware,
  extractProvidedSecret,
  secretsMatch,
  WEBHOOK_SECRET_HEADER,
} from './webhookAuth';

/**
 * Minimal dependency-free test runner (no jest in this repo).
 * Run: npx ts-node --transpile-only src/chatwoot/webhookAuth.test.ts
 */
const tests: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push([name, fn]);
}

interface FakeReqInit {
  header?: string | string[];
  pathSecret?: string;
}

function fakeReq(init: FakeReqInit = {}): Request {
  const headers: Record<string, unknown> = { 'x-forwarded-for': '203.0.113.7' };
  if (init.header !== undefined) headers[WEBHOOK_SECRET_HEADER] = init.header;
  return {
    headers,
    params: init.pathSecret !== undefined ? { secret: init.pathSecret } : {},
    ip: '10.0.0.1',
    socket: {},
  } as unknown as Request;
}

interface FakeRes {
  res: Response;
  statusCode?: number;
}

function fakeRes(): FakeRes {
  const state: FakeRes = { res: undefined as unknown as Response };
  state.res = {
    status(code: number) {
      state.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
  } as unknown as Response;
  return state;
}

function run(
  options: { secret: string; enforce: boolean },
  req: Request,
): { passed: boolean; statusCode?: number } {
  const mw = createWebhookAuthMiddleware(options);
  const state = fakeRes();
  let passed = false;
  mw(req, state.res, () => {
    passed = true;
  });
  return { passed, statusCode: state.statusCode };
}

// --- secretsMatch -----------------------------------------------------------

test('secretsMatch: equal secrets match', () => {
  assert.strictEqual(secretsMatch('s3cret', 's3cret'), true);
});

test('secretsMatch: different secrets do not match', () => {
  assert.strictEqual(secretsMatch('s3cret', 's3crey'), false);
});

test('secretsMatch: different lengths do not throw', () => {
  assert.strictEqual(secretsMatch('short', 'a-much-longer-value'), false);
  assert.strictEqual(secretsMatch('a-much-longer-value', 'short'), false);
});

test('secretsMatch: non-string / empty input is false, never throws', () => {
  assert.strictEqual(secretsMatch('s3cret', undefined), false);
  assert.strictEqual(secretsMatch('s3cret', null), false);
  assert.strictEqual(secretsMatch('s3cret', 42), false);
  assert.strictEqual(secretsMatch('s3cret', ''), false);
  assert.strictEqual(secretsMatch('', ''), false);
  assert.strictEqual(secretsMatch('', 'anything'), false);
});

// --- extractProvidedSecret --------------------------------------------------

test('extractProvidedSecret: reads header', () => {
  assert.strictEqual(extractProvidedSecret(fakeReq({ header: ' s3cret ' })), 's3cret');
});

test('extractProvidedSecret: reads path segment', () => {
  assert.strictEqual(extractProvidedSecret(fakeReq({ pathSecret: 's3cret' })), 's3cret');
});

test('extractProvidedSecret: header wins over path', () => {
  assert.strictEqual(
    extractProvidedSecret(fakeReq({ header: 'from-header', pathSecret: 'from-path' })),
    'from-header',
  );
});

test('extractProvidedSecret: undefined when nothing supplied', () => {
  assert.strictEqual(extractProvidedSecret(fakeReq()), undefined);
});

// --- middleware -------------------------------------------------------------

test('middleware: no secret configured → always passes (legacy behaviour)', () => {
  const result = run({ secret: '', enforce: true }, fakeReq());
  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.statusCode, undefined);
});

test('middleware: valid header secret passes', () => {
  const result = run({ secret: 's3cret', enforce: true }, fakeReq({ header: 's3cret' }));
  assert.strictEqual(result.passed, true);
});

test('middleware: valid path secret passes', () => {
  const result = run({ secret: 's3cret', enforce: true }, fakeReq({ pathSecret: 's3cret' }));
  assert.strictEqual(result.passed, true);
});

test('middleware: enforce=false lets an unsigned call through', () => {
  const result = run({ secret: 's3cret', enforce: false }, fakeReq());
  assert.strictEqual(result.passed, true);
  assert.strictEqual(result.statusCode, undefined);
});

test('middleware: enforce=false lets a wrong secret through', () => {
  const result = run({ secret: 's3cret', enforce: false }, fakeReq({ header: 'wrong' }));
  assert.strictEqual(result.passed, true);
});

test('middleware: enforce=true rejects a missing secret with 401', () => {
  const result = run({ secret: 's3cret', enforce: true }, fakeReq());
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.statusCode, 401);
});

test('middleware: enforce=true rejects a wrong secret with 401', () => {
  const result = run({ secret: 's3cret', enforce: true }, fakeReq({ header: 'wrong' }));
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.statusCode, 401);
});

test('middleware: enforce=true rejects a wrong path secret with 401', () => {
  const result = run({ secret: 's3cret', enforce: true }, fakeReq({ pathSecret: 'wrong' }));
  assert.strictEqual(result.passed, false);
  assert.strictEqual(result.statusCode, 401);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  - ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL - ${name}`);
      console.error(err);
    }
  }
  console.log(`\nwebhookAuth: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})();
