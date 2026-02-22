import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from './logger.js';

const MAX_CUSTOM_INSTRUCTIONS_BYTES = 4096;
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function sanitizeInstructions(raw: string): string {
  const trimmed = raw.trim();
  const truncated = trimmed.length > MAX_CUSTOM_INSTRUCTIONS_BYTES
    ? trimmed.slice(0, MAX_CUSTOM_INSTRUCTIONS_BYTES)
    : trimmed;
  return truncated.replace(CONTROL_CHARS_PATTERN, '');
}

function safeReadInstructions(filePath: string): string | null {
  let fd: number | undefined;
  try {
    // Open with O_NOFOLLOW to atomically reject symlinks (avoids TOCTOU)
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stats = fs.fstatSync(fd);
    if (!stats.isFile() || stats.size > MAX_CUSTOM_INSTRUCTIONS_BYTES * 2) {
      return null;
    }
    const buffer = Buffer.alloc(stats.size);
    fs.readSync(fd, buffer, 0, stats.size, 0);
    return sanitizeInstructions(buffer.toString('utf-8'));
  } catch (err: unknown) {
    // ENOENT = file doesn't exist, ELOOP = symlink with O_NOFOLLOW
    const code = err && typeof err === 'object' && 'code' in err ? (err as { code: string }).code : '';
    if (code === 'ELOOP') {
      logger.warn('custom-instructions-symlink-blocked', {
        component: 'custom-instructions',
        path: filePath,
      });
    }
    return null;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export function loadCustomInstructions(workingDirectory: string = process.cwd()): string | null {
  try {
    const resolvedDir = path.resolve(workingDirectory);
    const localPath = path.join(resolvedDir, '.grok', 'GROK.md');
    const localResult = safeReadInstructions(localPath);
    if (localResult !== null) {
      return localResult;
    }

    const globalPath = path.join(os.homedir(), '.grok', 'GROK.md');
    const globalResult = safeReadInstructions(globalPath);
    if (globalResult !== null) {
      return globalResult;
    }

    return null;
  } catch (error) {
    logger.warn('custom-instructions-load-failed', {
      component: 'custom-instructions',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
