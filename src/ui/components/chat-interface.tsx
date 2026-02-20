import { useState } from "react";
import { GrokAgent, ChatEntry } from "../../agent/grok-agent.js";
import { ChatHistory } from "./chat-history.js";
import ConfirmationDialog from "./confirmation-dialog.js";
import { Text } from "ink";

interface ChatInterfaceProps {
  agent: GrokAgent;
  initialMessage?: string;
}

const ChatInterface = ({ agent, initialMessage }: ChatInterfaceProps) => {
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [confirmationOptions, setConfirmationOptions] = useState<any>(null);

  return (
    <>
      <ChatHistory entries={chatHistory} />
      {confirmationOptions && <ConfirmationDialog {...confirmationOptions} />}
    </>
  );
};

export default ChatInterface;
