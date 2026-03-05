import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';

// Lazy Supabase client getter (avoids throwing at module load time)
let _supabase: ReturnType<typeof createClient> | null = null;
function getSupabase() {
  if (_supabase) return _supabase;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }

  _supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _supabase;
}

/**
 * Hash an API key using SHA-256
 */
function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Validate a Plumb API key and return the associated userId
 */
async function validateApiKey(apiKey: string): Promise<string | null> {
  const hashedKey = hashApiKey(apiKey);

  try {
    const { data, error } = (await getSupabase()
      .from('api_keys')
      .select('id, user_id, revoked_at')
      .eq('hashed_key', hashedKey)
      .single()) as { data: { id: string; user_id: string; revoked_at: string | null } | null; error: any };

    if (error || !data) {
      return null;
    }

    // Check if key is revoked
    if (data.revoked_at) {
      return null;
    }

    // Update last_used_at timestamp (fire and forget)
    void (getSupabase()
      .from('api_keys') as any)
      .update({ last_used_at: new Date().toISOString() })
      .eq('id', data.id);

    return data.user_id;
  } catch (err) {
    console.error('Error validating API key:', err);
    return null;
  }
}

/**
 * Validate a Supabase JWT and return the associated userId
 */
async function validateJwt(token: string): Promise<string | null> {
  try {
    const { data, error } = await getSupabase().auth.getUser(token);

    if (error || !data.user) {
      return null;
    }

    return data.user.id;
  } catch (err) {
    console.error('Error validating JWT:', err);
    return null;
  }
}

/**
 * Auth middleware - validates Authorization header and sets userId on request
 *
 * Accepts two auth methods:
 * 1. Authorization: Bearer <supabase_jwt>
 * 2. Authorization: Bearer plumb_<api_key>
 *
 * Sets req.userId on success, returns 401 on failure
 */
export async function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7); // Remove "Bearer " prefix

  let userId: string | null = null;

  // Check if it's an API key (starts with "plumb_")
  if (token.startsWith('plumb_')) {
    userId = await validateApiKey(token);
  } else {
    // Assume it's a JWT
    userId = await validateJwt(token);
  }

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  // Attach userId to request object
  (req as any).userId = userId;
  next();
}

export default authMiddleware;
