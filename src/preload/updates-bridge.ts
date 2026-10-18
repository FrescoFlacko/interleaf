import type { z } from 'zod';
import { IPC, IPC_EVENTS } from '@shared/constants/ipc';
import { InterleafError } from '@shared/errors/interleaf-error';
import {
  updateReleasePageResultSchema,
  updateRestartResultSchema,
  updateStateSchema,
} from '@shared/schemas/updates';
import type { InterleafAPI } from '@shared/types/api';
import type { CloneableValue } from '@shared/models/portable';
import type { PreloadInvoke, PreloadIpc } from './index';

type UpdateChannel =
  | typeof IPC.updatesGetState
  | typeof IPC.updatesCheck
  | typeof IPC.updatesDownload
  | typeof IPC.updatesRestart
  | typeof IPC.updatesOpenReleasePage;

/**
 * Application updates. Every request is payload-free, so the renderer cannot
 * point main at a feed, a file or a command, and every reply and pushed state
 * is re-parsed against the shared contract before the page sees it.
 */
export function createUpdatesBridge(invoke: PreloadInvoke, ipc: Pick<PreloadIpc, 'on' | 'removeListener'>): InterleafAPI['updates'] {
  async function invokeParsed<T>(channel: UpdateChannel, schema: z.ZodType<T>): Promise<T> {
    const parsed = schema.safeParse(await invoke(channel));
    if (!parsed.success) throw new InterleafError('internal', 'The update response was invalid.');
    return parsed.data;
  }

  return {
    getState: () => invokeParsed(IPC.updatesGetState, updateStateSchema),
    check: () => invokeParsed(IPC.updatesCheck, updateStateSchema),
    download: () => invokeParsed(IPC.updatesDownload, updateStateSchema),
    restart: () => invokeParsed(IPC.updatesRestart, updateRestartResultSchema),
    openReleasePage: () => invokeParsed(IPC.updatesOpenReleasePage, updateReleasePageResultSchema),
    onState: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: CloneableValue): void => {
        const parsed = updateStateSchema.safeParse(payload);
        if (parsed.success) callback(parsed.data);
      };
      ipc.on(IPC_EVENTS.updatesState, listener);
      return () => { ipc.removeListener(IPC_EVENTS.updatesState, listener); };
    },
  };
}
