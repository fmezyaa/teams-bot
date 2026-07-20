import assert from 'assert';
import { EnrichmentService } from './enrichmentService';
import { GraphClient, GraphError, GraphUserProfile } from '../graph/graphClient';
import { ChatwootClient } from '../chatwoot/chatwootClient';

/**
 * Minimal dependency-free test runner (no jest in this repo).
 * Run: npx ts-node --transpile-only src/services/enrichmentService.test.ts
 */
const tests: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push([name, fn]);
}

interface Recorder {
  profileCalls: number;
  patchCalls: number;
  lastAttributes?: Record<string, unknown>;
}

function fakeGraph(profile: GraphUserProfile | Error, rec: Recorder): GraphClient {
  return {
    getUserProfile: async () => {
      rec.profileCalls++;
      if (profile instanceof Error) throw profile;
      return profile;
    },
  } as unknown as GraphClient;
}

function fakeChatwoot(rec: Recorder): ChatwootClient {
  return {
    updateContactCustomAttributes: async (_a: number, _c: number, attrs: Record<string, unknown>) => {
      rec.patchCalls++;
      rec.lastAttributes = attrs;
    },
  } as unknown as ChatwootClient;
}

const baseParams = {
  teamsTenantId: 'tenant-A',
  aadObjectId: 'user-1',
  chatwootAccountId: 10,
  chatwootContactId: 99,
};

test('maps officeLocation→standort, jobTitle→position, department→region', async () => {
  const rec: Recorder = { profileCalls: 0, patchCalls: 0 };
  const svc = new EnrichmentService(
    fakeGraph({ jobTitle: 'Trainer', officeLocation: 'Berlin', department: 'Nord' }, rec),
    fakeChatwoot(rec)
  );

  await svc.enrichContact(baseParams);

  assert.strictEqual(rec.patchCalls, 1);
  assert.deepStrictEqual(rec.lastAttributes, { standort: 'Berlin', position: 'Trainer', region: 'Nord' });
});

test('region is only written when department is present', async () => {
  const rec: Recorder = { profileCalls: 0, patchCalls: 0 };
  const svc = new EnrichmentService(
    fakeGraph({ jobTitle: 'Trainer', officeLocation: 'Berlin', department: null }, rec),
    fakeChatwoot(rec)
  );

  await svc.enrichContact(baseParams);

  assert.deepStrictEqual(rec.lastAttributes, { standort: 'Berlin', position: 'Trainer' });
});

test('no PATCH when Graph returns no enrichable fields', async () => {
  const rec: Recorder = { profileCalls: 0, patchCalls: 0 };
  const svc = new EnrichmentService(fakeGraph({}, rec), fakeChatwoot(rec));

  await svc.enrichContact(baseParams);

  assert.strictEqual(rec.patchCalls, 0);
});

test('TTL cache dedupes a second call for the same (tenant, user)', async () => {
  const rec: Recorder = { profileCalls: 0, patchCalls: 0 };
  const svc = new EnrichmentService(
    fakeGraph({ officeLocation: 'Berlin' }, rec),
    fakeChatwoot(rec)
  );

  await svc.enrichContact(baseParams);
  await svc.enrichContact(baseParams);

  assert.strictEqual(rec.profileCalls, 1, 'second call should be short-circuited by cache');
  assert.strictEqual(rec.patchCalls, 1);
});

test('TTL cache is scoped per (tenant, user)', async () => {
  const rec: Recorder = { profileCalls: 0, patchCalls: 0 };
  const svc = new EnrichmentService(
    fakeGraph({ officeLocation: 'Berlin' }, rec),
    fakeChatwoot(rec)
  );

  await svc.enrichContact(baseParams);
  await svc.enrichContact({ ...baseParams, aadObjectId: 'user-2' });

  assert.strictEqual(rec.profileCalls, 2, 'a different user should not be deduped');
});

test('403 (missing admin consent) is swallowed and does not throw', async () => {
  const rec: Recorder = { profileCalls: 0, patchCalls: 0 };
  const svc = new EnrichmentService(
    fakeGraph(new GraphError('forbidden', 403), rec),
    fakeChatwoot(rec)
  );

  await svc.enrichContact(baseParams); // must resolve, not reject
  assert.strictEqual(rec.patchCalls, 0);
});

test('a failed attempt still consumes the TTL window (no retry storm)', async () => {
  const rec: Recorder = { profileCalls: 0, patchCalls: 0 };
  const svc = new EnrichmentService(
    fakeGraph(new GraphError('forbidden', 403), rec),
    fakeChatwoot(rec)
  );

  await svc.enrichContact(baseParams);
  await svc.enrichContact(baseParams);

  assert.strictEqual(rec.profileCalls, 1, 'failure should be cached like a success within the TTL');
});

test('generic errors are swallowed', async () => {
  const rec: Recorder = { profileCalls: 0, patchCalls: 0 };
  const svc = new EnrichmentService(fakeGraph(new Error('network down'), rec), fakeChatwoot(rec));

  await svc.enrichContact(baseParams); // must resolve
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
  console.log(`\nenrichmentService: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})();
