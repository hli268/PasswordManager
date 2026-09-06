/**
 * Vault — Session-only password manager.
 * All data lives in memory and is wiped on page close.
 */
(() => {
  'use strict';

  const DEFAULT_AUTO_LOCK_MS = 5 * 60 * 1000;
  const REVEAL_TIMEOUT_MS = 30 * 1000;

  const vault = {
    unlocked: false,
    sessionSalt: null,
    verifier: null,
    cryptoKey: null,
    entries: [],
    editingId: null,
    hasExported: false,
  };

  let autoLockMs = DEFAULT_AUTO_LOCK_MS;
  let autoLockTimer = null;
  let toastTimer = null;
  let revealTimer = null;
  let pendingDeleteId = null;

  const $ = (sel) => document.querySelector(sel);

  const welcomeScreen = $('#welcome-screen');
  const unlockScreen = $('#unlock-screen');
  const vaultScreen = $('#vault-screen');
  const unlockForm = $('#unlock-form');
  const masterPasswordInput = $('#master-password');
  const unlockError = $('#unlock-error');
  const entriesList = $('#entries-list');
  const emptyState = $('#empty-state');
  const searchInput = $('#search-input');
  const sortSelect = $('#sort-select');
  const entryCount = $('#entry-count');
  const autoLockSelect = $('#auto-lock-select');

  const createModal = $('#create-modal');
  const createForm = $('#create-form');
  const createPassword = $('#create-password');
  const createPasswordConfirm = $('#create-password-confirm');
  const createError = $('#create-error');

  const entryModal = $('#entry-modal');
  const entryForm = $('#entry-form');
  const entryModalTitle = $('#entry-modal-title');
  const entrySite = $('#entry-site');
  const entryUsername = $('#entry-username');
  const entryPassword = $('#entry-password');
  const entryNotes = $('#entry-notes');
  const entryError = $('#entry-error');
  const passwordStrength = $('#password-strength');
  const strengthFill = $('#strength-fill');
  const strengthLabel = $('#strength-label');

  const restoreModal = $('#restore-modal');
  const restoreForm = $('#restore-form');
  const restoreFile = $('#restore-file');
  const restorePassword = $('#restore-password');
  const restoreError = $('#restore-error');

  const exportModal = $('#export-modal');
  const exportForm = $('#export-form');
  const exportFilename = $('#export-filename');
  const exportError = $('#export-error');

  const mergeModal = $('#merge-modal');
  const mergeForm = $('#merge-form');
  const mergeFile = $('#merge-file');
  const mergePassword = $('#merge-password');
  const mergeError = $('#merge-error');

  const conflictModal = $('#conflict-modal');
  const conflictForm = $('#conflict-form');
  const conflictList = $('#conflict-list');

  const deleteModal = $('#delete-modal');
  const deleteForm = $('#delete-form');
  const deleteMessage = $('#delete-message');

  const toast = $('#toast');

  function init() {
    if (!VaultCrypto.isAvailable()) {
      showToast('Web Crypto is unavailable. Open via http://localhost, not file://.', 'error');
      return;
    }

    bindEvents();
    autoLockSelect.value = String(DEFAULT_AUTO_LOCK_MS);
    showScreen('welcome');
  }

  function showScreen(screen) {
    welcomeScreen.classList.toggle('active', screen === 'welcome');
    unlockScreen.classList.toggle('active', screen === 'unlock');
    vaultScreen.classList.toggle('active', screen === 'vault');
  }

  function showToast(message, type = 'info') {
    clearTimeout(toastTimer);
    toast.textContent = message;
    toast.className = `toast toast-${type}`;
    toast.classList.remove('hidden');
    toastTimer = setTimeout(() => toast.classList.add('hidden'), 3000);
  }

  function showError(el, message) {
    el.textContent = message;
    el.classList.remove('hidden');
  }

  function hideError(el) {
    el.textContent = '';
    el.classList.add('hidden');
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    button.disabled = busy;
    if (busy) {
      button.dataset.originalText = button.textContent;
      button.textContent = busyText;
    } else if (button.dataset.originalText) {
      button.textContent = button.dataset.originalText;
      delete button.dataset.originalText;
    }
  }

  function resetAutoLockTimer() {
    clearTimeout(autoLockTimer);
    if (!vault.unlocked) return;
    autoLockTimer = setTimeout(() => lockVault('Vault locked due to inactivity.'), autoLockMs);
  }

  function stopAutoLockTimer() {
    clearTimeout(autoLockTimer);
    autoLockTimer = null;
  }

  function trackActivity() {
    if (vault.unlocked) resetAutoLockTimer();
  }

  function updateEntryCount() {
    const count = vault.entries.length;
    entryCount.textContent = count === 1 ? '· 1 entry' : `· ${count} entries`;
  }

  async function activateVault(session) {
    vault.sessionSalt = session.sessionSalt;
    vault.verifier = session.verifier;
    vault.cryptoKey = session.cryptoKey;
    vault.unlocked = true;
    showScreen('vault');
    renderEntries();
    updateEntryCount();
    resetAutoLockTimer();
  }

  async function createVault(password) {
    const session = await VaultCrypto.createSession(password);
    vault.entries = [];
    vault.editingId = null;
    vault.hasExported = false;
    await activateVault(session);
    showToast('Vault created. Export a backup before closing this tab.', 'info');
  }

  async function reUnlockVault(password) {
    try {
      const cryptoKey = await VaultCrypto.unlockSession(password, vault.sessionSalt, vault.verifier);
      vault.cryptoKey = cryptoKey;
      vault.unlocked = true;
      masterPasswordInput.value = '';
      hideError(unlockError);
      showScreen('vault');
      renderEntries();
      updateEntryCount();
      resetAutoLockTimer();
      return true;
    } catch (err) {
      showError(unlockError, err.message || 'Incorrect master password.');
      return false;
    }
  }

  function lockVault(message = 'Vault locked.') {
    vault.unlocked = false;
    vault.cryptoKey = null;
    vault.editingId = null;
    stopAutoLockTimer();
    clearRevealTimer();
    masterPasswordInput.value = '';
    hideError(unlockError);
    showScreen('unlock');
    showToast(message, 'info');
  }

  function wipeVault() {
    vault.unlocked = false;
    vault.sessionSalt = null;
    vault.verifier = null;
    vault.cryptoKey = null;
    vault.entries = [];
    vault.editingId = null;
    vault.hasExported = false;
    entriesList.innerHTML = '';
    searchInput.value = '';
    stopAutoLockTimer();
    clearRevealTimer();
  }

  function clearRevealTimer() {
    clearTimeout(revealTimer);
    revealTimer = null;
  }

  function scheduleReMask() {
    clearRevealTimer();
    revealTimer = setTimeout(() => {
      entriesList.querySelectorAll('.entry-password:not(.masked)').forEach((span) => {
        span.textContent = '••••••••';
        span.classList.add('masked');
      });
    }, REVEAL_TIMEOUT_MS);
  }

  function sortEntries(entries) {
    const sorted = [...entries];
    const mode = sortSelect.value;

    if (mode === 'site-desc') {
      sorted.sort((a, b) => b.site.localeCompare(a.site));
    } else if (mode === 'updated-desc') {
      sorted.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } else {
      sorted.sort((a, b) => a.site.localeCompare(b.site));
    }

    return sorted;
  }

  function renderEntries(filter = '') {
    const query = filter.toLowerCase().trim();
    let filtered = vault.entries.filter((e) => {
      if (!query) return true;
      // Guard against null/undefined fields
      const site = (e.site || '').toLowerCase();
      const username = (e.username || '').toLowerCase();
      const notes = (e.notes || '').toLowerCase();
      return (
        site.includes(query) ||
        username.includes(query) ||
        notes.includes(query)
      );
    });

    filtered = sortEntries(filtered);
    entriesList.innerHTML = '';

    if (filtered.length === 0) {
      emptyState.classList.toggle('hidden', vault.entries.length > 0);
      if (vault.entries.length > 0 && query) {
        emptyState.textContent = 'No entries match your search.';
        emptyState.classList.remove('hidden');
      } else if (vault.entries.length === 0) {
        emptyState.textContent = 'No entries yet. Click "Add Entry" to save your first password.';
        emptyState.classList.remove('hidden');
      }
      updateEntryCount();
      return;
    }

    emptyState.classList.add('hidden');

    for (const entry of filtered) {
      const card = document.createElement('div');
      card.className = 'entry-card';
      card.dataset.id = entry.id;

      card.innerHTML = `
        <div class="entry-info">
          <h3 class="entry-site">${escapeHtml(entry.site)}</h3>
          <p class="entry-username">${escapeHtml(entry.username) || '—'}</p>
          ${entry.notes ? `<p class="entry-notes">${escapeHtml(entry.notes)}</p>` : ''}
        </div>
        <div class="entry-password-row">
          <span class="entry-password masked">••••••••</span>
          <button type="button" class="btn-icon reveal-btn" title="Reveal password" aria-label="Reveal password">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
          <button type="button" class="btn-icon copy-btn" title="Copy password" aria-label="Copy password">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
          </button>
          <button type="button" class="btn-icon copy-user-btn" title="Copy username" aria-label="Copy username">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
          </button>
        </div>
        <div class="entry-actions">
          <button type="button" class="btn btn-ghost btn-sm edit-btn">Edit</button>
          <button type="button" class="btn btn-ghost btn-sm delete-btn">Delete</button>
        </div>
      `;

      entriesList.appendChild(card);
    }

    updateEntryCount();
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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

  function sanitizeFilename(name) {
    const trimmed = name.trim();
    if (!trimmed) return 'vault-backup.vault';
    const withExt = trimmed.endsWith('.vault') ? trimmed : `${trimmed}.vault`;
    return withExt.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  }

  function defaultExportFilename() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `vault-backup-${timestamp}.vault`;
  }

  function supportsSaveLocationPicker() {
    return typeof window.showSaveFilePicker === 'function';
  }

  async function buildExportContent() {
    if (!vault.cryptoKey || !vault.sessionSalt) {
      throw new Error('Vault is locked. Unlock before exporting.');
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      entries: vault.entries,
    };

    const encrypted = await VaultCrypto.encryptWithKey(
      vault.cryptoKey,
      vault.sessionSalt,
      payload
    );
    return JSON.stringify(encrypted, null, 2);
  }

  async function saveBackupWithPicker(content, suggestedFilename) {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggestedFilename,
      types: [{
        description: 'Vault Backup',
        accept: { 'application/json': ['.vault'] },
      }],
    });

    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return handle.name;
  }

  async function downloadBackup(content, filename) {
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function parseBackupFile(file, password) {
    const text = await file.text();
    let backup;
    try {
      backup = JSON.parse(text);
    } catch {
      throw new Error('Invalid backup file. Could not parse JSON.');
    }

    const { data } = await VaultCrypto.decrypt(password, backup);
    return data.entries.map(normalizeEntry);
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
      vault.entries.push(entry);
      added += 1;
    }

    for (const conflict of conflicts) {
      if (resolutions[conflict.key] === 'imported') {
        const idx = vault.entries.findIndex((e) => e.id === conflict.current.id);
        if (idx !== -1) {
          vault.entries[idx] = {
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

  function showConflictModal(conflicts) {
    return new Promise((resolve) => {
      conflictList.innerHTML = '';

      conflicts.forEach((conflict, index) => {
        const item = document.createElement('div');
        item.className = 'conflict-item';
        item.innerHTML = `
          <div class="conflict-item-header">${escapeHtml(conflict.current.site)}</div>
          <div class="conflict-item-user">${escapeHtml(conflict.current.username) || '—'}</div>
          <div class="conflict-options">
            <label class="conflict-option">
              <input type="radio" name="conflict-${index}" value="current" checked>
              <span class="conflict-option-text">
                <span class="conflict-option-label">Keep current</span>
                <span class="conflict-option-password">${escapeHtml(conflict.current.password)}</span>
              </span>
            </label>
            <label class="conflict-option">
              <input type="radio" name="conflict-${index}" value="imported">
              <span class="conflict-option-text">
                <span class="conflict-option-label">Use imported</span>
                <span class="conflict-option-password">${escapeHtml(conflict.imported.password)}</span>
              </span>
            </label>
          </div>
        `;
        conflictList.appendChild(item);
      });

      const finish = (result) => {
        conflictForm.removeEventListener('submit', onSubmit);
        $('#conflict-cancel').removeEventListener('click', onCancel);
        $('#conflict-keep-all').removeEventListener('click', onKeepAll);
        $('#conflict-use-all').removeEventListener('click', onUseAll);
        conflictModal.close();
        resolve(result);
      };

      const readResolutions = () => {
        const resolutions = {};
        conflicts.forEach((conflict, index) => {
          const selected = conflictList.querySelector(`input[name="conflict-${index}"]:checked`);
          resolutions[conflict.key] = selected?.value === 'imported' ? 'imported' : 'current';
        });
        return resolutions;
      };

      const onSubmit = (e) => { e.preventDefault(); finish(readResolutions()); };
      const onCancel = () => finish(null);
      const onKeepAll = () => conflictList.querySelectorAll('input[value="current"]').forEach((i) => { i.checked = true; });
      const onUseAll = () => conflictList.querySelectorAll('input[value="imported"]').forEach((i) => { i.checked = true; });

      conflictForm.addEventListener('submit', onSubmit);
      $('#conflict-cancel').addEventListener('click', onCancel);
      $('#conflict-keep-all').addEventListener('click', onKeepAll);
      $('#conflict-use-all').addEventListener('click', onUseAll);
      conflictModal.showModal();
    });
  }

  function openEntryModal(editEntry = null) {
    vault.editingId = editEntry ? editEntry.id : null;
    entryModalTitle.textContent = editEntry ? 'Edit Entry' : 'Add Entry';
    entrySite.value = editEntry ? editEntry.site : '';
    entryUsername.value = editEntry ? editEntry.username : '';
    entryPassword.value = editEntry ? editEntry.password : '';
    entryNotes.value = editEntry ? editEntry.notes || '' : '';
    hideError(entryError);
    updatePasswordStrength(entryPassword.value);
    entryModal.showModal();
    entrySite.focus();
  }

  function updatePasswordStrength(password) {
    const result = VaultCrypto.scorePassword(password);
    passwordStrength.className = `password-strength ${result.className}`;
    strengthFill.style.width = result.className === 'strength-empty' ? '0' : '';
    strengthLabel.textContent = result.label;
    passwordStrength.classList.toggle('hidden', !password);
  }

  async function exportBackup(filename) {
    const content = await buildExportContent();
    await downloadBackup(content, filename);
    vault.hasExported = true;
    showToast(`Backup downloaded as ${filename}.`, 'success');
  }

  async function exportBackupWithLocationPicker() {
    const content = await buildExportContent();
    const savedName = await saveBackupWithPicker(content, defaultExportFilename());
    vault.hasExported = true;
    showToast(`Backup saved as ${savedName}.`, 'success');
    return true;
  }

  async function mergeBackup(file, password) {
    const importedEntries = await parseBackupFile(file, password);
    const { toAdd, conflicts } = buildMergePlan(vault.entries, importedEntries);

    if (toAdd.length === 0 && conflicts.length === 0) {
      showToast('No new entries to merge.', 'info');
      return;
    }

    let resolutions = {};
    if (conflicts.length > 0) {
      const result = await showConflictModal(conflicts);
      if (!result) {
        showToast('Merge cancelled.', 'info');
        return;
      }
      resolutions = result;
    }

    const { added, updated } = applyMerge(toAdd, conflicts, resolutions);
    renderEntries(searchInput.value);

    const parts = [];
    if (added > 0) parts.push(`${added} added`);
    if (updated > 0) parts.push(`${updated} updated`);
    showToast(`Merge complete: ${parts.join(', ') || 'no changes'}.`, 'success');
  }

  async function importBackup(file, password) {
    const entries = await parseBackupFile(file, password);
    const session = await VaultCrypto.createSession(password);

    vault.entries = entries;
    vault.hasExported = true;
    vault.editingId = null;
    await activateVault(session);
    showToast(`Restored ${vault.entries.length} entries from backup.`, 'success');
  }

  function bindEvents() {
    $('#create-vault-btn').addEventListener('click', () => {
      createPassword.value = '';
      createPasswordConfirm.value = '';
      hideError(createError);
      createModal.showModal();
      createPassword.focus();
    });

    createForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError(createError);

      const password = createPassword.value;
      const confirm = createPasswordConfirm.value;
      const submitBtn = createForm.querySelector('button[type="submit"]');

      if (!password) {
        showError(createError, 'Please enter a master password.');
        return;
      }

      if (password.length < VaultCrypto.MIN_MASTER_PASSWORD_LENGTH) {
        showError(createError, `Master password must be at least ${VaultCrypto.MIN_MASTER_PASSWORD_LENGTH} characters.`);
        return;
      }

      if (password !== confirm) {
        showError(createError, 'Passwords do not match.');
        return;
      }

      setBusy(submitBtn, true, 'Creating…');
      try {
        createModal.close();
        await createVault(password);
      } catch (err) {
        showError(createError, err.message || 'Failed to create vault.');
        createModal.showModal();
      } finally {
        setBusy(submitBtn, false);
      }
    });

    $('#create-cancel').addEventListener('click', () => createModal.close());

    $('#restore-btn').addEventListener('click', () => {
      restoreFile.value = '';
      restorePassword.value = '';
      hideError(restoreError);
      restoreModal.showModal();
    });

    restoreForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError(restoreError);

      const file = restoreFile.files[0];
      const password = restorePassword.value;
      const submitBtn = restoreForm.querySelector('button[type="submit"]');

      if (!file || !password) {
        showError(restoreError, 'Please select a backup file and enter the master password.');
        return;
      }

      setBusy(submitBtn, true, 'Restoring…');
      try {
        await importBackup(file, password);
        restoreModal.close();
        restorePassword.value = '';
      } catch (err) {
        showError(restoreError, err.message);
      } finally {
        setBusy(submitBtn, false);
      }
    });

    $('#restore-cancel').addEventListener('click', () => restoreModal.close());

    unlockForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const password = masterPasswordInput.value;
      if (!password) {
        showError(unlockError, 'Please enter your master password.');
        return;
      }
      await reUnlockVault(password);
    });

    $('#add-btn').addEventListener('click', () => openEntryModal());

    entryForm.addEventListener('submit', (e) => {
      e.preventDefault();
      hideError(entryError);

      // Coerce and normalize inputs to strings to avoid runtime errors later
      const site = String(entrySite.value || '').trim();
      const username = String(entryUsername.value || '').trim();
      const password = String(entryPassword.value || '');
      const notes = String(entryNotes.value || '').trim();

      if (!site) {
        showError(entryError, 'Site / service name is required.');
        return;
      }

      if (!password) {
        showError(entryError, 'Password is required.');
        return;
      }

      const now = new Date().toISOString();

      if (vault.editingId) {
        const idx = vault.entries.findIndex((entry) => entry.id === vault.editingId);
        if (idx !== -1) {
          vault.entries[idx] = {
            ...vault.entries[idx],
            site,
            username,
            password,
            notes,
            updatedAt: now,
          };
        }
        showToast('Entry updated.', 'success');
      } else {
        vault.entries.push({
          id: VaultCrypto.generateId(),
          site,
          username,
          password,
          notes,
          createdAt: now,
          updatedAt: now,
        });
        showToast('Entry added.', 'success');
      }

      entryModal.close();
      renderEntries(searchInput.value);
      trackActivity();
    });

    $('#entry-cancel').addEventListener('click', () => entryModal.close());

    entryPassword.addEventListener('input', () => updatePasswordStrength(entryPassword.value));

    $('#generate-password').addEventListener('click', () => {
      entryPassword.value = VaultCrypto.generatePassword();
      entryPassword.type = 'text';
      updatePasswordStrength(entryPassword.value);
    });

    searchInput.addEventListener('input', () => {
      renderEntries(searchInput.value);
      trackActivity();
    });

    sortSelect.addEventListener('change', () => renderEntries(searchInput.value));

    autoLockSelect.addEventListener('change', () => {
      autoLockMs = Number(autoLockSelect.value);
      resetAutoLockTimer();
      trackActivity();
    });

    $('#export-btn').addEventListener('click', async () => {
      if (!vault.cryptoKey) {
        showToast('Vault is locked. Unlock to export.', 'error');
        return;
      }

      try {
        if (supportsSaveLocationPicker()) {
          try {
            const saved = await exportBackupWithLocationPicker();
            if (saved) trackActivity();
          } catch (err) {
            if (err.name === 'AbortError') return;
            throw err;
          }
          return;
        }

        exportFilename.value = defaultExportFilename();
        hideError(exportError);
        exportModal.showModal();
        exportFilename.focus();
        exportFilename.select();
      } catch (err) {
        showToast(err.message || 'Failed to save backup file.', 'error');
      }
    });

    exportForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError(exportError);

      const filename = sanitizeFilename(exportFilename.value);
      const submitBtn = exportForm.querySelector('button[type="submit"]');

      if (!vault.cryptoKey) {
        exportModal.close();
        return;
      }

      setBusy(submitBtn, true, 'Exporting…');
      try {
        await exportBackup(filename);
        exportModal.close();
        trackActivity();
      } catch (err) {
        showError(exportError, err.message || 'Failed to save backup file.');
      } finally {
        setBusy(submitBtn, false);
      }
    });

    $('#export-cancel').addEventListener('click', () => exportModal.close());

    $('#merge-btn').addEventListener('click', () => {
      mergeFile.value = '';
      mergePassword.value = '';
      hideError(mergeError);
      mergeModal.showModal();
    });

    mergeForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      hideError(mergeError);

      const file = mergeFile.files[0];
      const password = mergePassword.value;
      const submitBtn = mergeForm.querySelector('button[type="submit"]');

      if (!file || !password) {
        showError(mergeError, 'Please select a backup file and enter its master password.');
        return;
      }

      setBusy(submitBtn, true, 'Merging…');
      try {
        await mergeBackup(file, password);
        mergeModal.close();
        mergePassword.value = '';
        trackActivity();
      } catch (err) {
        showError(mergeError, err.message);
      } finally {
        setBusy(submitBtn, false);
      }
    });

    $('#merge-cancel').addEventListener('click', () => mergeModal.close());

    $('#lock-btn').addEventListener('click', () => lockVault());

    deleteForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (pendingDeleteId) {
        vault.entries = vault.entries.filter((en) => en.id !== pendingDeleteId);
        pendingDeleteId = null;
        deleteModal.close();
        renderEntries(searchInput.value);
        showToast('Entry deleted.', 'success');
        trackActivity();
      }
    });

    $('#delete-cancel').addEventListener('click', () => {
      pendingDeleteId = null;
      deleteModal.close();
    });

    entriesList.addEventListener('click', async (e) => {
      const card = e.target.closest('.entry-card');
      if (!card) return;

      const id = card.dataset.id;
      const entry = vault.entries.find((en) => en.id === id);
      if (!entry) return;

      if (e.target.closest('.reveal-btn')) {
        const span = card.querySelector('.entry-password');
        const isMasked = span.classList.contains('masked');
        if (isMasked) {
          span.textContent = entry.password;
          span.classList.remove('masked');
          scheduleReMask();
        } else {
          span.textContent = '••••••••';
          span.classList.add('masked');
        }
        trackActivity();
      }

      if (e.target.closest('.copy-btn')) {
        try {
          await navigator.clipboard.writeText(entry.password);
          showToast('Password copied to clipboard.', 'success');
          // Clear clipboard after a short timeout to reduce exposure
          setTimeout(async () => {
            try {
              await navigator.clipboard.writeText('');
            } catch (_) {
              // ignore failures to clear clipboard (may require user gesture)
            }
          }, 15000);
        } catch {
          showToast('Could not copy to clipboard.', 'error');
        }
        trackActivity();
      }

      if (e.target.closest('.copy-user-btn')) {
        if (!entry.username) {
          showToast('No username to copy.', 'info');
          return;
        }
        try {
          await navigator.clipboard.writeText(entry.username);
          showToast('Username copied to clipboard.', 'success');
          // Clear clipboard after a short timeout
          setTimeout(async () => {
            try {
              await navigator.clipboard.writeText('');
            } catch (_) {
              // ignore failures
            }
          }, 15000);
        } catch {
          showToast('Could not copy to clipboard.', 'error');
        }
        trackActivity();
      }

      if (e.target.closest('.edit-btn')) {
        openEntryModal(entry);
        trackActivity();
      }

      if (e.target.closest('.delete-btn')) {
        pendingDeleteId = id;
        deleteMessage.textContent = `Delete the entry for "${entry.site}"? This cannot be undone.`;
        deleteModal.showModal();
      }
    });

    document.addEventListener('click', (e) => {
      const btn = e.target.closest('.toggle-visibility');
      if (!btn) return;
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.querySelector('.eye-open').classList.toggle('hidden', isPassword);
      btn.querySelector('.eye-closed').classList.toggle('hidden', !isPassword);
    });

    ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach((event) => {
      document.addEventListener(event, trackActivity, { passive: true });
    });

    window.addEventListener('beforeunload', (e) => {
      if (vault.unlocked && vault.entries.length > 0 && !vault.hasExported) {
        e.preventDefault();
        e.returnValue = '';
      }
      wipeVault();
    });

    window.addEventListener('pagehide', () => wipeVault());

    // Optionally block native storage to reduce accidental persistence.
    // Disabled by default because overriding browser globals can break other libraries.
    // Set BLOCK_NATIVE_STORAGE = true to enable (not recommended for general use).
    const BLOCK_NATIVE_STORAGE = false;
    if (BLOCK_NATIVE_STORAGE && typeof Storage !== 'undefined') {
      const blockStorage = (storage, name) => {
        storage.setItem = function (key) {
          console.warn(`[Vault] Blocked write to ${name}:`, key);
        };
        storage.getItem = () => null;
        storage.removeItem = () => {};
        storage.clear = () => {};
        storage.key = () => null;
        Object.defineProperty(storage, 'length', { get: () => 0 });
      };
      try { if (typeof localStorage !== 'undefined') blockStorage(localStorage, 'localStorage'); } catch (_) {}
      try { if (typeof sessionStorage !== 'undefined') blockStorage(sessionStorage, 'sessionStorage'); } catch (_) {}
    }
  }

  init();
})();
