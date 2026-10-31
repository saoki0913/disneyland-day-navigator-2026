import { handleShareGet, handleSharePost } from '../../../lib/share-server.js';
export const onRequestGet = (ctx) => handleShareGet(ctx);
export const onRequestPost = (ctx) => handleSharePost(ctx);
