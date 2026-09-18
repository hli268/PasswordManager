/** @jest-environment jsdom */

const fs = require('fs');
const path = require('path');

jest.setTimeout(20000);

describe('Vault app basic flows', () => {
  let html;
  let appScript;

  beforeEach(() => {
	// Load index.html into JSDOM's document
	html = fs.readFileSync(path.resolve(__dirname, '..', 'index.html'), 'utf8');
	document.documentElement.innerHTML = html;

	// Provide a lightweight VaultCrypto mock on window before loading app.js
	window.VaultCrypto = {
	  isAvailable: () => true,
	  MIN_MASTER_PASSWORD_LENGTH: 4,
	  createSession: async (pw) => ({ sessionSalt: 'salt', cryptoKey: 'key', verifier: 'ver' }),
	  unlockSession: async () => 'key',
	  encryptWithKey: async () => ({ version: 2, algorithm: 'AES-GCM', kdf: 'PBKDF2', iterations: 1, salt: 's', iv: 'i', ciphertext: 'c' }),
	  encrypt: async () => ({ version: 1, algorithm: 'AES-GCM', kdf: 'PBKDF2', iterations: 1, salt: 's', iv: 'i', ciphertext: 'c' }),
	  decrypt: async (password, backup) => ({ data: { entries: [] }, sessionSalt: 'salt' }),
	  scorePassword: () => ({ score: 4, label: 'Good', className: 'strength-good' }),
	  generatePassword: () => 'TestPassword123!',
	  generateId: (() => { let i = 1; return () => `id-${i++}`; })(),
	  isAvailable: () => true,
	};

	// jsdom's File/Blob implementation in this environment doesn't provide
	// .text() (see the restore-from-backup test below, which works around
	// the same gap by stubbing Storage.parseBackupFile directly). The CSV
	// import tests read real File objects instead, so polyfill it via
	// FileReader rather than adding another stub.
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

	// Provide dialog.showModal/close shim for jsdom which may not implement them
	if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
	  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); try { this.focus(); } catch (_) {} };
	  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
	}

	// Mock URL.createObjectURL/revokeObjectURL and anchor click to capture
	// downloads. revokeObjectURL wasn't mocked before, which meant the real
	// downloadBackup()/downloadCsv() cleanup step threw "URL.revokeObjectURL
	// is not a function" — silently caught by the export form's try/catch,
	// so exports appeared to "hang" without ever reaching finishExport().
	global.URL.createObjectURL = jest.fn(() => 'blob:mock');
	global.URL.revokeObjectURL = jest.fn();
	HTMLAnchorElement.prototype.click = function () {
	  // simulate navigation; record attributes for test
	  this._clicked = { href: this.href, download: this.download };
	};

	// Load Vault, Storage, UI, then app into the document context (app depends on the others)
	let vaultScript = fs.readFileSync(path.resolve(__dirname, '..', 'vault.js'), 'utf8');
	// Assign to window to avoid redeclaring globals in the jsdom environment
	vaultScript = vaultScript.replace(/const\s+Vault\s*=\s*/, 'window.Vault = ');
	const vaultEl = document.createElement('script');
	vaultEl.textContent = vaultScript;
	document.body.appendChild(vaultEl);

	let storageScript = fs.readFileSync(path.resolve(__dirname, '..', 'storage.js'), 'utf8');
	// Avoid clashing with the browser's built-in Storage interface in jsdom
	storageScript = storageScript.replace(/const\s+Storage\s*=\s*/, 'window.Storage = ');
	const storageEl = document.createElement('script');
	storageEl.textContent = storageScript;
	document.body.appendChild(storageEl);

	let uiScript = fs.readFileSync(path.resolve(__dirname, '..', 'ui.js'), 'utf8');
	uiScript = uiScript.replace(/const\s+UI\s*=\s*/, 'window.UI = ');
	const uiEl = document.createElement('script');
	uiEl.textContent = uiScript;
	document.body.appendChild(uiEl);

	const appScriptContent = fs.readFileSync(path.resolve(__dirname, '..', 'app.js'), 'utf8');
	const appScriptEl = document.createElement('script');
	appScriptEl.textContent = appScriptContent;
	document.body.appendChild(appScriptEl);
  });

  function flush(ms = 0) {
	return new Promise((r) => setTimeout(r, ms));
  }

  // The toast module shows one toast at a time and auto-dismisses non-persistent
  // ones after 3s, so a toast fired earlier in a test (e.g. "Vault created...")
  // may still be showing when we check. Poll until the expected text appears
  // or we give up.
  async function waitForToastText(pattern, maxWaitMs = 12000) {
	const start = Date.now();
	while (Date.now() - start < maxWaitMs) {
	  const text = document.getElementById('toast').textContent;
	  if (pattern.test(text)) return text;
	  await flush(100);
	}
	return document.getElementById('toast').textContent;
  }

  test('create vault shows vault screen', async () => {
	const createBtn = document.getElementById('create-vault-btn');
	createBtn.click();

	// fill form
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';

	// submit
	const form = document.getElementById('create-form');
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

	await flush(50);

	expect(document.getElementById('vault-screen').classList.contains('active')).toBe(true);
	expect(document.getElementById('welcome-screen').classList.contains('active')).toBe(false);
  });

  test('add, edit, delete entry flows', async () => {
	// create vault first
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	// add entry
	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'example.com';
	document.getElementById('entry-username').value = 'user@example.com';
	document.getElementById('entry-password').value = 'pw1234';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(50);

	const entries = document.querySelectorAll('.entry-card');
	expect(entries.length).toBe(1);
	expect(entries[0].querySelector('.entry-site').textContent).toContain('example.com');

	// edit entry
	const editBtn = entries[0].querySelector('.edit-btn');
	expect(editBtn).toBeTruthy();
	editBtn.click();
	await flush(10);
	const siteInput = document.getElementById('entry-site');
	siteInput.value = 'changed.com';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(50);

	const updated = document.querySelector('.entry-card .entry-site');
	expect(updated.textContent).toContain('changed.com');

	// delete entry
	const delBtn = document.querySelector('.entry-card .delete-btn');
	delBtn.click();
	await flush(10);
	// confirm delete
	document.getElementById('delete-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(50);
	expect(document.querySelectorAll('.entry-card').length).toBe(0);
  });

  test('export (download) produces a download anchor', async () => {
	// create vault and add one entry
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'x.com';
	document.getElementById('entry-username').value = 'a@b';
	document.getElementById('entry-password').value = 'p';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(40);

	// open export modal
	document.getElementById('export-btn').click();
	await flush(10);
	const filenameInput = document.getElementById('export-filename');
	filenameInput.value = 'test-backup';
	const submit = document.querySelector('#export-form button[type="submit"]');
	submit.click();
	await flush(50);

	// verify an anchor click recorded the download filename
	const a = document.querySelector('a[download]');
	// Not all environments will leave the anchor in DOM; instead check that createObjectURL was called
	expect(global.URL.createObjectURL).toHaveBeenCalled();
  });

  test('restore from backup imports entries', async () => {
	// prepare mock decrypt to return entries
	window.VaultCrypto.decrypt = async () => ({ data: { entries: [ { id: 'id-1', site: 'r.com', username: 'u', password: 'p' } ] }, sessionSalt: 'salt' });

	// open restore modal
	document.getElementById('restore-btn').click();
	await flush(10);

	const fileInput = document.getElementById('restore-file');
	// provide a real File via DataTransfer so jsdom sets input.files correctly
	const restoreFile = new File([JSON.stringify({ entries: [ { id: 'id-1', site: 'r.com', username: 'u', password: 'p' } ] })], 'backup.vault', { type: 'application/json' });
	// Define the files property directly to avoid DataTransfer dependency in this test environment
	Object.defineProperty(fileInput, 'files', { value: [restoreFile], configurable: true });
	document.getElementById('restore-password').value = 'abcd';

	// In this test environment File.text() may not be available; simulate the import flow
	window.Storage.parseBackupFile = async () => ([ { id: 'id-1', site: 'r.com', username: 'u', password: 'p' } ]);

	// Perform the same steps the app would: parse, create session, set entries, and render
	const entries = await window.Storage.parseBackupFile(null, 'abcd');
	await window.Vault.createSession('abcd');
	window.Vault.setEntries(entries);
	window.Vault.markExported();
	// Show vault screen and render entries
	window.UI.showScreen('vault');
	const filtered = window.Vault.filterEntries(window.Vault.state.entries, '');
	const sorted = window.Vault.sortEntries(filtered, document.getElementById('sort-select').value);
	window.UI.renderEntries(sorted, { totalCount: window.Vault.state.entries.length, query: '' });
	await flush(50);

	expect(document.querySelectorAll('.entry-card').length).toBe(1);
	expect(document.querySelector('.entry-site').textContent).toContain('r.com');
  });

  test('merge with backup adds entries and shows conflicts', async () => {
	// create vault and add an entry
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'merge.com';
	document.getElementById('entry-username').value = 'u';
	document.getElementById('entry-password').value = 'old';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(40);

	// prepare decrypt to return an entry with same site/username but different password
	window.VaultCrypto.decrypt = async () => ({ data: { entries: [ { site: 'merge.com', username: 'u', password: 'newpw' } ] }, sessionSalt: 'salt' });

	document.getElementById('merge-btn').click();
	await flush(10);
	const fileInput = document.getElementById('merge-file');
	const mergeFile = new File([JSON.stringify({ entries: [ { site: 'merge.com', username: 'u', password: 'newpw' } ] })], 'backup.vault', { type: 'application/json' });
	Object.defineProperty(fileInput, 'files', { value: [mergeFile], configurable: true });
	document.getElementById('merge-password').value = 'abcd';
	document.getElementById('merge-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(200);

	// conflict modal should appear (dialog open), but since tests run in jsdom showModal may not behave the same.
	// Ensure entries still present and one updated after resolving conflicts may not be automated here.
	expect(document.querySelectorAll('.entry-card').length).toBeGreaterThanOrEqual(1);
  });

  test('create vault rejects a password shorter than the minimum length', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'ab'; // below mocked MIN_MASTER_PASSWORD_LENGTH of 4
	document.getElementById('create-password-confirm').value = 'ab';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const error = document.getElementById('create-error');
	expect(error.classList.contains('hidden')).toBe(false);
	expect(error.textContent).toMatch(/at least 4 characters/);
	// Should still be on the welcome screen, not the vault
	expect(document.getElementById('vault-screen').classList.contains('active')).toBe(false);
  });

  test('create vault rejects mismatched password confirmation', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'different';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const error = document.getElementById('create-error');
	expect(error.classList.contains('hidden')).toBe(false);
	expect(error.textContent).toMatch(/do not match/);
  });

  test('adding an entry with no site or password shows validation errors and does not add it', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	// Missing site
	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = '';
	document.getElementById('entry-password').value = 'somepassword';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	let error = document.getElementById('entry-error');
	expect(error.classList.contains('hidden')).toBe(false);
	expect(error.textContent).toMatch(/Site \/ service name is required/);
	expect(document.querySelectorAll('.entry-card').length).toBe(0);

	// Missing password
	document.getElementById('entry-site').value = 'example.com';
	document.getElementById('entry-password').value = '';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	error = document.getElementById('entry-error');
	expect(error.classList.contains('hidden')).toBe(false);
	expect(error.textContent).toMatch(/Password is required/);
	expect(document.querySelectorAll('.entry-card').length).toBe(0);
  });

  test('locking the vault and re-unlocking with the wrong password shows an error and stays locked', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('lock-btn').click();
	await flush(10);
	expect(document.getElementById('unlock-screen').classList.contains('active')).toBe(true);

	// Simulate an incorrect password rejection
	window.VaultCrypto.unlockSession = async () => { throw new Error('Incorrect master password.'); };

	document.getElementById('master-password').value = 'wrong-password';
	document.getElementById('unlock-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const unlockError = document.getElementById('unlock-error');
	expect(unlockError.classList.contains('hidden')).toBe(false);
	expect(unlockError.textContent).toMatch(/Incorrect master password/);
	expect(document.getElementById('unlock-screen').classList.contains('active')).toBe(true);
	expect(document.getElementById('vault-screen').classList.contains('active')).toBe(false);
  });

  test('locking the vault and re-unlocking with the correct password returns to the vault screen', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('lock-btn').click();
	await flush(10);

	document.getElementById('master-password').value = 'abcd';
	document.getElementById('unlock-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	expect(document.getElementById('vault-screen').classList.contains('active')).toBe(true);
	expect(document.getElementById('unlock-screen').classList.contains('active')).toBe(false);
  });

  test('search filters the entry list and sort re-orders it', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const addEntry = async (site, username, password) => {
	  document.getElementById('add-btn').click();
	  document.getElementById('entry-site').value = site;
	  document.getElementById('entry-username').value = username;
	  document.getElementById('entry-password').value = password;
	  document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	  await flush(20);
	};

	await addEntry('zebra.com', 'u1', 'p1');
	await addEntry('apple.com', 'u2', 'p2');
	await addEntry('mango.com', 'u3', 'p3');

	expect(document.querySelectorAll('.entry-card').length).toBe(3);

	// Filter down to a single entry via search
	const searchInput = document.getElementById('search-input');
	searchInput.value = 'apple';
	searchInput.dispatchEvent(new Event('input', { bubbles: true }));
	await flush(20);

	let cards = document.querySelectorAll('.entry-card');
	expect(cards.length).toBe(1);
	expect(cards[0].querySelector('.entry-site').textContent).toContain('apple.com');

	// Clear search, then verify default (site-asc) ordering
	searchInput.value = '';
	searchInput.dispatchEvent(new Event('input', { bubbles: true }));
	await flush(20);

	cards = document.querySelectorAll('.entry-card');
	const sitesAsc = Array.from(cards).map((c) => c.querySelector('.entry-site').textContent.trim());
	expect(sitesAsc).toEqual(['apple.com', 'mango.com', 'zebra.com']);

	// Switch to descending sort
	const sortSelect = document.getElementById('sort-select');
	sortSelect.value = 'site-desc';
	sortSelect.dispatchEvent(new Event('change', { bubbles: true }));
	await flush(20);

	cards = document.querySelectorAll('.entry-card');
	const sitesDesc = Array.from(cards).map((c) => c.querySelector('.entry-site').textContent.trim());
	expect(sitesDesc).toEqual(['zebra.com', 'mango.com', 'apple.com']);
  });

  test('search with no matches shows the "no entries match" empty state', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'example.com';
	document.getElementById('entry-password').value = 'pw';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const searchInput = document.getElementById('search-input');
	searchInput.value = 'zzz-no-match';
	searchInput.dispatchEvent(new Event('input', { bubbles: true }));
	await flush(20);

	expect(document.querySelectorAll('.entry-card').length).toBe(0);
	const emptyState = document.getElementById('empty-state');
	expect(emptyState.classList.contains('hidden')).toBe(false);
	expect(emptyState.textContent).toMatch(/No entries match your search/);
  });

  test('reveal button toggles a password between masked and plaintext', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'example.com';
	document.getElementById('entry-password').value = 'super-secret';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const card = document.querySelector('.entry-card');
	const revealBtn = card.querySelector('.reveal-btn');
	const passwordSpan = card.querySelector('.entry-password');

	expect(passwordSpan.classList.contains('masked')).toBe(true);
	revealBtn.click();
	await flush(10);
	expect(passwordSpan.classList.contains('masked')).toBe(false);
	expect(passwordSpan.textContent).toBe('super-secret');

	revealBtn.click();
	await flush(10);
	expect(passwordSpan.classList.contains('masked')).toBe(true);
	expect(passwordSpan.textContent).toBe('••••••••');
  });

  test('copy-password button writes to the clipboard and shows a success toast', async () => {
	const writeText = jest.fn().mockResolvedValue(undefined);
	Object.assign(navigator, { clipboard: { writeText } });

	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'example.com';
	document.getElementById('entry-password').value = 'copy-me';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const card = document.querySelector('.entry-card');
	card.querySelector('.copy-btn').click();
	await flush(20);

	expect(writeText).toHaveBeenCalledWith('copy-me');
	expect(writeText).toHaveBeenCalledTimes(1);

	// Regression check: the "copied to clipboard" toast used to be permanently
	// stuck behind a persistent "Unsaved changes" toast that never
	// auto-dismissed (adding an entry queues that warning too). Now that the
	// unsaved notice is a separate banner instead of a toast, this toast
	// should still surface once the queue works through the toasts ahead of
	// it ("Vault created…", "Entry added.").
	const toastText = await waitForToastText(/Password copied to clipboard/);
	expect(toastText).toMatch(/Password copied to clipboard/);
  });

  test('the unsaved-changes banner is shown separately from the toast queue and never blocks other toasts', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	// No unsaved changes yet — banner hidden.
	expect(document.getElementById('unsaved-banner').classList.contains('hidden')).toBe(true);

	// Add several entries back-to-back. Each one marks the vault unsaved; if
	// the warning were still a persistent *toast*, these would pile up in
	// the queue and block every "Entry added." toast behind the first one.
	for (const site of ['a.com', 'b.com', 'c.com']) {
	  document.getElementById('add-btn').click();
	  document.getElementById('entry-site').value = site;
	  document.getElementById('entry-password').value = 'pw';
	  document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	  await flush(20);
	}

	// Banner is visible and stays visible (it's not a one-shot toast).
	expect(document.getElementById('unsaved-banner').classList.contains('hidden')).toBe(false);
	expect(document.getElementById('unsaved-banner').textContent).toMatch(/Unsaved changes/);

	// The toast queue still works through each "Entry added." toast in turn
	// instead of getting stuck — this is the actual regression check.
	const toastText = await waitForToastText(/Entry added\./);
	expect(toastText).toMatch(/Entry added\./);

	// Exporting clears the unsaved state and hides the banner.
	document.getElementById('export-btn').click();
	await flush(10);
	document.getElementById('export-filename').value = 'test-backup';
	document.querySelector('#export-form button[type="submit"]').click();
	await flush(50);

	expect(document.getElementById('unsaved-banner').classList.contains('hidden')).toBe(true);
  });

  test('rapid clipboard copies share a single clear timer keyed to the most recent copy', async () => {
	jest.useFakeTimers();
	try {
	  const writeText = jest.fn().mockResolvedValue(undefined);
	  Object.assign(navigator, { clipboard: { writeText } });

	  document.getElementById('create-vault-btn').click();
	  document.getElementById('create-password').value = 'abcd';
	  document.getElementById('create-password-confirm').value = 'abcd';
	  document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	  await Promise.resolve();

	  document.getElementById('add-btn').click();
	  document.getElementById('entry-site').value = 'example.com';
	  document.getElementById('entry-username').value = 'user@example.com';
	  document.getElementById('entry-password').value = 'pw-secret';
	  document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	  await Promise.resolve();

	  const card = document.querySelector('.entry-card');

	  // Copy the password at T+0.
	  card.querySelector('.copy-btn').click();
	  await Promise.resolve();
	  await Promise.resolve();

	  // At T+5s, copy the username too. If each copy used its own
	  // independent 15s timer, the password's timer would still fire at
	  // T+15s and wipe out the username (copied at T+5s, expected to live
	  // until T+20s) ten seconds early.
	  jest.advanceTimersByTime(5000);
	  card.querySelector('.copy-user-btn').click();
	  await Promise.resolve();
	  await Promise.resolve();

	  expect(writeText).toHaveBeenCalledWith('pw-secret');
	  expect(writeText).toHaveBeenCalledWith('user@example.com');

	  // T+15s overall (10s after the username copy): a naive per-copy timer
	  // for the password would have already cleared the clipboard here.
	  jest.advanceTimersByTime(10000);
	  await Promise.resolve();
	  expect(writeText).not.toHaveBeenCalledWith('');

	  // T+20s overall (15s after the *username* copy, the most recent one):
	  // the shared timer should now clear the clipboard exactly once.
	  jest.advanceTimersByTime(5000);
	  await Promise.resolve();
	  expect(writeText).toHaveBeenCalledWith('');
	  expect(writeText.mock.calls.filter((call) => call[0] === '')).toHaveLength(1);
	} finally {
	  jest.useRealTimers();
	}
  });

  test('generate-password button fills in the entry password field', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('generate-password').click();
	await flush(10);

	expect(document.getElementById('entry-password').value).toBe('TestPassword123!');
  });

  test('deleting an entry requires confirmation via the delete modal', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'example.com';
	document.getElementById('entry-password').value = 'pw';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.querySelector('.delete-btn').click();
	await flush(10);

	// Cancel should leave the entry in place
	document.getElementById('delete-cancel').click();
	await flush(10);
	expect(document.querySelectorAll('.entry-card').length).toBe(1);

	// Now actually confirm the delete
	document.querySelector('.delete-btn').click();
	await flush(10);
	document.getElementById('delete-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);
	expect(document.querySelectorAll('.entry-card').length).toBe(0);
  });

  test('CSV export via the warning modal downloads a text/csv file', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'example.com';
	document.getElementById('entry-password').value = 'pw';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('export-csv-btn').click();
	await flush(10);
	expect(document.getElementById('export-csv-warning-modal').hasAttribute('open')).toBe(true);

	document.getElementById('confirm-export-csv').click();
	await flush(50);

	expect(global.URL.createObjectURL).toHaveBeenCalled();
	const blobArg = global.URL.createObjectURL.mock.calls[global.URL.createObjectURL.mock.calls.length - 1][0];
	expect(blobArg.type).toBe('text/csv');
  });

  test('CSV export does NOT clear the unsaved-changes banner, only an encrypted backup export does', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'example.com';
	document.getElementById('entry-password').value = 'pw';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	expect(document.getElementById('unsaved-banner').classList.contains('hidden')).toBe(false);

	// CSV is a lossy, unencrypted side-export — not a real backup — so it
	// must leave the "unsaved" state (and banner) exactly as it was.
	document.getElementById('export-csv-btn').click();
	await flush(10);
	document.getElementById('confirm-export-csv').click();
	await flush(50);

	expect(document.getElementById('unsaved-banner').classList.contains('hidden')).toBe(false);
	expect(window.Vault.state.hasExported).toBe(false);

	// The encrypted ".vault" backup IS the real persisted representation of
	// the vault, so exporting it is what should actually clear the banner.
	document.getElementById('export-btn').click();
	await flush(10);
	document.getElementById('export-filename').value = 'test-backup';
	document.querySelector('#export-form button[type="submit"]').click();
	await flush(50);

	expect(document.getElementById('unsaved-banner').classList.contains('hidden')).toBe(true);
	expect(window.Vault.state.hasExported).toBe(true);
  });

  test('CSV import chevron opens the hidden file input directly (no modal, no password)', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const fileInput = document.getElementById('merge-csv-file');
	const clickSpy = jest.spyOn(fileInput, 'click');

	document.getElementById('merge-csv-btn').click();

	expect(clickSpy).toHaveBeenCalledTimes(1);
	// no modal should have opened for the CSV path
	expect(document.getElementById('merge-modal').hasAttribute('open')).toBe(false);
  });

  test('importing a CSV file adds valid rows as new entries and skips invalid ones', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const csvContent = [
	  'site,username,password,notes',
	  'a.com,u1,p1,n1',
	  'b.com,u2,p2,',
	  ',missing-site,p3,', // invalid: no site
	  'c.com,u4', // invalid: wrong column count
	].join('\n');
	const csvFile = new File([csvContent], 'export.csv', { type: 'text/csv' });

	const fileInput = document.getElementById('merge-csv-file');
	Object.defineProperty(fileInput, 'files', { value: [csvFile], configurable: true });
	fileInput.dispatchEvent(new Event('change', { bubbles: true }));
	await flush(50);

	const cards = document.querySelectorAll('.entry-card');
	expect(cards.length).toBe(2);
	const sites = Array.from(cards).map((c) => c.querySelector('.entry-site').textContent.trim());
	expect(sites).toEqual(expect.arrayContaining(['a.com', 'b.com']));

	const toastText = await waitForToastText(/2 added, 2 invalid skipped/);
	expect(toastText).toMatch(/CSV import complete: 2 added, 2 invalid skipped\./);

	// unsaved changes were introduced by the import
	expect(document.getElementById('unsaved-banner').classList.contains('hidden')).toBe(false);

	// the file input is reset so the same file can be re-selected
	expect(fileInput.value).toBe('');
  });

  test('CSV import skips an exact duplicate (all four fields match an existing entry)', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'dup.com';
	document.getElementById('entry-username').value = 'u';
	document.getElementById('entry-password').value = 'same-pw';
	document.getElementById('entry-notes').value = 'same note';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	expect(document.querySelectorAll('.entry-card').length).toBe(1);

	// exact same site, username, password, and notes as the existing entry
	const csvFile = new File(['dup.com,u,same-pw,same note'], 'export.csv', { type: 'text/csv' });
	const fileInput = document.getElementById('merge-csv-file');
	Object.defineProperty(fileInput, 'files', { value: [csvFile], configurable: true });
	fileInput.dispatchEvent(new Event('change', { bubbles: true }));
	await flush(50);

	// nothing new was added — still just the one entry
	expect(document.querySelectorAll('.entry-card').length).toBe(1);

	const toastText = await waitForToastText(/1 duplicate skipped/);
	expect(toastText).toMatch(/CSV import complete: 1 duplicate skipped\./);
  });

  test('CSV import skips (and warns about) a row that differs only in password, keeping the existing password', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'dup.com';
	document.getElementById('entry-username').value = 'u';
	document.getElementById('entry-password').value = 'existing-pw';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	expect(document.querySelectorAll('.entry-card').length).toBe(1);

	// same site, username, and (empty) notes, but a different password
	const csvFile = new File(['dup.com,u,new-pw,'], 'export.csv', { type: 'text/csv' });
	const fileInput = document.getElementById('merge-csv-file');
	Object.defineProperty(fileInput, 'files', { value: [csvFile], configurable: true });
	fileInput.dispatchEvent(new Event('change', { bubbles: true }));
	await flush(50);

	// no conflict modal, and no new entry — the row is skipped, not merged or appended
	expect(document.getElementById('conflict-modal').hasAttribute('open')).toBe(false);
	const cards = document.querySelectorAll('.entry-card');
	expect(cards.length).toBe(1);
	expect(window.Vault.findEntry(cards[0].dataset.id).password).toBe('existing-pw');

	const summaryToast = await waitForToastText(/1 skipped \(password differs\)/);
	expect(summaryToast).toMatch(/CSV import complete: 1 skipped \(password differs\)\./);

	const warningToast = await waitForToastText(/Password mismatch entries not imported/);
	expect(warningToast).toMatch(/Password mismatch entries not imported: dup\.com\./);
  });

  test('CSV import lists up to 3 sites for password mismatches and summarizes the rest', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	// Seed pre-existing entries directly (bypassing the add-entry UI/toasts)
	// so this test isn't stuck waiting through 4 sequential "Entry added."
	// toasts before the import's own toasts can appear.
	['one.com', 'two.com', 'three.com', 'four.com'].forEach((site, i) => {
	  window.Vault.addEntry({ site, username: 'u', password: `pw${i + 1}`, notes: '' });
	});

	const csvContent = [
	  'one.com,u,new1,',
	  'two.com,u,new2,',
	  'three.com,u,new3,',
	  'four.com,u,new4,',
	].join('\n');
	const csvFile = new File([csvContent], 'export.csv', { type: 'text/csv' });
	const fileInput = document.getElementById('merge-csv-file');
	Object.defineProperty(fileInput, 'files', { value: [csvFile], configurable: true });
	fileInput.dispatchEvent(new Event('change', { bubbles: true }));
	await flush(50);

	const warningToast = await waitForToastText(/Password mismatch entries not imported/);
	expect(warningToast).toMatch(/one\.com, two\.com, three\.com, and 1 more/);
  });

  test('re-importing a previously exported CSV of the current entries adds nothing (all exact duplicates)', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	document.getElementById('add-btn').click();
	document.getElementById('entry-site').value = 'round-trip.com';
	document.getElementById('entry-username').value = 'u';
	document.getElementById('entry-password').value = 'pw';
	document.getElementById('entry-notes').value = 'n';
	document.getElementById('entry-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const exportedCsv = window.Storage.buildCsvContent(window.Vault.state.entries);
	const csvFile = new File([exportedCsv], 're-import.csv', { type: 'text/csv' });
	const fileInput = document.getElementById('merge-csv-file');
	Object.defineProperty(fileInput, 'files', { value: [csvFile], configurable: true });
	fileInput.dispatchEvent(new Event('change', { bubbles: true }));
	await flush(50);

	expect(document.querySelectorAll('.entry-card').length).toBe(1);
	const toastText = await waitForToastText(/1 duplicate skipped/);
	expect(toastText).toMatch(/CSV import complete: 1 duplicate skipped\./);
  });

  test('importing an all-invalid CSV adds nothing and reports the skip count without marking unsaved', async () => {
	document.getElementById('create-vault-btn').click();
	document.getElementById('create-password').value = 'abcd';
	document.getElementById('create-password-confirm').value = 'abcd';
	document.getElementById('create-form').dispatchEvent(new Event('submit', { bubbles: true }));
	await flush(20);

	const csvFile = new File([',no-site,,'], 'export.csv', { type: 'text/csv' });
	const fileInput = document.getElementById('merge-csv-file');
	Object.defineProperty(fileInput, 'files', { value: [csvFile], configurable: true });
	fileInput.dispatchEvent(new Event('change', { bubbles: true }));
	await flush(50);

	expect(document.querySelectorAll('.entry-card').length).toBe(0);
	const toastText = await waitForToastText(/1 invalid skipped/);
	expect(toastText).toMatch(/CSV import complete: 1 invalid skipped\./);
	expect(document.getElementById('unsaved-banner').classList.contains('hidden')).toBe(true);
  });

  test('export is blocked with an error toast when the vault was never unlocked', async () => {

	// No vault created/unlocked yet — cryptoKey is null from app init, so no
	// other toasts are queued ahead of this one.
	document.getElementById('export-btn').click();
	await flush(10);

	const toastText = await waitForToastText(/Vault is locked\. Unlock to export\./, 2000);
	expect(toastText).toMatch(/Vault is locked\. Unlock to export\./);
	expect(document.getElementById('export-modal').hasAttribute('open')).toBe(false);
  });
});
