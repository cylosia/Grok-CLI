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

function isSymlink(filePath: string): boolean {
  try {
    return fs.lstatSync(filePath).isSymbolicLink();
  } catch {
    return false;
  }
}

function safeReadInstructions(filePath: string): string | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  if (isSymlink(filePath)) {
    logger.warn('custom-instructions-symlink-blocked', {
      component: 'custom-instructions',
      path: filePath,
    });
    return null;
  }
  const content = fs.readFileSync(filePath, 'utf-8');
  return sanitizeInstructions(content);
}

export function loadCustomInstructions(workingDirectory: string = process.cwd()): string | null {
  try {
    const localPath = path.join(workingDirectory, '.grok', 'GROK.md');
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
