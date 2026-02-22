import { GrokMessage } from "../grok/client.js";
import type { ChatEntry } from "./grok-agent.js";

const MAX_CHAT_HISTORY_ENTRIES = 500;
const MAX_MESSAGE_ENTRIES = 500;

export class ConversationState {
  private chatHistory: ChatEntry[] = [];
  private messages: GrokMessage[] = [];

  setSystemPrompt(content: string): void {
    this.messages = [{ role: "system", content }];
  }

  addChatEntry(entry: ChatEntry): void {
    this.chatHistory.push(entry);
    this.trimBuffers();
  }

  addMessage(message: GrokMessage): void {
    this.messages.push(message);
    this.trimBuffers();
  }

  getMessages(): GrokMessage[] {
    return this.messages;
  }

  getChatHistory(): ChatEntry[] {
    return [...this.chatHistory];
  }

  private trimBuffers(): void {
    if (this.chatHistory.length > MAX_CHAT_HISTORY_ENTRIES) {
      this.chatHistory = this.chatHistory.slice(-MAX_CHAT_HISTORY_ENTRIES);
    }

    if (this.messages.length > MAX_MESSAGE_ENTRIES) {
      const systemMessage = this.messages[0];
      let tail = this.messages.slice(-(MAX_MESSAGE_ENTRIES - 1));

      // Ensure we don't start with an orphaned tool response.
      // A 'tool' message must be preceded by an 'assistant' message with tool_calls.
      while (tail.length > 0 && tail[0]?.role === "tool") {
        tail = tail.slice(1);
      }

      this.messages = systemMessage ? [systemMessage, ...tail] : tail;
    }
  }
}
