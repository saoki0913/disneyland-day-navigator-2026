import { handleRestrooms } from '../../lib/server.js';
export const onRequestGet = (ctx) => handleRestrooms(ctx);
