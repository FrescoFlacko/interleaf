import type { Session } from 'electron';
import type { Logger } from '../logging/logger';

/**
 * Deny-by-default permission policy for renderer sessions
 * (docs/SECURITY.md §3). Interleaf's reader needs no privileged browser
 * permissions; any request is treated as a security event and logged.
 */
export function installPermissionGuards(session: Session, log: Logger): void {
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    log.warn('denied permission request', { permission });
    callback(false);
  });

  session.setPermissionCheckHandler((_webContents, permission) => {
    log.warn('denied permission check', { permission });
    return false;
  });

  session.setDevicePermissionHandler((details) => {
    log.warn('denied device access', { deviceType: details.deviceType });
    return false;
  });
}
