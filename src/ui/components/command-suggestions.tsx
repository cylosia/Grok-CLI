import { useMemo } from "react";
import { Box, Text } from "ink";

interface CommandSuggestion {
  command: string;
  description: string;
}

interface CommandSuggestionsProps {
  suggestions: CommandSuggestion[];
  input: string;
  selectedIndex: number;
  isVisible: boolean;
}

export const MAX_SUGGESTIONS = 8;

export function filterCommandSuggestions<T extends { command: string }>(
  suggestions: T[],
  input: string
): T[] {
  const lowerInput = input.toLowerCase();
  return suggestions
    .filter((s) => s.command.toLowerCase().startsWith(lowerInput))
    .slice(0, MAX_SUGGESTIONS);
}

export function CommandSuggestions({
  suggestions,
  input,
  selectedIndex,
  isVisible,
}: CommandSuggestionsProps) {
  // useMemo must be called before any conditional return (Rules of Hooks)
  const filteredSuggestions = useMemo(
    () => filterCommandSuggestions(suggestions, input),
    [suggestions, input]
  );

  if (!isVisible) return null;

  return (
    <Box marginTop={1} flexDirection="column">
      {filteredSuggestions.map((suggestion, index) => (
        <Box key={suggestion.command} paddingLeft={1}>
          <Text
            color={index === selectedIndex ? "black" : "white"}
            {...(index === selectedIndex ? { backgroundColor: "cyan" } : {})}
          >
            {suggestion.command}
          </Text>
          <Box marginLeft={1}>
            <Text color="gray">{suggestion.description}</Text>
          </Box>
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          ↑↓ navigate • Enter/Tab select • Esc cancel
        </Text>
      </Box>
    </Box>
  );
}
