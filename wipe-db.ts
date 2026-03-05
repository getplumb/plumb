import { existsSync, unlinkSync } from 'fs';

const DB_PATH = '~/..plumb/memory.db';

if (existsSync(DB_PATH)) {
  unlinkSync(DB_PATH);
  console.log(`✓ Deleted ${DB_PATH}`);
} else {
  console.log(`✓ ${DB_PATH} does not exist (already clean)`);
}
