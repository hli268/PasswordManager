/**
 * Vault — core domain state and business logic.
 *
 * Owns the in-memory session/entry state and all pure logic for creating,
 * unlocking, editing, sorting, filtering, and merging vault entries.
 * Deliberately has no DOM access — UI concerns live in ui.js.
 *
 * Depends on the global `VaultCrypto` (loaded separately).
 */
const Vault = (() => {
  'use strict';

  const state = {
    unlocked: false,
    sessionSalt: null,
    verifier: null,
    cryptoKey: null,
    entries: [],
    editingId: null,
    hasExported: false,
  };

  function reset() {
    state.unlocked = false;
    state.sessionSalt = null;
    state.verifier = null;
    state.cryptoKey = null;
    state.entries = [];
    state.editingId = null;
    state.hasExported = false;
  }

  function applySession(session) {
    state.sessionSalt = session.sessionSalt;
    state.verifier = session.verifier;
    state.cryptoKey = session.cryptoKey;
    state.unlocked = true;
  }

  // Creates a brand-new session (new vault or restore-from-file) and resets
  // all in-memory state before applying it.
  async function createSession(password) {
    const session = await VaultCrypto.createSession(password);
    reset();
    applySession(session);
    return session;
  }

  // Re-unlocks an existing (already-created) session with its master
  // password, without touching entries.
  async function unlock(password) {
    const cryptoKey = await VaultCrypto.unlockSession(password, state.sessionSalt, state.verifier);
    state.cryptoKey = cryptoKey;
    state.unlocked = true;
    return cryptoKey;
  }

  function lock() {
    state.unlocked = false;
    state.cryptoKey = null;
    state.editingId = null;
  }

  function setEntries(entries) {
    state.entries = entries;
  }

  function findEntry(id) {
    return state.entries.find((entry) => entry.id === id) || null;
  }

  function addEntry({ site, username, password, notes }) {
    const now = new Date().toISOString();
    const entry = {
      id: VaultCrypto.generateId(),
      site,
      username,
      password,
      notes,
      createdAt: now,
      updatedAt: now,
    };
    state.entries.push(entry);
    return entry;
  }

  function updateEntry(id, { site, username, password, notes }) {
    const idx = state.entries.findIndex((entry) => entry.id === id);
    if (idx === -1) return null;
    state.entries[idx] = {
      ...state.entries[idx],
      site,
      username,
      password,
      notes,
      updatedAt: new Date().toISOString(),
    };
    return state.entries[idx];
  }

  function deleteEntry(id) {
    const before = state.entries.length;
    state.entries = state.entries.filter((entry) => entry.id !== id);
    return state.entries.length !== before;
  }

  function entryKey(entry) {
    // Guard against null/undefined and ensure entries are treated as strings
    const site = (entry.site || '').trim().toLowerCase();
    const username = (entry.username || '').trim().toLowerCase();
    return `${site}|${username}`;
  }

  function normalizeEntry(raw) {
    return {
      id: raw.id || VaultCrypto.generateId(),
      site: raw.site || '',
      username: raw.username || '',
      password: raw.password || '',
      notes: raw.notes || '',
      createdAt: raw.createdAt || new Date().toISOString(),
      updatedAt: raw.updatedAt || new Date().toISOString(),
    };
  }

  function sortEntries(entries, mode) {
    const sorted = [...entries];

    if (mode === 'site-desc') {
      sorted.sort((a, b) => b.site.localeCompare(a.site));
    } else if (mode === 'updated-desc') {
      sorted.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } else {
      sorted.sort((a, b) => a.site.localeCompare(b.site));
    }

    return sorted;
  }

  function filterEntries(entries, query) {
    const q = (query || '').toLowerCase().trim();
    if (!q) return entries;
    return entries.filter((e) => {
      // Guard against null/undefined fields
      const site = (e.site || '').toLowerCase();
      const username = (e.username || '').toLowerCase();
      const notes = (e.notes || '').toLowerCase();
      return site.includes(q) || username.includes(q) || notes.includes(q);
    });
  }

  function buildMergePlan(currentEntries, importedEntries) {
    const currentByKey = new Map(currentEntries.map((e) => [entryKey(e), e]));
    const toAdd = [];
    const conflicts = [];

    for (const imported of importedEntries) {
      const key = entryKey(imported);
      const existing = currentByKey.get(key);

      if (!existing) {
        toAdd.push({ ...imported, id: VaultCrypto.generateId(), updatedAt: new Date().toISOString() });
        continue;
      }

      if (existing.password === imported.password) continue;
      conflicts.push({ key, current: existing, imported });
    }

    return { toAdd, conflicts };
  }

  function applyMerge(toAdd, conflicts, resolutions) {
    let added = 0;
    let updated = 0;

    for (const entry of toAdd) {
      state.entries.push(entry);
      added += 1;
    }

    for (const conflict of conflicts) {
      if (resolutions[conflict.key] === 'imported') {
        const idx = state.entries.findIndex((e) => e.id === conflict.current.id);
        if (idx !== -1) {
          state.entries[idx] = {
            ...conflict.current,
            password: conflict.imported.password,
            notes: conflict.imported.notes || conflict.current.notes,
            updatedAt: new Date().toISOString(),
          };
          updated += 1;
        }
      }
    }

    return { added, updated };
  }

  return {
    state,
    reset,
    applySession,
    createSession,
    unlock,
    lock,
    setEntries,
    findEntry,
    addEntry,
    updateEntry,
    deleteEntry,
    entryKey,
    normalizeEntry,
    sortEntries,
    filterEntries,
    buildMergePlan,
    applyMerge,
  };
})();
