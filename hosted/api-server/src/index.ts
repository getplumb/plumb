// Plumb hosted API server — auth, API keys, and MCP-over-HTTP endpoints
//
// Exports:
// - authMiddleware: validates Supabase JWT or Plumb API keys
// - authRouter: POST /v1/auth/signup, POST /v1/auth/login
// - keysRouter: POST /v1/keys, GET /v1/keys, DELETE /v1/keys/:id
//
// Full server setup (with Express app and MCP endpoints) is added in T-014.

export { default as authMiddleware } from './auth-middleware.js';
export { default as authRouter } from './routes/auth.js';
export { default as keysRouter } from './routes/keys.js';
