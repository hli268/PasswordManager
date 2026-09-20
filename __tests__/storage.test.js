/** @jest-environment jsdom */

/**
 * Tests for storage.js (Storage) — filename handling, CSV building,
 * export content building, and backup file parsing. VaultCrypto is mocked
 * since it's covered in its own test file.
 *
 * storage.js has no dependency on Vault: parseBackupFile takes an optional
 * `normalizeEntry` callback instead of reaching for a `Vault` global, so
 * these tests exercise that directly rather than stubbing out `window.Vault`.
 */

const fs = require('fs');
const path = require('path');

beforeAll(() => {
  window.VaultCrypto = {
    encryptWithKey: jest.fn(async (cryptoKey, sessionSalt, payload) => ({
      version: 2,
      algorithm: 'AES-GCM',
      kdf: 'PBKDF2',
      iterations: 600000,
      salt: 'salt',
      iv: 'iv',
      ciphertext: 'ciphertext-of-' + JSON.stringify(payload),
    })),
    decrypt: jest.fn(async (password, backup) => {
      if (password !== 'correct') throw new Error('Incorrect master password or corrupted backup file.');
      return { data: { entries: [{ id: '1', site: 'a.com' }] }, sessionSalt: 'salt' };
    }),
  };

  let src = fs.readFileSync(path.resolve(__dirname, '..', 'storage.js'), 'utf8');
  src = src.replace(/const\s+Storage\s*=\s*/, 'window.Storage = ');
  const scriptEl = document.createElement('script');
  scriptEl.textContent = src;
  document.body.appendChild(scriptEl);
});

describe('sanitizeFilename', () => {
  test('appends .vault extension when missing', () => {
    expect(Storage.sanitizeFilename('my-backup')).toBe('my-backup.vault');
  });

  test('leaves an existing .vault extension alone', () => {
    expect(Storage.sanitizeFilename('my-backup.vault')).toBe('my-backup.vault');
  });

  test('trims surrounding whitespace', () => {
    expect(Storage.sanitizeFilename('  spaced-name  ')).toBe('spaced-name.vault');
  });

  test('falls back to a default name when empty or blank', () => {
    expect(Storage.sanitizeFilename('')).toBe('vault-backup.vault');
    expect(Storage.sanitizeFilename('   ')).toBe('vault-backup.vault');
  });

  test('replaces filesystem-illegal characters with underscores', () => {
    expect(Storage.sanitizeFilename('a/b\\c:d*e?f"g<h>i|j')).toBe('a_b_c_d_e_f_g_h_i_j.vault');
  });
});

describe('default export filenames', () => {
  test('defaultExportFilename produces a timestamped .vault filename', () => {
    const name = Storage.defaultExportFilename();
    expect(name).toMatch(/^vault-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.vault$/);
  });

  test('defaultExportCsvFilename produces a timestamped .csv filename', () => {
    const name = Storage.defaultExportCsvFilename();
    expect(name).toMatch(/^vault-export-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.csv$/);
  });
});

describe('supportsSaveLocationPicker', () => {
  test('returns false when showSaveFilePicker is not defined', () => {
    delete window.showSaveFilePicker;
    expect(Storage.supportsSaveLocationPicker()).toBe(false);
  });

  test('returns true when showSaveFilePicker is a function', () => {
    window.showSaveFilePicker = () => {};
    expect(Storage.supportsSaveLocationPicker()).toBe(true);
    delete window.showSaveFilePicker;
  });
});

describe('buildCsvContent', () => {
  test('writes the expected header row', () => {
    const csv = Storage.buildCsvContent([]);
    expect(csv).toBe('site,username,password,notes');
  });

  test('writes one row per entry in site,username,password,notes order', () => {
    const csv = Storage.buildCsvContent([
      { site: 'a.com', username: 'u1', password: 'p1', notes: 'n1' },
    ]);
    expect(csv).toBe('site,username,password,notes\na.com,u1,p1,n1');
  });

  test('quotes and escapes fields containing commas, quotes, or newlines', () => {
    const csv = Storage.buildCsvContent([
      {site: 'a,b', username: 'has "quotes"', password: 'line\nbreak', notes: '' },
    ]);
    const rows = csv.split('\n');
    // The embedded newline means the record itself spans an extra visual line,
    // but Papa-style CSV escaping keeps it as one logical field.
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('"has ""quotes"""');
    expect(csv).toContain('"line\nbreak"');
  });

  test('treats null/undefined fields as empty strings', () => {
    const csv = Storage.buildCsvContent([{ site: null, username: undefined, password: 'p', notes: null }]);
    expect(csv).toBe('site,username,password,notes\n,,p,');
  });
});

describe('buildExportContent', () => {
  test('throws if the vault is locked (no key or salt)', async () => {
    await expect(Storage.buildExportContent(null, null, [])).rejects.toThrow(/Vault is locked/);
    await expect(Storage.buildExportContent('key', null, [])).rejects.toThrow(/Vault is locked/);
    await expect(Storage.buildExportContent(null, 'salt', [])).rejects.toThrow(/Vault is locked/);
  });

  test('encrypts a payload containing the entries and an exportedAt timestamp', async () => {
    const entries = [{ id: '1', site: 'a.com' }];
    const json = await Storage.buildExportContent('key', 'salt', entries);
    const parsed = JSON.parse(json);

    expect(parsed.version).toBe(2);
    expect(VaultCrypto.encryptWithKey).toHaveBeenCalledWith(
      'key',
      'salt',
      expect.objectContaining({ entries, exportedAt: expect.any(String) })
    );
  });
});

describe('parseBackupFile', () => {
  function fakeFile(contents) {
    return { text: async () => contents };
  }

  test('rejects invalid JSON with a clear error', async () => {
    await expect(Storage.parseBackupFile(fakeFile('not json'), 'correct')).rejects.toThrow(
      /Invalid backup file/
    );
  });

  test('decrypts valid JSON and normalizes each entry via a supplied normalizeEntry callback', async () => {
    const normalizeEntry = (raw) => ({ ...raw, normalized: true });
    const entries = await Storage.parseBackupFile(fakeFile('{"version":2}'), 'correct', normalizeEntry);
    expect(entries).toEqual([{ id: '1', site: 'a.com', normalized: true }]);
  });

  test('defaults to identity normalization when no normalizeEntry callback is passed', async () => {
    const entries = await Storage.parseBackupFile(fakeFile('{"version":2}'), 'correct');
    expect(entries).toEqual([{ id: '1', site: 'a.com' }]);
  });

  test('does not reference any global Vault object', async () => {
    // Guards against the old implicit coupling regressing: parseBackupFile
    // must work even when no `Vault` global exists at all.
    expect(typeof window.Vault).toBe('undefined');
    const entries = await Storage.parseBackupFile(fakeFile('{"version":2}'), 'correct', (r) => r);
    expect(entries).toEqual([{ id: '1', site: 'a.com' }]);
  });

  test('propagates the decrypt error for a wrong password', async () => {
    await expect(Storage.parseBackupFile(fakeFile('{"version":2}'), 'wrong')).rejects.toThrow(
      /Incorrect master password/
    );
  });
});

describe('parseCsvEntries', () => {
  test('parses a simple header + rows CSV, skipping the header', () => {
    const csv = 'site,username,password,notes\na.com,u1,p1,n1\nb.com,u2,p2,';
    const { entries, skipped } = Storage.parseCsvEntries(csv);

    expect(skipped).toBe(0);
    expect(entries).toEqual([
      { site: 'a.com', username: 'u1', password: 'p1', notes: 'n1' },
      { site: 'b.com', username: 'u2', password: 'p2', notes: '' },
    ]);
  });

  test('header detection is case-insensitive and tolerates surrounding whitespace', () => {
    const csv = ' Site , Username , Password , Notes \na.com,u1,p1,n1';
    const { entries, skipped } = Storage.parseCsvEntries(csv);

    expect(skipped).toBe(0);
    expect(entries).toEqual([{ site: 'a.com', username: 'u1', password: 'p1', notes: 'n1' }]);
  });

  test('works without a header row (first row treated as data)', () => {
    const csv = 'a.com,u1,p1,n1';
    const { entries, skipped } = Storage.parseCsvEntries(csv);

    expect(skipped).toBe(0);
    expect(entries).toEqual([{ site: 'a.com', username: 'u1', password: 'p1', notes: 'n1' }]);
  });

  test('round-trips a value produced by buildCsvContent, including quoted fields', () => {
    const original = [
      { site: 'a,b', username: 'has "quotes"', password: 'line\nbreak', notes: 'plain' },
    ];
    const csv = Storage.buildCsvContent(original);
    const { entries, skipped } = Storage.parseCsvEntries(csv);

    expect(skipped).toBe(0);
    expect(entries).toEqual(original);
  });

  test('every row becomes its own entry — duplicates are not merged or deduplicated', () => {
    const csv = 'a.com,u,p1,\na.com,u,p2,';
    const { entries, skipped } = Storage.parseCsvEntries(csv);

    expect(skipped).toBe(0);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.password)).toEqual(['p1', 'p2']);
  });

  test('skips and counts rows missing a required field (site or password)', () => {
    const csv = ',u1,p1,n1\na.com,u2,,n2\nb.com,u3,p3,n3';
    const { entries, skipped } = Storage.parseCsvEntries(csv);

    expect(skipped).toBe(2);
    expect(entries).toEqual([{ site: 'b.com', username: 'u3', password: 'p3', notes: 'n3' }]);
  });

  test('skips and counts rows with the wrong number of columns', () => {
    const csv = 'a.com,u1,p1\nb.com,u2,p2,n2,extra\nc.com,u3,p3,n3';
    const { entries, skipped } = Storage.parseCsvEntries(csv);

    expect(skipped).toBe(2);
    expect(entries).toEqual([{ site: 'c.com', username: 'u3', password: 'p3', notes: 'n3' }]);
  });

  test('ignores a trailing blank line without counting it as skipped', () => {
    const csv = 'a.com,u1,p1,n1\n';
    const { entries, skipped } = Storage.parseCsvEntries(csv);

    expect(skipped).toBe(0);
    expect(entries).toEqual([{ site: 'a.com', username: 'u1', password: 'p1', notes: 'n1' }]);
  });

  test('trims leading/trailing whitespace from the password field, preserving internal whitespace, and requires it to be non-blank', () => {
    const csv = 'a.com,u1,  padded pw  ,n1\nb.com,u2,\t \t,n2';
    const { entries, skipped } = Storage.parseCsvEntries(csv);

    expect(skipped).toBe(1);
    expect(entries).toEqual([{ site: 'a.com', username: 'u1', password: 'padded pw', notes: 'n1' }]);
  });

  test('returns no entries and no skipped count for an empty string', () => {
    expect(Storage.parseCsvEntries('')).toEqual({ entries: [], skipped: 0 });
  });

  test('round-trips a notes field containing a comma (quoted on export, un-quoted on import)', () => {
    const original = [{ site: 'a.com', username: 'u', password: 'p', notes: 'call center, ext. 204' }];
    const csv = Storage.buildCsvContent(original);

    // the comma in notes means that field must be quoted in the raw CSV
    expect(csv).toBe('site,username,password,notes\na.com,u,p,"call center, ext. 204"');

    const { entries, skipped } = Storage.parseCsvEntries(csv);
    expect(skipped).toBe(0);
    expect(entries).toEqual(original);
  });

  test('rejects a row whose password contains a comma, even if properly quoted in the CSV', () => {
    // The CSV parser can extract a quoted comma just fine — this exercises
    // that the app-level rule (no commas in passwords) still rejects it.
    const csv = 'a.com,u1,"pass,word",n1\nb.com,u2,okpw,n2';
    const { entries, skipped } = Storage.parseCsvEntries(csv);

    expect(skipped).toBe(1);
    expect(entries).toEqual([{ site: 'b.com', username: 'u2', password: 'okpw', notes: 'n2' }]);
  });
});

describe('parseCsvFile', () => {
  function fakeFile(contents) {
    return { text: async () => contents };
  }

  test('reads the file and delegates to parseCsvEntries', async () => {
    const result = await Storage.parseCsvFile(fakeFile('site,username,password,notes\na.com,u1,p1,n1'));
    expect(result).toEqual({ entries: [{ site: 'a.com', username: 'u1', password: 'p1', notes: 'n1' }], skipped: 0 });
  });
});

describe('downloadBackup / downloadCsv', () => {
  let clickSpy;
  let createObjectURLSpy;
  let revokeObjectURLSpy;

  beforeEach(() => {
    clickSpy = jest.fn();
    HTMLAnchorElement.prototype.click = clickSpy;
    createObjectURLSpy = jest.fn(() => 'blob:mock-url');
    revokeObjectURLSpy = jest.fn();
    global.URL.createObjectURL = createObjectURLSpy;
    global.URL.revokeObjectURL = revokeObjectURLSpy;
  });

  test('downloadBackup creates a blob URL, clicks an anchor, then revokes it', () => {
    Storage.downloadBackup('{"a":1}', 'backup.vault');
    expect(createObjectURLSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:mock-url');
  });

  test('downloadCsv uses a text/csv blob', () => {
    Storage.downloadCsv('a,b\n1,2', 'export.csv');
    const blobArg = createObjectURLSpy.mock.calls[0][0];
    expect(blobArg.type).toBe('text/csv');
  });
});
