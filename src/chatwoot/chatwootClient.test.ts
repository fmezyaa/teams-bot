import assert from 'assert';
import { ChatwootClient } from './chatwootClient';
import { ChatwootContact } from './types';

/**
 * Minimal dependency-free test runner (no jest in this repo).
 * Run: npx ts-node --transpile-only src/chatwoot/chatwootClient.test.ts
 *
 * Focus: contact resolution must never bind a Teams user to a foreign contact.
 */
const tests: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push([name, fn]);
}

interface Recorder {
  searchQueries: string[];
  created: Array<{ identifier: string; name: string }>;
}

function axiosError(status: number): Error & { response: { status: number } } {
  const error = new Error(`HTTP ${status}`) as Error & { response: { status: number } };
  error.response = { status };
  return error;
}

/**
 * Builds a client with the HTTP layer replaced: `searchContactsByQuery` returns
 * the given hits, `createContact` records the call or throws the given error.
 */
function makeClient(
  rec: Recorder,
  hits: ChatwootContact[],
  createError?: Error,
): ChatwootClient {
  const client = new ChatwootClient('https://example.invalid', 'token');
  const patched = client as unknown as {
    searchContactsByQuery: (accountId: number, query: string) => Promise<ChatwootContact[]>;
    createContact: (a: number, id: string, name: string, email?: string) => Promise<ChatwootContact>;
  };
  patched.searchContactsByQuery = async (_accountId: number, query: string) => {
    rec.searchQueries.push(query);
    return hits;
  };
  patched.createContact = async (_a: number, identifier: string, name: string) => {
    rec.created.push({ identifier, name });
    if (createError) throw createError;
    return { id: 4242, name, identifier };
  };
  return client;
}

const STRANGER: ChatwootContact = { id: 1, name: 'Someone Else', identifier: 'other-aad-id' };
const EXACT: ChatwootContact = { id: 2, name: 'Right Person', identifier: 'aad-1' };

test('searchContact returns the exact identifier match', async () => {
  const rec: Recorder = { searchQueries: [], created: [] };
  const client = makeClient(rec, [STRANGER, EXACT]);

  const found = await client.searchContact(10, 'aad-1');

  assert.strictEqual(found?.id, EXACT.id);
});

test('searchContact returns undefined instead of a foreign contact', async () => {
  const rec: Recorder = { searchQueries: [], created: [] };
  const client = makeClient(rec, [STRANGER]);

  const found = await client.searchContact(10, 'aad-1');

  assert.strictEqual(found, undefined, 'must not fall back to the first fuzzy search hit');
});

test('searchContact returns undefined on an empty result', async () => {
  const rec: Recorder = { searchQueries: [], created: [] };
  const client = makeClient(rec, []);

  assert.strictEqual(await client.searchContact(10, 'aad-1'), undefined);
});

test('findOrCreateContact creates a new contact when only foreign hits exist', async () => {
  const rec: Recorder = { searchQueries: [], created: [] };
  const client = makeClient(rec, [STRANGER]);

  const contact = await client.findOrCreateContact(10, 'aad-1', 'Right Person');

  assert.strictEqual(rec.created.length, 1, 'a new contact must be created');
  assert.strictEqual(rec.created[0]?.identifier, 'aad-1');
  assert.strictEqual(contact.id, 4242);
});

test('findOrCreateContact reuses the exact match without creating', async () => {
  const rec: Recorder = { searchQueries: [], created: [] };
  const client = makeClient(rec, [STRANGER, EXACT]);

  const contact = await client.findOrCreateContact(10, 'aad-1', 'Right Person');

  assert.strictEqual(rec.created.length, 0);
  assert.strictEqual(contact.id, EXACT.id);
});

test('findOrCreateContact recovers via exact identifier when create returns 422', async () => {
  const rec: Recorder = { searchQueries: [], created: [] };
  // Search index lags: first lookup misses, create 422s, re-check finds it.
  const client = new ChatwootClient('https://example.invalid', 'token');
  let searchCall = 0;
  const patched = client as unknown as {
    searchContactsByQuery: (accountId: number, query: string) => Promise<ChatwootContact[]>;
    createContact: () => Promise<ChatwootContact>;
  };
  patched.searchContactsByQuery = async () => {
    searchCall++;
    return searchCall === 1 ? [] : [EXACT];
  };
  patched.createContact = async () => {
    rec.created.push({ identifier: 'aad-1', name: 'Right Person' });
    throw axiosError(422);
  };

  const contact = await client.findOrCreateContact(10, 'aad-1', 'Right Person');

  assert.strictEqual(contact.id, EXACT.id);
});

test('findOrCreateContact propagates non-422 create errors', async () => {
  const rec: Recorder = { searchQueries: [], created: [] };
  const client = makeClient(rec, [], axiosError(500));

  await assert.rejects(() => client.findOrCreateContact(10, 'aad-1', 'Right Person'));
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
  console.log(`\nchatwootClient: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})();
