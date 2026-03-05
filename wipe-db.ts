import { existsSync, unlinkSync } from 'fs';

const DB_PATH = '/home/openclaw-host/.plumb/memory.db';

if (existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`✓ Deleted ${DB_PATH}`);
} else {
  console.log(`✓ ${DB_PATH} does not exist (already clean)`);
}
