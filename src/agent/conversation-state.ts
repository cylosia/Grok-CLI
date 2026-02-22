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

  getChatHistory(): ChatEntry[] {
    return [...this.chatHistory];
  }

  getMessages(): readonly GrokMessage[] {
    return [...this.messages];
  }

  private trimBuffers(): void {
    if (this.chatHistory.length > MAX_CHAT_HISTORY_ENTRIES) {
      this.chatHistory = this.chatHistory.slice(-MAX_CHAT_HISTORY_ENTRIES);
    }

    if (this.messages.length > MAX_MESSAGE_ENTRIES) {
      const systemMessage = this.messages.length > 0 && this.messages[0]?.role === "system"
        ? this.messages[0]
        : undefined;
      const nonSystemMessages = systemMessage ? this.messages.slice(1) : this.messages;
      let tail = nonSystemMessages.slice(-(MAX_MESSAGE_ENTRIES - (systemMessage ? 1 : 0)));

      // Ensure we don't start with an orphaned tool response.
      // A 'tool' message must be preceded by an 'assistant' message with tool_calls.
      while (tail.length > 0 && tail[0]?.role === "tool") {
        tail = tail.slice(1);
      }

      // Ensure we don't start with an assistant message containing tool_calls
      // whose tool responses were trimmed away (API requires every tool_call
      // to have a matching tool response immediately after).
      while (
        tail.length > 0
        && tail[0]?.role === "assistant"
        && tail[0].tool_calls
        && Array.isArray(tail[0].tool_calls)
        && tail[0].tool_calls.length > 0
        && (tail.length < 2 || tail[1]?.role !== "tool")
      ) {
        tail = tail.slice(1);
      }

      this.messages = systemMessage !== undefined ? [systemMessage, ...tail] : tail;
    }
  }
}
