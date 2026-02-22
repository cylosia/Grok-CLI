import React from "react";
import { ChatEntry } from "../../agent/grok-agent.js";
import { Text } from "ink";

const MemoizedChatEntry = React.memo((props: { entry: ChatEntry }) => {
  return <Text>{props.entry.content}</Text>;
});

export const ChatHistory = ({ entries }: { entries: ChatEntry[] }) => {
  return (
    <>
      {entries.map((entry, i) => (
        <MemoizedChatEntry key={`${entry.type}-${entry.timestamp.getTime()}-${i}`} entry={entry} />
      ))}
    </>
  );
};
