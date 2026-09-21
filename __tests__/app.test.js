/** @jest-environment jsdom */

const fs = require('fs');
const path = require('path');

jest.setTimeout(10000);

// ---- Read sources once (not per test) -------------------------------------
const read = (f) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
const SRC = {
  html: read('index.html'),
  scripts: [
    read('vault.js').replace(/const\s+Vault\s*=\s*/, 'window.Vault = '),
    // avoid clashing with the browser's built-in Storage interface
    read('storage.js').replace(/const\s+Storage\s*=\s*/, 'window.Storage = '),
    read('ui.js').replace(/const\s+UI\s*=\s*/, 'window.UI = '),
    read('app.js'),
  ],
};

// ---- Small helpers --------------------------------------------------------
const $ = (id) => document.getElementById(id);
// In fake-timer mode setTimeout never fires, so settle via microtasks instead
// (the mocked crypto only needs microtasks).
let fakeMode = false;
const microflush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const tick = (ms = 0) => (fakeMode ? microflush() : new Promise((r) => setTimeout(r, ms)));
const setVal = (id, v) => { $(id).value = v; };
const submit = (id) => $(id).dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
const cards = () => Array.from(document.querySelectorAll('.entry-card'));
const siteNames = () => cards().map((c) => c.querySelector('.entry-site').textContent.trim());
const isHidden = (id) => $(id).classList.contains('hidden');
const isActive = (id) => $(id).classList.contains('active');

// Poll a condition instead of sleeping a fixed time.
async function waitFor(cond, timeout = 2000) {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeout) await tick(2);
  return cond();
}

describe('Vault app basic flows', () => {
  let toasts;

  beforeEach(() => {
    document.documentElement.innerHTML = SRC.html;

    window.VaultCrypto = {
      isAvailable: () => true,
      MIN_MASTER_PASSWORD_LENGTH: 4,
      createSession: async () => ({ sessionSalt: 'salt', cryptoKey: 'key', verifier: 'ver' }),
      unlockSession: async () => 'key',
      encryptWithKey: async () => ({ version: 2, algorithm: 'AES-GCM', kdf: 'PBKDF2', iterations: 1, salt: 's', iv: 'i', ciphertext: 'c' }),
      encrypt: async () => ({ version: 1, algorithm: 'AES-GCM', kdf: 'PBKDF2', iterations: 1, salt: 's', iv: 'i', ciphertext: 'c' }),
      decrypt: async () => ({ data: { entries: [] }, sessionSalt: 'salt' }),
      scorePassword: () => ({ score: 4, label: 'Good', className: 'strength-good' }),
      generatePassword: () => 'TestPassword123!',
      generateId: (() => { let i = 1; return () => `id-${i++}`; })(),
    };

    // jsdom lacks File.text(); polyfill via FileReader.
    if (!File.prototype.text) {
      File.prototype.text = function () {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsText(this);
        });
      };
    }

    // jsdom may lack <dialog> support.
    if (!HTMLDialogElement.prototype.showModal) {
      HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
      HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    }

    global.URL.createObjectURL = jest.fn(() => 'blob:mock');
    global.URL.revokeObjectURL = jest.fn();
    HTMLAnchorElement.prototype.click = function () {
      this._clicked = { href: this.href, download: this.download };
    };

    SRC.scripts.forEach((code) => {
      const s = document.createElement('script');
      s.textContent = code;
      document.body.appendChild(s);
    });

    // Record every toast synchronously. The real toast queue shows them one at
    // a time (3-8s each), so asserting on the DOM forced tests to wait it out.
    toasts = [];
    const realShowToast = window.UI.showToast;
    window.UI.showToast = (msg, type) => {
      toasts.push({ msg, type });
      return realShowToast.call(window.UI, msg, type);
    };
  });

  afterEach(() => {
    fakeMode = false;
    jest.useRealTimers();
  });

  // Fake timers from the very start of a test, so the real toast queue can be
  // stepped through deterministically (no 3-8s real waits).
  const useFakeTimers = () => { jest.useFakeTimers(); fakeMode = true; };

  // Steps time forward and records the text of every toast the *real* toast
  // UI shows, in order (a toast counts as new when the DOM goes hidden -> visible).
  function drainToasts(totalMs = 60000, step = 25) {
    const shown = [];
    let wasVisible = false;
    for (let t = 0; t < totalMs; t += step) {
      const visible = !isHidden('toast');
      if (visible && !wasVisible) shown.push($('toast').textContent);
      wasVisible = visible;
      jest.advanceTimersByTime(step);
    }
    return shown;
  }

  const findToast = (re) => toasts.find((t) => re.test(t.msg));
  const expectToast = (re, type) => {
    const t = findToast(re);
    expect(t).toBeTruthy();
    if (type) expect(t.type).toBe(type);
    return t.msg;
  };

  async function createVault(pw = 'abcd', confirm = pw) {
    $('create-vault-btn').click();
    setVal('create-password', pw);
    setVal('create-password-confirm', confirm);
    submit('create-form');
    await tick();
  }

  async function addEntry({ site = 'example.com', username = '', password = 'pw', notes = '' } = {}) {
    $('add-btn').click();
    setVal('entry-site', site);
    setVal('entry-username', username);
    setVal('entry-password', password);
    setVal('entry-notes', notes);
    submit('entry-form');
    await tick();
  }

  async function exportBackup() {
    $('export-btn').click();
    setVal('export-filename', 'test-backup');
    document.querySelector('#export-form button[type="submit"]').click();
    await waitFor(() => findToast(/Backup downloaded/));
  }

  async function exportCsv() {
    $('export-csv-btn').click();
    $('confirm-export-csv').click();
    await waitFor(() => findToast(/CSV exported/));
  }

  function setFile(inputId, file) {
    Object.defineProperty($(inputId), 'files', { value: [file], configurable: true });
  }

  async function importCsvText(csv) {
    setFile('merge-csv-file', new File([csv], 'export.csv', { type: 'text/csv' }));
    $('merge-csv-file').dispatchEvent(new Event('change', { bubbles: true }));
    await waitFor(() => findToast(/CSV import complete|CSV file had no|Failed/));
  }

  // ---- Vault creation -----------------------------------------------------
  test('create vault shows vault screen', async () => {
    await createVault();
    expect(isActive('vault-screen')).toBe(true);
    expect(isActive('welcome-screen')).toBe(false);
  });

  test.each([
    ['a too-short password', 'ab', 'ab', /at least 4 characters/],
    ['mismatched confirmation', 'abcd', 'different', /do not match/],
  ])('create vault rejects %s', async (_, pw, confirm, msg) => {
    await createVault(pw, confirm);
    expect($('create-error').classList.contains('hidden')).toBe(false);
    expect($('create-error').textContent).toMatch(msg);
    expect(isActive('vault-screen')).toBe(false);
  });

  // ---- Entry CRUD & validation -------------------------------------------
  test('add, edit, delete entry flows', async () => {
    await createVault();
    await addEntry({ site: 'example.com', username: 'user@example.com', password: 'pw1234' });
    expect(siteNames()).toEqual(['example.com']);

    cards()[0].querySelector('.edit-btn').click();
    setVal('entry-site', 'changed.com');
    submit('entry-form');
    await tick();
    expect(siteNames()).toEqual(['changed.com']);

    document.querySelector('.delete-btn').click();
    submit('delete-form');
    await tick();
    expect(cards().length).toBe(0);
  });

  test('deleting an entry requires confirmation via the delete modal', async () => {
    await createVault();
    await addEntry();

    document.querySelector('.delete-btn').click();
    $('delete-cancel').click();
    expect(cards().length).toBe(1);

    document.querySelector('.delete-btn').click();
    submit('delete-form');
    await tick();
    expect(cards().length).toBe(0);
  });

  test('adding an entry with no site or password shows validation errors', async () => {
    await createVault();

    await addEntry({ site: '', password: 'somepassword' });
    expect($('entry-error').classList.contains('hidden')).toBe(false);
    expect($('entry-error').textContent).toMatch(/Site \/ service name is required/);
    expect(cards().length).toBe(0);

    setVal('entry-site', 'example.com');
    setVal('entry-password', '');
    submit('entry-form');
    await tick();
    expect($('entry-error').textContent).toMatch(/Password is required/);
    expect(cards().length).toBe(0);
  });

  test('the entry form rejects a password containing a comma', async () => {
    await createVault();
    await addEntry({ password: 'pass,word' });
    expect($('entry-error').classList.contains('hidden')).toBe(false);
    expect($('entry-error').textContent).toMatch(/Password cannot contain a comma/);
    expect(cards().length).toBe(0);

    setVal('entry-password', 'passwordok');
    submit('entry-form');
    await tick();
    expect(cards().length).toBe(1);
  });

  test('the entry form rejects leading/trailing space/tab passwords, for add and edit', async () => {
    await createVault();

    for (const bad of [' leadingspace', 'trailingtab\t']) {
      await addEntry({ password: bad });
      expect($('entry-error').classList.contains('hidden')).toBe(false);
      expect($('entry-error').textContent).toMatch(/cannot start or end with a space or tab/);
      expect(cards().length).toBe(0);
    }

    setVal('entry-password', 'valid password'); // internal space is fine
    submit('entry-form');
    await tick();
    expect(cards().length).toBe(1);

    document.querySelector('.edit-btn').click();
    setVal('entry-password', '  bad-edit  ');
    submit('entry-form');
    await tick();
    expect($('entry-error').textContent).toMatch(/cannot start or end with a space or tab/);
    expect(window.Vault.state.entries[0].password).toBe('valid password');
  });

  // ---- Lock / unlock ------------------------------------------------------
  test('re-unlocking with the wrong password shows an error and stays locked', async () => {
    await createVault();
    $('lock-btn').click();
    expect(isActive('unlock-screen')).toBe(true);

    window.VaultCrypto.unlockSession = async () => { throw new Error('Incorrect master password.'); };
    setVal('master-password', 'wrong-password');
    submit('unlock-form');
    await tick();

    expect($('unlock-error').classList.contains('hidden')).toBe(false);
    expect($('unlock-error').textContent).toMatch(/Incorrect master password/);
    expect(isActive('unlock-screen')).toBe(true);
    expect(isActive('vault-screen')).toBe(false);
  });

  test('re-unlocking with the correct password returns to the vault screen', async () => {
    await createVault();
    $('lock-btn').click();
    setVal('master-password', 'abcd');
    submit('unlock-form');
    await tick();

    expect(isActive('vault-screen')).toBe(true);
    expect(isActive('unlock-screen')).toBe(false);
  });

  // ---- Search / sort ------------------------------------------------------
  test('search filters the entry list and sort re-orders it', async () => {
    await createVault();
    for (const site of ['zebra.com', 'apple.com', 'mango.com']) await addEntry({ site });
    expect(cards().length).toBe(3);

    const search = $('search-input');
    search.value = 'apple';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(siteNames()).toEqual(['apple.com']);

    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    expect(siteNames()).toEqual(['apple.com', 'mango.com', 'zebra.com']);

    $('sort-select').value = 'site-desc';
    $('sort-select').dispatchEvent(new Event('change', { bubbles: true }));
    expect(siteNames()).toEqual(['zebra.com', 'mango.com', 'apple.com']);
  });

  test('search with no matches shows the "no entries match" empty state', async () => {
    await createVault();
    await addEntry();

    $('search-input').value = 'zzz-no-match';
    $('search-input').dispatchEvent(new Event('input', { bubbles: true }));

    expect(cards().length).toBe(0);
    expect(isHidden('empty-state')).toBe(false);
    expect($('empty-state').textContent).toMatch(/No entries match your search/);
  });

  // ---- Reveal / clipboard / generator ------------------------------------
  test('reveal button toggles a password between masked and plaintext', async () => {
    await createVault();
    await addEntry({ password: 'super-secret' });

    const btn = document.querySelector('.reveal-btn');
    const span = document.querySelector('.entry-password');

    expect(span.classList.contains('masked')).toBe(true);
    btn.click();
    expect(span.classList.contains('masked')).toBe(false);
    expect(span.textContent).toBe('super-secret');

    btn.click();
    expect(span.classList.contains('masked')).toBe(true);
    expect(span.textContent).toBe('••••••••');
  });

  test('copy-password button writes to the clipboard and shows a success toast', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await createVault();
    await addEntry({ password: 'copy-me' });

    document.querySelector('.copy-btn').click();
    await tick();

    expect(writeText).toHaveBeenCalledWith('copy-me');
    expect(writeText).toHaveBeenCalledTimes(1);
    expectToast(/Password copied to clipboard/, 'success');
  });

  test('rapid clipboard copies share a single clear timer keyed to the most recent copy', async () => {
    const writeText = jest.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    await createVault();
    await addEntry({ username: 'user@example.com', password: 'pw-secret' });
    const card = document.querySelector('.entry-card');

    jest.useFakeTimers();
    const flushMicro = async () => { for (let i = 0; i < 3; i++) await Promise.resolve(); };

    card.querySelector('.copy-btn').click(); // T+0
    await flushMicro();

    jest.advanceTimersByTime(5000);
    card.querySelector('.copy-user-btn').click(); // T+5s
    await flushMicro();

    expect(writeText).toHaveBeenCalledWith('pw-secret');
    expect(writeText).toHaveBeenCalledWith('user@example.com');

    // T+15s: a per-copy timer for the password would already have cleared.
    jest.advanceTimersByTime(10000);
    await flushMicro();
    expect(writeText).not.toHaveBeenCalledWith('');

    // T+20s: 15s after the most recent copy, cleared exactly once.
    jest.advanceTimersByTime(5000);
    await flushMicro();
    expect(writeText.mock.calls.filter((c) => c[0] === '')).toHaveLength(1);
  });

  test('generate-password button fills in the entry password field', async () => {
    await createVault();
    $('add-btn').click();
    $('generate-password').click();
    expect($('entry-password').value).toBe('TestPassword123!');
  });

  // ---- Unsaved banner & backup export ------------------------------------
  test('the unsaved-changes banner is separate from the toast queue and cleared by a backup export', async () => {
    await createVault();
    expect(isHidden('unsaved-banner')).toBe(true);

    for (const site of ['a.com', 'b.com', 'c.com']) await addEntry({ site });

    expect(isHidden('unsaved-banner')).toBe(false);
    expect($('unsaved-banner').textContent).toMatch(/Unsaved changes/);
    // Regression: the unsaved notice used to be a persistent *toast* that piled
    // up in the queue and blocked every "Entry added." behind it. Here we check
    // all three were issued; the DOM-level delivery check is in
    // 'toast queue integration' below.
    expect(toasts.filter((t) => /Entry added\./.test(t.msg))).toHaveLength(3);

    await exportBackup();
    expect(isHidden('unsaved-banner')).toBe(true);
  });

  test('export (download) creates a blob download', async () => {
    await createVault();
    await addEntry({ site: 'x.com', username: 'a@b', password: 'p' });
    await exportBackup();
    expect(global.URL.createObjectURL).toHaveBeenCalled();
  });

  test('export is blocked with an error toast when the vault was never unlocked', async () => {
    $('export-btn').click();
    expectToast(/Vault is locked\. Unlock to export\./, 'error');
    expect($('export-modal').hasAttribute('open')).toBe(false);
  });

  test('beforeunload still warns about unsaved changes while the vault is locked', async () => {
    await createVault();
    await addEntry();
    $('lock-btn').click();

    expect(window.Vault.state.unlocked).toBe(false);
    expect(isHidden('unsaved-banner')).toBe(false);

    const evt = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
  });

  // ---- CSV export ---------------------------------------------------------
  test('CSV export via the warning modal downloads a text/csv file', async () => {
    await createVault();
    await addEntry();

    $('export-csv-btn').click();
    expect($('export-csv-warning-modal').hasAttribute('open')).toBe(true);
    $('confirm-export-csv').click();
    await waitFor(() => findToast(/CSV exported/));

    const calls = global.URL.createObjectURL.mock.calls;
    expect(calls[calls.length - 1][0].type).toBe('text/csv');
  });

  test('CSV export does NOT clear the unsaved banner; only an encrypted backup export does', async () => {
    await createVault();
    await addEntry();
    expect(isHidden('unsaved-banner')).toBe(false);

    await exportCsv();
    expect(isHidden('unsaved-banner')).toBe(false);
    expect(window.Vault.state.hasExported).toBe(false);

    await exportBackup();
    expect(isHidden('unsaved-banner')).toBe(true);
    expect(window.Vault.state.hasExported).toBe(true);
  });

  // ---- Restore / merge ----------------------------------------------------
  test('restore from backup imports entries', async () => {
    const restored = [{ id: 'id-1', site: 'r.com', username: 'u', password: 'p' }];
    // File.text()-based parsing is stubbed; the rest of the app flow is real.
    window.Storage.parseBackupFile = async () => restored;

    $('restore-btn').click();
    setFile('restore-file', new File(['{}'], 'backup.vault', { type: 'application/json' }));
    setVal('restore-password', 'abcd');
    submit('restore-form');

    await waitFor(() => cards().length > 0);
    expect(siteNames()).toEqual(['r.com']);
    expect(isActive('vault-screen')).toBe(true);
  });

  describe('merge with backup', () => {
    beforeEach(async () => {
      await createVault();
      await addEntry({ site: 'merge.com', username: 'u', password: 'old' });
    });

    // File parsing/decryption is stubbed; the merge logic in app.js is real.
    async function submitMerge(importedEntries) {
      window.Storage.parseBackupFile = async () => importedEntries;
      $('merge-btn').click();
      setFile('merge-file', new File(['{}'], 'backup.vault', { type: 'application/json' }));
      setVal('merge-password', 'abcd');
      submit('merge-form');
    }
    const conflicting = { id: 'imp-1', site: 'merge.com', username: 'u', password: 'newpw' };

    test('a same site/username entry with a different password opens the conflict modal', async () => {
      await submitMerge([conflicting]);
      expect(await waitFor(() => $('conflict-modal').hasAttribute('open'))).toBe(true);
      expect(cards().length).toBe(1);
    });

    test('cancelling the conflict modal leaves the existing entry untouched', async () => {
      let seen;
      window.UI.showConflictModal = async (conflicts) => { seen = conflicts; return null; };

      await submitMerge([conflicting]);
      await waitFor(() => findToast(/Merge cancelled/));

      expect(seen).toHaveLength(1);
      expect(cards().length).toBe(1);
      expect(window.Vault.state.entries[0].password).toBe('old');
    });

    test('a non-conflicting entry is added and marks the vault unsaved', async () => {
      await exportBackup(); // start from a saved state
      expect(isHidden('unsaved-banner')).toBe(true);

      await submitMerge([{ id: 'imp-2', site: 'new.com', username: 'x', password: 'p' }]);
      await waitFor(() => findToast(/Merge complete/));

      expectToast(/^Merge complete: 1 added\.$/, 'success');
      expect(siteNames()).toEqual(['merge.com', 'new.com']);
      expect(isHidden('unsaved-banner')).toBe(false);
      expect($('merge-modal').hasAttribute('open')).toBe(false);
    });
  });

  // ---- CSV import ---------------------------------------------------------
  describe('CSV import', () => {
    beforeEach(() => createVault());

    // Seed directly (skips UI + its toasts).
    const seed = (...entries) => entries.forEach((e) => window.Vault.addEntry({ username: 'u', notes: '', ...e }));

    test('chevron opens the hidden file input directly (no modal, no password)', () => {
      const clickSpy = jest.spyOn($('merge-csv-file'), 'click');
      $('merge-csv-btn').click();
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect($('merge-modal').hasAttribute('open')).toBe(false);
    });

    test('adds valid rows as new entries and skips invalid ones', async () => {
      await importCsvText([
        'site,username,password,notes',
        'a.com,u1,p1,n1',
        'b.com,u2,p2,',
        ',missing-site,p3,', // invalid: no site
        'c.com,u4',          // invalid: wrong column count
      ].join('\n'));

      expect(siteNames()).toEqual(expect.arrayContaining(['a.com', 'b.com']));
      expect(cards().length).toBe(2);
      expectToast(/^CSV import complete: 2 added, 2 invalid skipped\.$/);
      expect(isHidden('unsaved-banner')).toBe(false);
      expect($('merge-csv-file').value).toBe(''); // reset so the same file can be re-picked
    });

    test('skips an exact duplicate', async () => {
      await addEntry({ site: 'dup.com', username: 'u', password: 'same-pw', notes: 'same note' });
      await importCsvText('dup.com,u,same-pw,same note');

      expect(cards().length).toBe(1);
      expectToast(/^CSV import complete: 1 duplicate skipped\.$/);
    });

    test('skips (and warns about) a password-only difference, keeping the existing password', async () => {
      await addEntry({ site: 'dup.com', username: 'u', password: 'existing-pw' });
      await importCsvText('dup.com,u,new-pw,');

      expect($('conflict-modal').hasAttribute('open')).toBe(false);
      expect(cards().length).toBe(1);
      expect(window.Vault.findEntry(cards()[0].dataset.id).password).toBe('existing-pw');
      expectToast(/^CSV import complete: 1 skipped \(password differs\)\.$/);
      expectToast(/^Password mismatch entries not imported: dup\.com\.$/, 'warning');
    });

    test('trims whitespace around the password instead of rejecting the row', async () => {
      await importCsvText('a.com,u1,  padded-pw  ,n1\nb.com,u2,\t\t,n2');

      expect(cards().length).toBe(1); // b.com is all-whitespace => invalid
      expect(window.Vault.findEntry(cards()[0].dataset.id).password).toBe('padded-pw');
      expectToast(/^CSV import complete: 1 added, 1 invalid skipped\.$/);
    });

    test('skips a row whose quoted password contains a comma as invalid', async () => {
      await importCsvText('a.com,u1,"pass,word",n1\nb.com,u2,okpw,n2');

      expect(siteNames()).toEqual(['b.com']);
      expectToast(/^CSV import complete: 1 added, 1 invalid skipped\.$/);
    });

    test('round-trips a notes field containing a comma', async () => {
      await importCsvText('a.com,u1,pw1,"call center, ext. 204"');

      expect(cards().length).toBe(1);
      expect(cards()[0].querySelector('.entry-notes').textContent).toBe('call center, ext. 204');
    });

    test('lists up to 3 mismatched sites and summarizes the rest', async () => {
      seed(
        { site: 'one.com', password: 'pw1' }, { site: 'two.com', password: 'pw2' },
        { site: 'three.com', password: 'pw3' }, { site: 'four.com', password: 'pw4' },
      );
      await importCsvText('one.com,u,new1,\ntwo.com,u,new2,\nthree.com,u,new3,\nfour.com,u,new4,');

      expectToast(/one\.com, two\.com, three\.com, and 1 more/, 'warning');
    });

    test('re-importing a previously exported CSV adds nothing (all exact duplicates)', async () => {
      await addEntry({ site: 'round-trip.com', username: 'u', password: 'pw', notes: 'n' });
      await importCsvText(window.Storage.buildCsvContent(window.Vault.state.entries));

      expect(cards().length).toBe(1);
      expectToast(/^CSV import complete: 1 duplicate skipped\.$/);
    });

    test('an all-invalid CSV adds nothing and does not mark unsaved', async () => {
      await importCsvText(',no-site,,');

      expect(cards().length).toBe(0);
      expectToast(/^CSV import complete: 1 invalid skipped\.$/);
      expect(isHidden('unsaved-banner')).toBe(true);
    });

    describe('skip warnings', () => {
      test('invalid row', async () => {
        await importCsvText('a.com,u1,p1,n1\n,no-site,pw,');
        expectToast(/^Skipped 1 invalid row during CSV import\.$/, 'warning');
        expect(cards().length).toBe(1);
      });

      test('exact duplicate', async () => {
        seed({ site: 'dup.com', password: 'same-pw', notes: 'n' });
        await importCsvText('dup.com,u,same-pw,n');
        expectToast(/^Skipped 1 duplicate during CSV import\.$/, 'warning');
      });

      test('duplicates and invalid rows combine with correct pluralization', async () => {
        seed({ site: 'one.com', password: 'pw1' }, { site: 'two.com', password: 'pw2' });
        await importCsvText([
          'one.com,u,pw1,', 'two.com,u,pw2,', // exact duplicates
          ',no-site,pw,', 'bad.com,u,',       // invalid
          'new.com,u,pw3,',                   // added
        ].join('\n'));

        expectToast(/^Skipped 2 duplicates and 2 invalid rows during CSV import\.$/, 'warning');
        expect(cards().length).toBe(3);
      });

      test('no skip warning when every row is imported', async () => {
        await importCsvText('a.com,u1,p1,n1\nb.com,u2,p2,n2');
        expectToast(/^CSV import complete: 2 added\.$/);
        expect(toasts.some((t) => t.type === 'warning')).toBe(false);
      });

      test('a password mismatch is not repeated in the generic skip warning', async () => {
        seed({ site: 'mismatch.com', password: 'old-pw' }, { site: 'dup.com', password: 'same-pw' });
        await importCsvText('mismatch.com,u,new-pw,\ndup.com,u,same-pw,');

        expectToast(/Password mismatch entries not imported.*mismatch\.com/);
        const generic = expectToast(/^Skipped 1 duplicate during CSV import\.$/);
        expect(generic).not.toMatch(/mismatch/);
      });
    });
  });

  // ---- Toast queue integration (app.js -> real UI toast DOM) -------------
  describe('toast queue integration', () => {
    test('every toast is delivered in order while the unsaved banner is up', async () => {
      useFakeTimers();
      await createVault();
      for (const site of ['a.com', 'b.com', 'c.com']) await addEntry({ site });
      expect(isHidden('unsaved-banner')).toBe(false);

      const shown = drainToasts();

      expect(shown).toEqual(toasts.map((t) => t.msg));
      expect(shown.filter((m) => /Entry added\./.test(m))).toHaveLength(3);
      expect(isHidden('toast')).toBe(true);            // queue fully drained, nothing stuck
      expect(isHidden('unsaved-banner')).toBe(false);  // banner persists independently
    });

    test('the "copied to clipboard" toast surfaces despite the unsaved banner, and the clipboard is cleared', async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.assign(navigator, { clipboard: { writeText } });

      useFakeTimers();
      await createVault();
      await addEntry({ password: 'copy-me' });
      document.querySelector('.copy-btn').click();
      await tick();

      const shown = drainToasts();

      expect(shown).toContain('Password copied to clipboard.');
      expect(writeText).toHaveBeenCalledWith('copy-me');
      expect(writeText).toHaveBeenLastCalledWith(''); // 15s clear timer fired
    });
  });

  // ---- Toast durations (real UI toast queue, fake timers) ----------------
  describe('toast durations', () => {
    const visible = () => !$('toast').classList.contains('hidden');

    test.each([
      ['info', 3000],
      ['success', 3000],
      ['not-a-real-type', 3000], // unknown types fall back to the default
      ['warning', 7000],
      ['error', 8000],
    ])('%s toast auto-dismisses after about %dms', (type, ms) => {
      jest.useFakeTimers();
      window.UI.showToast('msg', type);
      expect(visible()).toBe(true);
      if (['warning', 'error', 'info', 'success'].includes(type)) {
        expect($('toast').className).toContain(`toast-${type}`);
      }

      jest.advanceTimersByTime(ms - 100);
      expect(visible()).toBe(true);
      jest.advanceTimersByTime(200);
      expect(visible()).toBe(false);
    });

    test('a long-lived warning toast delays the next queued toast until it has finished', () => {
      jest.useFakeTimers();
      window.UI.showToast('first: warning', 'warning');
      window.UI.showToast('second: info', 'info');

      jest.advanceTimersByTime(6900);
      expect($('toast').textContent).toBe('first: warning');

      jest.advanceTimersByTime(300); // dismiss at 7s, next shown 50ms later
      expect($('toast').textContent).toBe('second: info');
      expect($('toast').className).toContain('toast-info');
    });
  });
});
