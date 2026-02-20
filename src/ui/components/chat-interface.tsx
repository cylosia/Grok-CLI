import { useState } from "react";
import { GrokAgent, ChatEntry } from "../../agent/grok-agent.js";
import { ChatHistory } from "./chat-history.js";
import ConfirmationDialog from "./confirmation-dialog.js";

interface ChatInterfaceProps {
  agent: GrokAgent;
  initialMessage?: string;
}

interface ConfirmationOptions {
  operation: string;
  filename: string | undefined;
  onConfirm: (dontAskAgain?: boolean) => void;
  onReject: (feedback?: string) => void;
  showVSCodeOpen?: boolean;
  content?: string;
}

const ChatInterface = ({ agent: _agent, initialMessage: _initialMessage }: ChatInterfaceProps) => {
  const [chatHistory] = useState<ChatEntry[]>([]);
  const [confirmationOptions] = useState<ConfirmationOptions | null>(null);

  return (
    <>
      <ChatHistory entries={chatHistory} />
      {confirmationOptions && <ConfirmationDialog {...confirmationOptions} />}
    </>
  );
};

export default ChatInterface;
