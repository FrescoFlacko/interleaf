// Playwright's Electron loader selects Chromium's basic-text store by default.
// This opt-in test preload selects the actual Secret Service in an isolated
// DBus session; production still checks the selected backend and fails closed.
import { app } from 'electron';

export type SecureKeyringBackend = 'gnome_libsecret';
app.commandLine.appendSwitch('password-store', 'gnome-libsecret');
