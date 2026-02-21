import { ChatEntry, GrokAgent } from "../agent/grok-agent.js";

interface CommitAndPushContext {
  agent: GrokAgent;
  setChatHistory: React.Dispatch<React.SetStateAction<ChatEntry[]>>;
  setIsProcessing: (processing: boolean) => void;
  setIsStreaming: (streaming: boolean) => void;
}

function appendChatEntry(
  setChatHistory: React.Dispatch<React.SetStateAction<ChatEntry[]>>,
  entry: ChatEntry
): void {
  setChatHistory((prev) => [...prev, entry]);
}

export async function runCommitAndPushFlow({
  agent,
  setChatHistory,
  setIsProcessing,
  setIsStreaming,
}: CommitAndPushContext): Promise<void> {
  appendChatEntry(setChatHistory, {
    type: "user",
    content: "/commit-and-push",
    timestamp: new Date(),
  });

  setIsProcessing(true);
  setIsStreaming(true);

  try {
    const initialStatusResult = await agent.executeBashCommand("git status --porcelain");

    if (!initialStatusResult.success || !initialStatusResult.output?.trim()) {
      appendChatEntry(setChatHistory, {
        type: "assistant",
        content: "No changes to commit. Working directory is clean.",
        timestamp: new Date(),
      });
      return;
    }

    const addResult = await agent.executeBashCommand("git add -A");
    if (!addResult.success) {
      appendChatEntry(setChatHistory, {
        type: "assistant",
        content: `Failed to stage changes: ${addResult.error || "Unknown error"}`,
        timestamp: new Date(),
      });
      return;
    }

    appendChatEntry(setChatHistory, {
      type: "tool_result",
      content: "Tracked changes staged successfully",
      timestamp: new Date(),
      toolCall: {
        id: `git_add_${Date.now()}`,
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: "git add -A" }),
        },
      },
      toolResult: addResult,
    });

    const stagedFilesResult = await agent.executeBashCommand("git diff --cached --name-only");
    const stagedStatsResult = await agent.executeBashCommand("git diff --cached --stat");
    const commitPrompt = `Generate a concise, professional git commit message for these changes:\n\nGit Status:\n${initialStatusResult.output}\n\nStaged Files:\n${stagedFilesResult.output || "No staged files shown"}\n\nDiff Summary:\n${stagedStatsResult.output || "No diff summary shown"}\n\nDo not include any secrets or file contents in the response.\nFollow conventional commit format (feat:, fix:, docs:, etc.) and keep it under 72 characters.\nRespond with ONLY the commit message, no additional text.`;

    let commitMessage = "";
    let streamingEntry: ChatEntry | null = null;

    for await (const chunk of agent.processUserMessageStream(commitPrompt)) {
      if (chunk.type === "content" && chunk.content) {
        if (!streamingEntry) {
          const newEntry: ChatEntry = {
            type: "assistant",
            content: `Generating commit message...\n\n${chunk.content}`,
            timestamp: new Date(),
            isStreaming: true,
          };
          appendChatEntry(setChatHistory, newEntry);
          streamingEntry = newEntry;
          commitMessage = chunk.content;
        } else {
          commitMessage += chunk.content;
          setChatHistory((prev) =>
            prev.map((entry, idx) =>
              idx === prev.length - 1 && entry.isStreaming
                ? {
                  ...entry,
                  content: `Generating commit message...\n\n${commitMessage}`,
                }
                : entry
            )
          );
        }
      } else if (chunk.type === "done") {
        if (streamingEntry) {
          setChatHistory((prev) =>
            prev.map((entry) =>
              entry.isStreaming
                ? {
                  ...entry,
                  content: `Generated commit message: "${commitMessage.trim()}"`,
                  isStreaming: false,
                }
                : entry
            )
          );
        }
        break;
      }
    }

    const cleanCommitMessage = commitMessage
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/[\n\r\0]/g, " ");

    const commitResult = await agent.executeBashCommandArgs("git", [
      "commit",
      "-m",
      cleanCommitMessage,
    ]);

    const commitCommand = `git commit -m ${JSON.stringify(cleanCommitMessage)}`;

    appendChatEntry(setChatHistory, {
      type: "tool_result",
      content: commitResult.success
        ? commitResult.output || "Commit successful"
        : commitResult.error || "Commit failed",
      timestamp: new Date(),
      toolCall: {
        id: `git_commit_${Date.now()}`,
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: commitCommand }),
        },
      },
      toolResult: commitResult,
    });

    if (!commitResult.success) {
      return;
    }

    let pushResult = await agent.executeBashCommand("git push");
    let pushCommand = "git push";

    if (!pushResult.success && pushResult.error?.includes("no upstream branch")) {
      pushCommand = "git push -u origin HEAD";
      pushResult = await agent.executeBashCommand(pushCommand);
    }

    appendChatEntry(setChatHistory, {
      type: "tool_result",
      content: pushResult.success
        ? pushResult.output || "Push successful"
        : pushResult.error || "Push failed",
      timestamp: new Date(),
      toolCall: {
        id: `git_push_${Date.now()}`,
        type: "function",
        function: {
          name: "bash",
          arguments: JSON.stringify({ command: pushCommand }),
        },
      },
      toolResult: pushResult,
    });
  } catch (error: unknown) {
    appendChatEntry(setChatHistory, {
      type: "assistant",
      content: `Error during commit and push: ${error instanceof Error ? error.message : String(error)}`,
      timestamp: new Date(),
    });
  } finally {
    setIsProcessing(false);
    setIsStreaming(false);
  }
}
