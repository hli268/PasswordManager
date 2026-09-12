# Vault — Session-only Password Manager

Vault is a small client-side, session-only password manager implemented in plain HTML/CSS/JavaScript. All data is kept in memory while the page is open and is erased when the tab/window is closed or the page is reloaded.

User can save the passwords in the browser's local storage. The data is encrypted with a master password
and can be exported to a file. The exported file can be imported back into the app.

## Highlights
- Session-only: no persistent storage by default — data is wiped on unload.
- Strong cryptography for backups: PBKDF2 + AES-GCM (see Security notes).
- Session creation (VaultCrypto.createSession), unlock (unlockSession), verification via AES‑GCM verifier.
- Create / Restore / Merge encrypted backups.
- Entry CRUD: add, edit, delete entries (site, username, password, notes)
- Password generator and strength meter.
- Export backups via download or File System Access API (showSaveFilePicker)
- Auto-lock on inactivity (configurable) and manual lock.
- Native leave-site confirmation when there are unsaved changes.
- Modal dialogs for create/restore/export/merge/conflicts/delete plus a toast notification system.

## Files
- index.html — main UI
- styles.css — UI styling
- crypto.js — cryptographic helpers (PBKDF2, AES-GCM, password scoring, id generation)
- app.js — application logic (vault UI, entries, import/export/merge)
- deplyment.ps1 — builds a single-file HTML with inlined assets

## Build a single-file HTML
- Open PowerShell as user
- Set-ExecutionPolicy Bypass -scope process
- .\deployment.ps1 -Output "vault.html"
- Or run inside CMD:
- powershell -ExecutionPolicy Bypass -File deployment.ps1 -Output "vault.html"

## Requirements
- A modern browser with the Web Crypto API (Chrome, Edge, Firefox, Safari). The app requires crypto.subtle and will show an error if unavailable.
- Serve the files over http://localhost (or another HTTP server). Opening index.html via file:// may disable Web Crypto in some browsers.

## Running locally
### Running in file:// protocol
- file://<your_path>/index.html

### Running in http:// protocol
- Open a terminal (PowserShell or CMD) in the repository root and run a local server (Python 3 is required). 
- python -m http.server 8000
- http://localhost:8000/index.html
- Stop Server: Ctrl+C
- Note: Running a static server is recommended so the Web Crypto API is fully available.

## Usage
### Create or restore a vault
   - Create Vault: choose a strong master password (minimum recommended length: 12 characters). The master password is used to derive a session key in memory.
   - Restore a Previous Vault: import an encrypted backup file and provide the master password used to encrypt it.

### Add entries
   - Click "Add Entry" and provide Site, Username (optional), Password (enter or generate), and Notes.
   - Password strength is shown while typing.

### Copy and reveal
   - Reveal shows the password in the UI temporarily (auto-masked after ~30s).
   - Copy copies the value to the clipboard and the app attempts to clear the clipboard after ~15s.

### Export / Backup
   - Export produces a downloaded, encrypted backup file. You must choose a passphrase to protect the backup.
   - The backup file is encrypted using PBKDF2-derived AES-GCM. Keep the backup passphrase safe — it is required to restore the file.

### Merge backups
   - Merge lets you import another backup and merge entries. The app detects conflicts (same site/username but different password) and prompts you to keep existing or use imported values.

### Locking and session behavior
   - The vault auto-locks after an inactivity timeout (configurable in the header). When locked, the encryption key is cleared from memory and you must re-enter the master password to unlock the session.
   - Closing the tab or reloading the page wipes all in-memory vault data. If you have not exported a backup, the app will warn before closing.

## Backup format & Security notes
- Backups are encrypted using PBKDF2 (600,000 iterations) and AES-GCM.
- The app derives session keys from the master password in memory; session keys and entries are never written to persistent storage by default.
- Minimum recommended master password length: 12 characters (enforced as a recommendation in the UI/crypto helpers).
- The app attempts to limit exposure by clearing clipboard contents after a short delay and auto-remasking revealed passwords.

Important: This project is a client-side, session-only tool. It is not intended as a production-grade remote password service. Treat it as a convenience for managing secrets in a local, ephemeral session and make regular encrypted backups if you need persistence.

## Troubleshooting
- If the app reports that Web Crypto is unavailable, make sure you open it over HTTP(S) (not file://) and use a modern browser.
- If you cannot restore a backup, verify you used the correct backup passphrase. Corrupted or wrong-password-protected backups will fail to decrypt.

## License
See repository for license and attribution.
