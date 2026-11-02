import { handleRecords } from '../../lib/records-server.js';
export const onRequestGet = (ctx) => handleRecords(ctx);
export const onRequestPost = (ctx) => handleRecords(ctx);
