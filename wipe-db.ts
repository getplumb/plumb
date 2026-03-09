import { existsSync, unlinkSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const DB_PATH = process.env.PLUMB_DB_PATH ?? join(homedir(), '.plumb', 'memory.db');

if (existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`✓ Deleted ${DB_PATH}`);
} else {
  console.log(`✓ ${DB_PATH} does not exist (already clean)`);
}
