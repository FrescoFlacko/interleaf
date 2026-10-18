import { IPC, IPC_EVENTS } from '@shared/constants/ipc';
import { isFileCommand } from '@shared/types/files';
import type { InterleafAPI } from '@shared/types/api';
import type { CloneableValue } from '@shared/models/portable';
import type { PreloadInvoke, PreloadIpc } from './index';

/**
 * Open File without joining the library. The renderer can only ask main to
 * choose a file or to hand over the one the operating system requested; it
 * never names a path.
 */
export function createFilesBridge(invoke: PreloadInvoke, ipc: Pick<PreloadIpc, 'on' | 'removeListener'>): InterleafAPI['files'] {
  return {
    openDialog: () => invoke(IPC.filesOpenDialog),
    openPending: () => invoke(IPC.filesOpenPending),
    onCommand: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: CloneableValue): void => {
        if (typeof payload === 'string' && isFileCommand(payload)) callback(payload);
      };
      ipc.on(IPC_EVENTS.filesCommand, listener);
      return () => { ipc.removeListener(IPC_EVENTS.filesCommand, listener); };
    },
  };
}
