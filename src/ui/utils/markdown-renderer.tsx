import { Text } from 'ink';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { logger } from '../../utils/logger.js';
import { sanitizeTerminalText } from '../../utils/terminal-sanitize.js';

// Configure marked to use the terminal renderer with default settings
marked.setOptions({
  renderer: new TerminalRenderer()
});

export function MarkdownRenderer({ content }: { content: string }) {
  try {
    // Force synchronous parsing; marked.parse can return Promise in async mode
    const result = marked.parse(content, { async: false }) as string;
    const rendered = sanitizeTerminalText(result);
    return <Text>{rendered}</Text>;
  } catch (error) {
    // Fallback to plain text if markdown parsing fails
    logger.warn('markdown-render-failed', { component: 'markdown-renderer', error: error instanceof Error ? error.message : String(error) });
    return <Text>{sanitizeTerminalText(content)}</Text>;
  }
}
