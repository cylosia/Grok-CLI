import type { ReactNode } from 'react';
import { Text, Box } from 'ink';
import { sanitizeTerminalText } from '../../utils/terminal-sanitize.js';

export const colorizeCode = (
  content: string,
  _language: string | null,
  _availableTerminalHeight?: number,
  _terminalWidth?: number
): ReactNode => {
  // Simple plain text rendering - could be enhanced with syntax highlighting later
  const sanitized = sanitizeTerminalText(content);
  return (
    <Box flexDirection="column">
      {sanitized.split('\n').map((line, index) => (
        <Text key={index} wrap="wrap">
          {line}
        </Text>
      ))}
    </Box>
  );
};