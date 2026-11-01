import { json } from '../../lib/server.js';
export const onRequestGet = () => json({ ok: true, app: 'dl-navi-1031', parks: ['dl', 'dca'], time: new Date().toISOString() });
