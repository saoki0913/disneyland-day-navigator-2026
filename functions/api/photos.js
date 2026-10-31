import { handlePhotos } from '../../lib/server.js';
export const onRequestGet = (ctx) => handlePhotos(ctx);
