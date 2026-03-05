import { Router, Request, Response } from 'express';
import type { Router as RouterType } from 'express';
import { createClient } from '@supabase/supabase-js';
import { randomBytes, createHash } from 'crypto';

const router: RouterType = Router();

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
 * Generate a new API key with format: plumb_<64 hex chars>
 */
function generateApiKey(): string {
  const randomPart = randomBytes(32).toString('hex');
  return `plumb_${randomPart}`;
}

/**
 * Hash an API key using SHA-256
 */
function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// POST /v1/keys - Generate a new API key
router.post('/', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const { label } = req.body;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    // Generate new API key
    const apiKey = generateApiKey();
    const hashedKey = hashApiKey(apiKey);

    // Store in database
    const { data, error } = (await getSupabase()
      .from('api_keys')
      .insert({
        user_id: userId,
        hashed_key: hashedKey,
        label: label || null,
      } as any)
      .select('id, label, created_at')
      .single()) as { data: { id: string; label: string | null; created_at: string } | null; error: any };

    if (error || !data) {
      console.error('Error creating API key:', error);
      res.status(500).json({ error: 'Failed to create API key' });
      return;
    }

    // Return the plaintext key (ONLY TIME it's returned)
    res.json({
      key: apiKey,
      id: data.id,
      label: data.label,
      created_at: data.created_at,
    });
  } catch (err) {
    console.error('Error creating API key:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /v1/keys - List user's API keys
router.get('/', async (req: Request, res: Response) => {
  const userId = (req as any).userId;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const { data, error } = (await getSupabase()
      .from('api_keys')
      .select('id, label, created_at, last_used_at, revoked_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })) as {
        data: Array<{
          id: string;
          label: string | null;
          created_at: string;
          last_used_at: string | null;
          revoked_at: string | null;
        }> | null;
        error: any;
      };

    if (error) {
      console.error('Error listing API keys:', error);
      res.status(500).json({ error: 'Failed to list API keys' });
      return;
    }

    res.json({ keys: data });
  } catch (err) {
    console.error('Error listing API keys:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /v1/keys/:id - Revoke an API key
router.delete('/:id', async (req: Request, res: Response) => {
  const userId = (req as any).userId;
  const keyId = req.params.id;

  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  if (!keyId) {
    res.status(400).json({ error: 'Key ID is required' });
    return;
  }

  try {
    // Update the key to set revoked_at timestamp
    const { error } = (await (getSupabase()
      .from('api_keys') as any)
      .update({ revoked_at: new Date().toISOString() })
      .eq('id', keyId)
      .eq('user_id', userId)) as { error: any };

    if (error) {
      console.error('Error revoking API key:', error);
      res.status(500).json({ error: 'Failed to revoke API key' });
      return;
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Error revoking API key:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
export { hashApiKey };
