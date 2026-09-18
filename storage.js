/**
 * Storage — reading and writing encrypted vault backup files, plus plain
 * CSV export/import.
 *
 * Pure file/IO concerns: naming, encrypting/decrypting backup payloads,
 * and saving via the File System Access API or a plain download.
 *
 * Depends on the global `VaultCrypto` (loaded separately). Deliberately has
 * no dependency on `Vault` — callers that need entries normalized (e.g. to
 * fill in missing ids/timestamps) pass a `normalizeEntry` function into
 * parseBackupFile instead of this module reaching for a `Vault` global.
 * parseCsvFile follows the same rule: it returns plain {site, username,
 * password, notes} objects and lets the caller (app.js) decide how to turn
 * those into vault entries.
 */
const Storage = (() => {
  'use strict';

  const CSV_HEADER = ['site', 'username', 'password', 'notes'];

  function sanitizeFilename(name) {
    const trimmed = name.trim();
    if (!trimmed) return 'vault-backup.vault';
    const withExt = trimmed.endsWith('.vault') ? trimmed : `${trimmed}.vault`;
    return withExt.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  }

  // Shared timestamp-based filename builder. Both the encrypted-backup and
  // CSV filenames only differ by prefix/extension, so this is the one
  // source of truth for the timestamp format.
  function timestampedFilename(prefix, ext) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return `${prefix}-${timestamp}.${ext}`;
  }

  function defaultExportFilename() {
    return timestampedFilename('vault-backup', 'vault');
  }

  function defaultExportCsvFilename() {
    return timestampedFilename('vault-export', 'csv');
  }

  function supportsSaveLocationPicker() {
    return typeof window.showSaveFilePicker === 'function';
  }

  function _escapeCsvField(value) {
    if (value == null) return '';
    const str = String(value);
    if (/[,"\n]/.test(str)) {
      return '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
  }

  function buildCsvContent(entries) {
    // Fields: site, username, password, notes
    const header = ['site', 'username', 'password', 'notes'];
    const lines = [header.join(',')];
    for (const e of entries) {
      const row = [e.site, e.username, e.password, e.notes].map(_escapeCsvField).join(',');
      lines.push(row);
    }
    return lines.join('\n');
  }

  // Parses raw CSV text into an array of rows (each row an array of string
  // fields), following the same quoting rules `_escapeCsvField`/
  // `buildCsvContent` use to write them: fields containing a comma, quote,
  // or newline are wrapped in double quotes, with embedded quotes doubled
  // ("" -> "). Handles \n, \r\n, and lone \r line endings.
  function _parseCsvRecords(text) {
    const records = [];
    let field = '';
    let row = [];
    let inQuotes = false;
    let i = 0;
    const len = text.length;

    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { pushField(); records.push(row); row = []; };

    while (i < len) {
      const char = text[i];

      if (inQuotes) {
        if (char === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          i += 1;
          continue;
        }
        field += char;
        i += 1;
        continue;
      }

      if (char === '"') {
        inQuotes = true;
        i += 1;
        continue;
      }

      if (char === ',') {
        pushField();
        i += 1;
        continue;
      }

      if (char === '\r') {
        if (text[i + 1] === '\n') i += 1; // treat \r\n as one line break
        pushRow();
        i += 1;
        continue;
      }

      if (char === '\n') {
        pushRow();
        i += 1;
        continue;
      }

      field += char;
      i += 1;
    }

    // Trailing row when the file doesn't end with a line break.
    if (field !== '' || row.length > 0) {
      pushRow();
    }

    return records;
  }

  function _isBlankRow(row) {
    return row.length === 1 && row[0].trim() === '';
  }

  function _isCsvHeaderRow(row) {
    if (row.length !== CSV_HEADER.length) return false;
    return row.every((field, idx) => field.trim().toLowerCase() === CSV_HEADER[idx]);
  }

  // Parses a plain-text CSV export back into {site, username, password,
  // notes} objects. Every valid row becomes its own entry — callers that
  // want new entries appended as-is (duplicates included) can pass the
  // result straight to Vault.addEntry.
  //
  // A row is skipped (and counted in `skipped`) when it doesn't have
  // exactly 4 columns, or when `site`/`password` is empty. A fully blank
  // line (e.g. a trailing newline at EOF) is ignored without being counted
  // as skipped. A leading header row matching site,username,password,notes
  // (case-insensitive) is detected and skipped automatically.
  function parseCsvEntries(text) {
    const records = _parseCsvRecords(text);
    const entries = [];
    let skipped = 0;
    let startIndex = 0;

    if (records.length > 0 && _isCsvHeaderRow(records[0])) {
      startIndex = 1;
    }

    for (let i = startIndex; i < records.length; i++) {
      const row = records[i];

      if (_isBlankRow(row)) continue;

      if (row.length !== CSV_HEADER.length) {
        skipped += 1;
        continue;
      }

      const site = (row[0] || '').trim();
      const username = (row[1] || '').trim();
      const password = row[2] || ''; // preserve whitespace; only trimmed for the emptiness check below
      const notes = (row[3] || '').trim();

      if (!site || !password.trim()) {
        skipped += 1;
        continue;
      }

      entries.push({ site, username, password, notes });
    }

    return { entries, skipped };
  }

  async function parseCsvFile(file) {
    const text = await file.text();
    return parseCsvEntries(text);
  }

  async function buildExportContent(cryptoKey, sessionSalt, entries) {
    if (!cryptoKey || !sessionSalt) {
      throw new Error('Vault is locked. Unlock before exporting.');
    }

    const payload = {
      exportedAt: new Date().toISOString(),
      entries,
    };

    const encrypted = await VaultCrypto.encryptWithKey(cryptoKey, sessionSalt, payload);
    return JSON.stringify(encrypted, null, 2);
  }

  // Generic "Save As" via the File System Access API. `accept` follows
  // showSaveFilePicker's own shape: a MIME type mapped to its extensions.
  async function saveWithPicker(content, suggestedFilename, description, accept) {
    const handle = await window.showSaveFilePicker({
      suggestedName: suggestedFilename,
      types: [{ description, accept }],
    });

    const writable = await handle.createWritable();
    await writable.write(content);
    await writable.close();
    return handle.name;
  }

  function saveBackupWithPicker(content, suggestedFilename) {
    return saveWithPicker(content, suggestedFilename, 'Backup Vault', {
      'application/json': ['.vault'],
    });
  }

  function saveCsvWithPicker(content, suggestedFilename) {
    return saveWithPicker(content, suggestedFilename, 'Export to CSV', {
      'text/csv': ['.csv'],
    });
  }

  // Generic plain-download fallback for browsers without the picker API.
  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function downloadBackup(content, filename) {
    return downloadFile(content, filename, 'application/json');
  }

  function downloadCsv(content, filename) {
    return downloadFile(content, filename, 'text/csv');
  }

  // `normalizeEntry` is injected by the caller (e.g. `Vault.normalizeEntry`)
  // rather than referenced as a global, so this module has no compile-time
  // or runtime dependency on Vault. Defaults to the identity function so
  // callers that don't need normalization can omit it.
  async function parseBackupFile(file, password, normalizeEntry = (entry) => entry) {
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

  return {
    sanitizeFilename,
    defaultExportFilename,
    defaultExportCsvFilename,
    supportsSaveLocationPicker,
    buildExportContent,
    buildCsvContent,
    parseCsvEntries,
    parseCsvFile,
    saveBackupWithPicker,
    saveCsvWithPicker,
    downloadBackup,
    downloadCsv,
    parseBackupFile,
  };
})();
