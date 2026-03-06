export { plugin } from './plugin-module.js';
export { createPostExchangeHook } from './hooks/post-exchange.js';

// Default export required by OpenClaw plugin loader
import { plugin } from './plugin-module.js';
export default plugin;
