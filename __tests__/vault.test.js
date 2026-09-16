/** @jest-environment jsdom */

/**
 * Tests for vault.js (Vault) — pure state/domain logic, no DOM.
 * VaultCrypto is mocked since crypto.js is covered separately.
 */

const fs = require('fs');
const path = require('path');

beforeAll(() => {
  window.VaultCrypto = {
    createSession: async (pw) => ({ sessionSalt: `salt-${pw}`, cryptoKey: `key-${pw}`, verifier: `ver-${pw}` }),
    unlockSession: async (pw, salt, verifier) => {
      if (verifier !== `ver-${pw}`) throw new Error('Incorrect master password.');
      return `key-${pw}`;
    },
    generateId: (() => {
      let i = 1;
      return () => `gen-id-${i++}`;
    })(),
  };

  let src = fs.readFileSync(path.resolve(__dirname, '..', 'vault.js'), 'utf8');
  src = src.replace(/const\s+Vault\s*=\s*/, 'window.Vault = ');
  const scriptEl = document.createElement('script');
  scriptEl.textContent = src;
  document.body.appendChild(scriptEl);
});

beforeEach(() => {
  Vault.reset();
});

describe('Vault session lifecycle', () => {
  test('createSession resets state and unlocks with a fresh session', async () => {
    Vault.state.entries = [{ id: 'stale' }];
    await Vault.createSession('pw1');

    expect(Vault.state.unlocked).toBe(true);
    expect(Vault.state.entries).toEqual([]);
    expect(Vault.state.cryptoKey).toBe('key-pw1');
    expect(Vault.state.sessionSalt).toBe('salt-pw1');
  });

  test('unlock re-derives the key for an existing session without touching entries', async () => {
    await Vault.createSession('pw1');
    Vault.setEntries([{ id: 'e1', site: 'a.com' }]);
    Vault.lock();

    expect(Vault.state.unlocked).toBe(false);
    expect(Vault.state.cryptoKey).toBeNull();

    await Vault.unlock('pw1');

    expect(Vault.state.unlocked).toBe(true);
    expect(Vault.state.cryptoKey).toBe('key-pw1');
    expect(Vault.state.entries).toEqual([{ id: 'e1', site: 'a.com' }]);
  });

  test('unlock throws and leaves state locked on wrong password', async () => {
    await Vault.createSession('pw1');
    Vault.lock();

    await expect(Vault.unlock('wrong')).rejects.toThrow('Incorrect master password.');
    expect(Vault.state.unlocked).toBe(false);
  });

  test('lock clears cryptoKey and editingId but keeps entries in memory', async () => {
    await Vault.createSession('pw1');
    Vault.setEntries([{ id: 'e1' }]);
    Vault.state.editingId = 'e1';

    Vault.lock();

    expect(Vault.state.cryptoKey).toBeNull();
    expect(Vault.state.editingId).toBeNull();
    expect(Vault.state.entries).toEqual([{ id: 'e1' }]);
  });

  test('reset clears everything including entries', async () => {
    await Vault.createSession('pw1');
    Vault.setEntries([{ id: 'e1' }]);
    Vault.state.hasExported = true;

    Vault.reset();

    expect(Vault.state).toMatchObject({
      unlocked: false,
      sessionSalt: null,
      verifier: null,
      cryptoKey: null,
      entries: [],
      editingId: null,
      hasExported: false,
    });
  });
});

describe('Vault entry CRUD', () => {
  test('addEntry assigns an id and timestamps', () => {
    const entry = Vault.addEntry({ site: 'a.com', username: 'u', password: 'p', notes: 'n' });
    expect(entry.id).toBeTruthy();
    expect(entry.createdAt).toBeTruthy();
    expect(entry.updatedAt).toBe(entry.createdAt);
    expect(Vault.state.entries).toHaveLength(1);
  });

  test('findEntry returns the matching entry or null', () => {
    const entry = Vault.addEntry({ site: 'a.com', username: 'u', password: 'p', notes: '' });
    expect(Vault.findEntry(entry.id)).toEqual(entry);
    expect(Vault.findEntry('does-not-exist')).toBeNull();
  });

  test('updateEntry replaces fields and bumps updatedAt, returns null for unknown id', async () => {
    const entry = Vault.addEntry({ site: 'a.com', username: 'u', password: 'p', notes: '' });
    await new Promise((r) => setTimeout(r, 5));

    const updated = Vault.updateEntry(entry.id, { site: 'b.com', username: 'u2', password: 'p2', notes: 'note' });
    expect(updated.site).toBe('b.com');
    expect(updated.username).toBe('u2');
    expect(updated.id).toBe(entry.id);
    expect(updated.createdAt).toBe(entry.createdAt);

    expect(Vault.updateEntry('missing-id', { site: 'x', username: '', password: '', notes: '' })).toBeNull();
  });

  test('deleteEntry removes the entry and returns true; false when not found', () => {
    const entry = Vault.addEntry({ site: 'a.com', username: '', password: '', notes: '' });
    expect(Vault.deleteEntry(entry.id)).toBe(true);
    expect(Vault.state.entries).toHaveLength(0);
    expect(Vault.deleteEntry('missing-id')).toBe(false);
  });

  test('setEntries replaces the entries array wholesale', () => {
    Vault.addEntry({ site: 'a.com', username: '', password: '', notes: '' });
    Vault.setEntries([{ id: 'x', site: 'b.com' }]);
    expect(Vault.state.entries).toEqual([{ id: 'x', site: 'b.com' }]);
  });
});

describe('Vault.normalizeEntry', () => {
  test('fills in missing fields with sane defaults', () => {
    const normalized = Vault.normalizeEntry({ site: 'a.com' });
    expect(normalized.id).toBeTruthy();
    expect(normalized.username).toBe('');
    expect(normalized.password).toBe('');
    expect(normalized.notes).toBe('');
    expect(normalized.createdAt).toBeTruthy();
    expect(normalized.updatedAt).toBeTruthy();
  });

  test('preserves an existing id and timestamps rather than regenerating them', () => {
    const raw = { id: 'keep-me', site: 'a.com', createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-02T00:00:00.000Z' };
    const normalized = Vault.normalizeEntry(raw);
    expect(normalized.id).toBe('keep-me');
    expect(normalized.createdAt).toBe('2020-01-01T00:00:00.000Z');
    expect(normalized.updatedAt).toBe('2020-01-02T00:00:00.000Z');
  });
});

describe('Vault.sortEntries', () => {
  const entries = [
    { site: 'Charlie', updatedAt: '2024-01-01T00:00:00.000Z' },
    { site: 'alpha', updatedAt: '2024-03-01T00:00:00.000Z' },
    { site: 'bravo', updatedAt: '2024-02-01T00:00:00.000Z' },
  ];

  test('default mode sorts by site ascending, case-insensitively', () => {
    const sorted = Vault.sortEntries(entries, 'site-asc');
    expect(sorted.map((e) => e.site)).toEqual(['alpha', 'bravo', 'Charlie']);
  });

  test('site-desc sorts by site descending', () => {
    const sorted = Vault.sortEntries(entries, 'site-desc');
    expect(sorted.map((e) => e.site)).toEqual(['Charlie', 'bravo', 'alpha']);
  });

  test('updated-desc sorts by most recently updated first', () => {
    const sorted = Vault.sortEntries(entries, 'updated-desc');
    expect(sorted.map((e) => e.site)).toEqual(['alpha', 'bravo', 'Charlie']);
  });

  test('does not mutate the original array', () => {
    const copy = [...entries];
    Vault.sortEntries(entries, 'site-desc');
    expect(entries).toEqual(copy);
  });
});

describe('Vault.filterEntries', () => {
  const entries = [
    { site: 'GitHub', username: 'octocat', notes: 'work account' },
    { site: 'example.com', username: 'me', notes: '' },
    { site: 'Bank', username: '', notes: 'has a note with github mention' },
  ];

  test('returns all entries for an empty/whitespace query', () => {
    expect(Vault.filterEntries(entries, '')).toEqual(entries);
    expect(Vault.filterEntries(entries, '   ')).toEqual(entries);
    expect(Vault.filterEntries(entries, undefined)).toEqual(entries);
  });

  test('matches case-insensitively across site, username, and notes', () => {
    const bySite = Vault.filterEntries(entries, 'github');
    expect(bySite.map((e) => e.site)).toEqual(expect.arrayContaining(['GitHub', 'Bank']));

    const byUsername = Vault.filterEntries(entries, 'OCTOCAT');
    expect(byUsername).toHaveLength(1);
    expect(byUsername[0].site).toBe('GitHub');
  });

  test('returns an empty array when nothing matches', () => {
    expect(Vault.filterEntries(entries, 'nonexistent-zzz')).toEqual([]);
  });

  test('tolerates entries with missing fields', () => {
    const messy = [{ site: null, username: undefined, notes: null }];
    expect(() => Vault.filterEntries(messy, 'x')).not.toThrow();
    expect(Vault.filterEntries(messy, 'x')).toEqual([]);
  });
});

describe('Vault.entryKey', () => {
  test('combines lowercased, trimmed site and username', () => {
    expect(Vault.entryKey({ site: '  Example.com  ', username: ' User@Example.com ' })).toBe(
      'example.com|user@example.com'
    );
  });

  test('tolerates missing site/username', () => {
    expect(Vault.entryKey({})).toBe('|');
  });
});

describe('Vault merge logic', () => {
  test('buildMergePlan adds entries with no matching key', () => {
    const current = [{ site: 'a.com', username: 'u', password: 'p1' }];
    const imported = [{ site: 'b.com', username: 'u2', password: 'p2' }];

    const { toAdd, conflicts } = Vault.buildMergePlan(current, imported);
    expect(toAdd).toHaveLength(1);
    expect(toAdd[0].site).toBe('b.com');
    expect(toAdd[0].id).toBeTruthy();
    expect(conflicts).toHaveLength(0);
  });

  test('buildMergePlan skips entries that are identical (same key + password)', () => {
    const current = [{ site: 'a.com', username: 'u', password: 'same' }];
    const imported = [{ site: 'a.com', username: 'u', password: 'same' }];

    const { toAdd, conflicts } = Vault.buildMergePlan(current, imported);
    expect(toAdd).toHaveLength(0);
    expect(conflicts).toHaveLength(0);
  });

  test('buildMergePlan flags a conflict when the same key has a different password', () => {
    const current = [{ site: 'a.com', username: 'u', password: 'old' }];
    const imported = [{ site: 'a.com', username: 'u', password: 'new' }];

    const { toAdd, conflicts } = Vault.buildMergePlan(current, imported);
    expect(toAdd).toHaveLength(0);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].current.password).toBe('old');
    expect(conflicts[0].imported.password).toBe('new');
  });

  test('applyMerge adds new entries and updates entries resolved as "imported"', () => {
    const existing = Vault.addEntry({ site: 'a.com', username: 'u', password: 'old', notes: 'keepme' });
    const conflicts = [{ key: 'a.com|u', current: existing, imported: { password: 'new', notes: '' } }];
    const toAdd = [{ id: 'new-id', site: 'b.com', username: 'u2', password: 'p2', notes: '' }];

    const { added, updated } = Vault.applyMerge(toAdd, conflicts, { 'a.com|u': 'imported' });

    expect(added).toBe(1);
    expect(updated).toBe(1);
    expect(Vault.state.entries).toHaveLength(2);

    const updatedEntry = Vault.findEntry(existing.id);
    expect(updatedEntry.password).toBe('new');
    expect(updatedEntry.notes).toBe('keepme'); // falls back since imported.notes is empty
  });

  test('applyMerge leaves a conflict entry untouched when resolved as "current"', () => {
    const existing = Vault.addEntry({ site: 'a.com', username: 'u', password: 'old', notes: '' });
    const conflicts = [{ key: 'a.com|u', current: existing, imported: { password: 'new', notes: '' } }];

    const { added, updated } = Vault.applyMerge([], conflicts, { 'a.com|u': 'current' });

    expect(added).toBe(0);
    expect(updated).toBe(0);
    expect(Vault.findEntry(existing.id).password).toBe('old');
  });
});
