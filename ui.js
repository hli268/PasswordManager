/**
 * UI — DOM references and view-layer behavior.
 *
 * Owns element lookups, screen switching, toasts, error/busy display,
 * entry list rendering, the entry/conflict modals, and the password-reveal
 * masking timer. Holds no vault/session state itself.
 *
 * Depends on the global `VaultCrypto` (loaded separately) for password
 * strength scoring.
 */
const UI = (() => {
  'use strict';

  const REVEAL_TIMEOUT_MS = 30 * 1000;

  const $ = (sel) => document.querySelector(sel);

  const elements = {
    welcomeScreen: $('#welcome-screen'),
    unlockScreen: $('#unlock-screen'),
    vaultScreen: $('#vault-screen'),
    unlockForm: $('#unlock-form'),
    masterPasswordInput: $('#master-password'),
    unlockError: $('#unlock-error'),
    entriesList: $('#entries-list'),
    emptyState: $('#empty-state'),
    searchInput: $('#search-input'),
    sortSelect: $('#sort-select'),
    entryCount: $('#entry-count'),
    autoLockSelect: $('#auto-lock-select'),

    createModal: $('#create-modal'),
    createForm: $('#create-form'),
    createPassword: $('#create-password'),
    createPasswordConfirm: $('#create-password-confirm'),
    createError: $('#create-error'),

    entryModal: $('#entry-modal'),
    entryForm: $('#entry-form'),
    entryModalTitle: $('#entry-modal-title'),
    entrySite: $('#entry-site'),
    entryUsername: $('#entry-username'),
    entryPassword: $('#entry-password'),
    entryNotes: $('#entry-notes'),
    entryError: $('#entry-error'),
    passwordStrength: $('#password-strength'),
    strengthFill: $('#strength-fill'),
    strengthLabel: $('#strength-label'),

    restoreModal: $('#restore-modal'),
    restoreForm: $('#restore-form'),
    restoreFile: $('#restore-file'),
    restorePassword: $('#restore-password'),
    restoreError: $('#restore-error'),

    exportModal: $('#export-modal'),
    exportForm: $('#export-form'),
    exportFilename: $('#export-filename'),
    exportError: $('#export-error'),
    exportCsvWarningModal: $('#export-csv-warning-modal'),
    exportCsvWarningConfirm: $('#confirm-export-csv'),
    exportCsvWarningCancel: $('#cancel-export-csv'),

    mergeModal: $('#merge-modal'),
    mergeForm: $('#merge-form'),
    mergeFile: $('#merge-file'),
    mergePassword: $('#merge-password'),
    mergeError: $('#merge-error'),

    conflictModal: $('#conflict-modal'),
    conflictForm: $('#conflict-form'),
    conflictList: $('#conflict-list'),

    deleteModal: $('#delete-modal'),
    deleteForm: $('#delete-form'),
    deleteMessage: $('#delete-message'),

    toast: $('#toast'),
  };

  // Simple FIFO toast queue. showToast enqueues a message; processToastQueue
  // displays them one at a time. Persistent toasts (persist = true) stay
  // visible until hideToast() or a caller explicitly hides them.
  let toastQueue = [];
  let activeToast = null;
  let activeTimer = null;
  let revealTimer = null;

  function showScreen(screen) {
    elements.welcomeScreen.classList.toggle('active', screen === 'welcome');
    elements.unlockScreen.classList.toggle('active', screen === 'unlock');
    elements.vaultScreen.classList.toggle('active', screen === 'vault');
  }

  function processToastQueue() {
    if (activeToast) return; // already showing
    const item = toastQueue.shift();
    if (!item) return;
    activeToast = item;
    elements.toast.textContent = item.message;
    elements.toast.className = `toast toast-${item.type}`;
    elements.toast.classList.remove('hidden');
    if (!item.persist) {
      activeTimer = setTimeout(() => {
        // hide current then show next
        hideToast();
      }, 3000);
    } else {
      activeTimer = null;
    }
  }

  function showToast(message, type = 'info', persist = false) {
    toastQueue.push({ message, type, persist });
    // process next if nothing is active
    processToastQueue();
  }

  function hideToast() {
    if (activeTimer) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
    activeToast = null;
    elements.toast.classList.add('hidden');
    elements.toast.textContent = '';
    // show next toast in queue
    setTimeout(processToastQueue, 50);
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

  function updateEntryCount(count) {
    elements.entryCount.textContent = count === 1 ? '· 1 entry' : `· ${count} entries`;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function clearRevealTimer() {
    clearTimeout(revealTimer);
    revealTimer = null;
  }

  function scheduleReMask() {
    clearRevealTimer();
    revealTimer = setTimeout(() => {
      elements.entriesList.querySelectorAll('.entry-password:not(.masked)').forEach((span) => {
        span.textContent = '••••••••';
        span.classList.add('masked');
      });
    }, REVEAL_TIMEOUT_MS);
  }

  // Renders an already filtered + sorted list of entries. `totalCount` is
  // the unfiltered entry count, used for the empty-state message and count.
  function renderEntries(entries, { totalCount, query } = {}) {
    elements.entriesList.innerHTML = '';

    if (entries.length === 0) {
      elements.emptyState.classList.toggle('hidden', totalCount > 0);
      if (totalCount > 0 && query) {
        elements.emptyState.textContent = 'No entries match your search.';
        elements.emptyState.classList.remove('hidden');
      } else if (totalCount === 0) {
        elements.emptyState.textContent = 'No entries yet. Click "Add Entry" to save your first password.';
        elements.emptyState.classList.remove('hidden');
      }
      updateEntryCount(totalCount);
      return;
    }

    elements.emptyState.classList.add('hidden');

    for (const entry of entries) {
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

      elements.entriesList.appendChild(card);
    }

    updateEntryCount(totalCount);
  }

  function openEntryModal(editEntry = null) {
    elements.entryModalTitle.textContent = editEntry ? 'Edit Entry' : 'Add Entry';
    elements.entrySite.value = editEntry ? editEntry.site : '';
    elements.entryUsername.value = editEntry ? editEntry.username : '';
    elements.entryPassword.value = editEntry ? editEntry.password : '';
    elements.entryNotes.value = editEntry ? editEntry.notes || '' : '';
    hideError(elements.entryError);
    updatePasswordStrength(elements.entryPassword.value);
    elements.entryModal.showModal();
    elements.entrySite.focus();
  }

  function updatePasswordStrength(password) {
    const result = VaultCrypto.scorePassword(password);
    elements.passwordStrength.className = `password-strength ${result.className}`;
    elements.strengthFill.style.width = result.className === 'strength-empty' ? '0' : '';
    elements.strengthLabel.textContent = result.label;
    elements.passwordStrength.classList.toggle('hidden', !password);
  }

  // Shows the merge-conflict modal and resolves with a { key: 'current' |
  // 'imported' } map, or null if the user cancels.
  function showConflictModal(conflicts) {
    return new Promise((resolve) => {
      elements.conflictList.innerHTML = '';

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
        elements.conflictList.appendChild(item);
      });

      const finish = (result) => {
        elements.conflictForm.removeEventListener('submit', onSubmit);
        $('#conflict-cancel').removeEventListener('click', onCancel);
        $('#conflict-keep-all').removeEventListener('click', onKeepAll);
        $('#conflict-use-all').removeEventListener('click', onUseAll);
        elements.conflictModal.close();
        resolve(result);
      };

      const readResolutions = () => {
        const resolutions = {};
        conflicts.forEach((conflict, index) => {
          const selected = elements.conflictList.querySelector(`input[name="conflict-${index}"]:checked`);
          resolutions[conflict.key] = selected?.value === 'imported' ? 'imported' : 'current';
        });
        return resolutions;
      };

      const onSubmit = (e) => { e.preventDefault(); finish(readResolutions()); };
      const onCancel = () => finish(null);
      const onKeepAll = () => elements.conflictList.querySelectorAll('input[value="current"]').forEach((i) => { i.checked = true; });
      const onUseAll = () => elements.conflictList.querySelectorAll('input[value="imported"]').forEach((i) => { i.checked = true; });

      elements.conflictForm.addEventListener('submit', onSubmit);
      $('#conflict-cancel').addEventListener('click', onCancel);
      $('#conflict-keep-all').addEventListener('click', onKeepAll);
      $('#conflict-use-all').addEventListener('click', onUseAll);
      elements.conflictModal.showModal();
    });
  }

  function clearEntriesDisplay() {
    elements.entriesList.innerHTML = '';
    elements.searchInput.value = '';
  }

  function resetUnlockForm() {
    elements.masterPasswordInput.value = '';
    hideError(elements.unlockError);
  }

  return {
    elements,
    showScreen,
    showToast,
    hideToast,
    showError,
    hideError,
    setBusy,
    updateEntryCount,
    escapeHtml,
    clearRevealTimer,
    scheduleReMask,
    renderEntries,
    openEntryModal,
    updatePasswordStrength,
    showConflictModal,
    clearEntriesDisplay,
    resetUnlockForm,
  };
})();
