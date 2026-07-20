import assert from 'assert';
import type { AxiosInstance } from 'axios';
import { GraphClient, GraphError } from './graphClient';

/**
 * Minimal dependency-free test runner (no jest in this repo).
 * Run: npx ts-node --transpile-only src/graph/graphClient.test.ts
 */
const tests: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push([name, fn]);
}

/** Build a fake AxiosInstance exposing only .post/.get with counters. */
function fakeHttp(overrides: Partial<Record<'post' | 'get', (...args: any[]) => any>>) {
  const calls = { post: 0, get: 0 };
  const http = {
    post: async (...args: any[]) => {
      calls.post++;
      return overrides.post ? overrides.post(...args) : { data: {} };
    },
    get: async (...args: any[]) => {
      calls.get++;
      return overrides.get ? overrides.get(...args) : { data: {} };
    },
  } as unknown as AxiosInstance;
  return { http, calls };
}

const tokenResponse = { data: { access_token: 'tok-123', expires_in: 3600 } };

test('token is cached per tenant (only one token request across two lookups)', async () => {
  const { http, calls } = fakeHttp({
    post: () => tokenResponse,
    get: () => ({ data: { jobTitle: 'Trainer', officeLocation: 'Berlin', department: 'Nord' } }),
  });
  const client = new GraphClient('cid', 'secret', http);

  await client.getUserProfile('tenant-A', 'user-1');
  await client.getUserProfile('tenant-A', 'user-2');

  assert.strictEqual(calls.post, 1, 'token endpoint should be hit exactly once');
  assert.strictEqual(calls.get, 2, 'profile endpoint should be hit twice');
});

test('separate tenants get separate tokens', async () => {
  const { http, calls } = fakeHttp({
    post: () => tokenResponse,
    get: () => ({ data: {} }),
  });
  const client = new GraphClient('cid', 'secret', http);

  await client.getUserProfile('tenant-A', 'user-1');
  await client.getUserProfile('tenant-B', 'user-1');

  assert.strictEqual(calls.post, 2, 'each tenant should trigger its own token request');
});

test('profile mapping returns the three selected fields', async () => {
  const { http } = fakeHttp({
    post: () => tokenResponse,
    get: () => ({ data: { jobTitle: 'Coach', officeLocation: 'Hamburg', department: 'West', extra: 'ignored' } }),
  });
  const client = new GraphClient('cid', 'secret', http);

  const profile = await client.getUserProfile('tenant-A', 'user-1');
  assert.strictEqual(profile.jobTitle, 'Coach');
  assert.strictEqual(profile.officeLocation, 'Hamburg');
  assert.strictEqual(profile.department, 'West');
});

test('403 on profile lookup surfaces as GraphError with status 403', async () => {
  const { http } = fakeHttp({
    post: () => tokenResponse,
    get: () => {
      throw { response: { status: 403 } };
    },
  });
  const client = new GraphClient('cid', 'secret', http);

  await assert.rejects(
    () => client.getUserProfile('tenant-A', 'user-1'),
    (err: unknown) => {
      assert.ok(err instanceof GraphError, 'should be a GraphError');
      assert.strictEqual((err as GraphError).status, 403);
      return true;
    }
  );
});

test('missing access_token is treated as an error', async () => {
  const { http } = fakeHttp({
    post: () => ({ data: {} }),
  });
  const client = new GraphClient('cid', 'secret', http);

  await assert.rejects(() => client.getUserProfile('tenant-A', 'user-1'), GraphError);
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
  console.log(`\ngraphClient: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})();
