import { IPC } from '@shared/constants/ipc';
import type { IpcContracts } from '@shared/schemas/ipc';
import type { UpdateController } from '../updates/update-runtime';

/**
 * The application-update channels. Each takes no payload (the dispatcher has
 * already rejected one) and reaches only main's update controller, which owns
 * the feed, the verified version, the download and the restart barrier.
 */

export type UpdateHandlerDeps = {
  readonly updates: Pick<UpdateController, 'getState' | 'check' | 'download' | 'restart' | 'openReleasePage' | 'setAutomaticChecks'>;
};

type UpdateChannel =
  | typeof IPC.updatesGetState
  | typeof IPC.updatesCheck
  | typeof IPC.updatesDownload
  | typeof IPC.updatesRestart
  | typeof IPC.updatesOpenReleasePage;

type UpdateHandlers = { [K in UpdateChannel]: () => Promise<IpcContracts[K]['result']> | IpcContracts[K]['result'] };

export function buildUpdateHandlers(deps: UpdateHandlerDeps): UpdateHandlers {
  return {
    [IPC.updatesGetState]: () => deps.updates.getState(),
    [IPC.updatesCheck]: () => deps.updates.check(),
    [IPC.updatesDownload]: () => deps.updates.download(),
    [IPC.updatesRestart]: () => deps.updates.restart(),
    [IPC.updatesOpenReleasePage]: () => deps.updates.openReleasePage(),
  };
}
