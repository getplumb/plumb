import { confirm } from '@inquirer/prompts';
import { exec, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { existsSync, unlinkSync } from 'node:fs';
import ora from 'ora';

const execAsync = promisify(exec);

/**
 * Check if OpenClaw is installed in PATH.
 * Returns true if found, false otherwise.
 */
function checkOpenClawInstalled(): boolean {
  try {
    const isWindows = platform() === 'win32';
    const cmd = isWindows ? 'where.exe' : 'which';
    execFileSync(cmd, ['openclaw'], {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Main uninstall command
 */
export async function uninstallCommand(): Promise<void> {
  console.log();
  console.log('  🪣  Plumb Uninstaller');
  console.log();

  // Step 1: Confirm uninstall
  const shouldContinue = await confirm({
    message: 'This will remove Plumb from OpenClaw. Continue?',
    default: false,
  });

  if (!shouldContinue) {
    console.log('\nUninstall cancelled.\n');
    process.exit(0);
    return;
  }

  // Step 2: Check if OpenClaw is installed
  if (!checkOpenClawInstalled()) {
    console.log('\n⚠️  OpenClaw not found in PATH.');
    console.log('If you have OpenClaw installed, remove Plumb manually:');
    console.log('  openclaw plugins uninstall plumb\n');
  } else {
    // Run openclaw plugins uninstall
    const spinner = ora('Removing Plumb from OpenClaw...').start();

    try {
      const { stdout, stderr } = await execAsync('openclaw plugins uninstall plumb --force');

      spinner.succeed('Removed Plumb from OpenClaw');

      // Show output if available
      if (stdout && stdout.trim()) {
        console.log(stdout.trim());
      }
      if (stderr && stderr.trim()) {
        console.warn(stderr.trim());
      }
    } catch (err: unknown) {
      spinner.fail('Could not auto-remove from OpenClaw');

      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      console.error('\nRemove manually: openclaw plugins uninstall plumb\n');

      // Continue with rest of uninstall flow even if this fails
    }
  }

  console.log();

  // Step 3: Ask about memory database
  const dbPath = join(homedir(), '.plumb', 'memory.db');
  const dbExists = existsSync(dbPath);

  if (dbExists) {
    const keepDb = await confirm({
      message: `Keep your memory database at ${dbPath}?`,
      default: true,
    });

    if (!keepDb) {
      try {
        unlinkSync(dbPath);
        console.log(`\n✓ Deleted ${dbPath}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`\n⚠️  Could not delete database: ${message}`);
      }
    } else {
      console.log(`\n✓ Keeping ${dbPath}`);
    }
  }

  console.log();

  // Step 4: Ask about uninstalling CLI globally
  const uninstallCli = await confirm({
    message: 'Uninstall plumb CLI globally? (npm uninstall -g @getplumb/cli)',
    default: false,
  });

  if (uninstallCli) {
    const cliSpinner = ora('Uninstalling @getplumb/cli...').start();

    try {
      await execAsync('npm uninstall -g @getplumb/cli');
      cliSpinner.succeed('Uninstalled @getplumb/cli');
    } catch (err: unknown) {
      cliSpinner.fail('Could not uninstall CLI package');
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Error: ${message}`);
      console.error('Run manually: npm uninstall -g @getplumb/cli');
    }
  }

  // Step 5: Print summary
  console.log();
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Summary');
  console.log('  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log();
  console.log('  Removed:');
  console.log('    • Plumb plugin from OpenClaw');

  if (dbExists && !existsSync(dbPath)) {
    console.log(`    • Memory database (${dbPath})`);
  }

  if (uninstallCli) {
    console.log('    • @getplumb/cli package');
  }

  console.log();
  console.log('  Kept:');

  if (dbExists && existsSync(dbPath)) {
    console.log(`    • Memory database (${dbPath})`);
  }

  if (!uninstallCli) {
    console.log('    • @getplumb/cli package');
  }

  console.log();
  console.log('  Thanks for using Plumb!');
  console.log();
}
