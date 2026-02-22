import { Text } from 'ink';
import { Marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { logger } from '../../utils/logger.js';
import { sanitizeTerminalText } from '../../utils/terminal-sanitize.js';

// Use a local Marked instance to avoid mutating the global singleton
const localMarked = new Marked({ renderer: new TerminalRenderer(), async: false });

export function MarkdownRenderer({ content }: { content: string }) {
  try {
    const result = localMarked.parse(content);
    const rendered = typeof result === 'string' ? sanitizeTerminalText(result) : sanitizeTerminalText(content);
    return <Text>{rendered}</Text>;
  } catch (error) {
    logger.warn('markdown-render-failed', { component: 'markdown-renderer', error: error instanceof Error ? error.message : String(error) });
    return <Text>{sanitizeTerminalText(content)}</Text>;
  }
}
