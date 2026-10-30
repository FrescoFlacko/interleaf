import { z } from 'zod';

/**
 * The close handshake's one payload: main's `app:before-close` request and the
 * renderer's `app:close-ready` reply each carry exactly the request id main
 * minted with `randomUUID`, and nothing else.
 */
export const closeHandshakePayloadSchema = z.strictObject({ requestId: z.uuid({ version: 'v4' }) });
