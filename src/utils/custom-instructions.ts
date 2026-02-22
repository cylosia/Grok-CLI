import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const MAX_CUSTOM_INSTRUCTIONS_BYTES = 4096;
const CONTROL_CHARS_PATTERN = /[\u0000-\u0008\u000B-\u001F\u007F]/g;

function sanitizeInstructions(raw: string): string {
  const trimmed = raw.trim();
  const truncated = trimmed.length > MAX_CUSTOM_INSTRUCTIONS_BYTES
    ? trimmed.slice(0, MAX_CUSTOM_INSTRUCTIONS_BYTES)
    : trimmed;
  return truncated.replace(CONTROL_CHARS_PATTERN, '');
}

export function loadCustomInstructions(workingDirectory: string = process.cwd()): string | null {
  try {
    let instructionsPath = path.join(workingDirectory, '.grok', 'GROK.md');

    if (fs.existsSync(instructionsPath)) {
      const customInstructions = fs.readFileSync(instructionsPath, 'utf-8');
      return sanitizeInstructions(customInstructions);
    }

    instructionsPath = path.join(os.homedir(), '.grok', 'GROK.md');

    if (fs.existsSync(instructionsPath)) {
      const customInstructions = fs.readFileSync(instructionsPath, 'utf-8');
      return sanitizeInstructions(customInstructions);
    }

    return null;
  } catch (error) {
    console.warn('Failed to load custom instructions:', error);
    return null;
  }
}
