import { Text } from 'ink';
import { marked } from 'marked';
import TerminalRenderer from 'marked-terminal';
import { logger } from '../../utils/logger.js';

// Configure marked to use the terminal renderer with default settings
marked.setOptions({
  renderer: new TerminalRenderer()
});

export function MarkdownRenderer({ content }: { content: string }) {
  try {
    // Use marked.parse for synchronous parsing
    const result = marked.parse(content);
    // Handle both sync and async results
    const rendered = typeof result === 'string' ? result : content;
    return <Text>{rendered}</Text>;
  } catch (error) {
    // Fallback to plain text if markdown parsing fails
    logger.warn('markdown-render-failed', { component: 'markdown-renderer', error: error instanceof Error ? error.message : String(error) });
    return <Text>{content}</Text>;
  }
}
