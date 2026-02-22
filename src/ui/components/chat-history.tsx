import React from "react";
import { ChatEntry } from "../../agent/grok-agent.js";
import { Text } from "ink";
import { sanitizeTerminalText } from "../../utils/terminal-sanitize.js";

const MemoizedChatEntry = React.memo(function MemoizedChatEntry(props: { entry: ChatEntry }) {
  return <Text>{sanitizeTerminalText(props.entry.content ?? "")}</Text>;
});
MemoizedChatEntry.displayName = "MemoizedChatEntry";

export const ChatHistory = ({ entries }: { entries: ChatEntry[] }) => {
  return (
    <>
      {entries.map((entry, i) => (
        <MemoizedChatEntry key={`${entry.timestamp.getTime()}-${i}`} entry={entry} />
      ))}
    </>
  );
};
