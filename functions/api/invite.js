import { handleInvite } from '../../lib/invite-server.js';
export const onRequestPost = ctx => handleInvite(ctx);
