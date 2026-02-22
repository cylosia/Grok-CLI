function computeLCS(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;

  if (m * n > 250_000) {
    return [];
  }
  const dp: number[][] = Array(m + 1)
    .fill(0)
    .map(() => Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  return dp;
}

function extractChanges(
  oldLines: string[],
  newLines: string[],
  lcs: number[][]
): Array<{ oldStart: number; oldEnd: number; newStart: number; newEnd: number }> {
  const changes: Array<{
    oldStart: number;
    oldEnd: number;
    newStart: number;
    newEnd: number;
  }> = [];

  let i = oldLines.length;
  let j = newLines.length;
  let oldEnd = i;
  let newEnd = j;
  let inChange = false;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      if (inChange) {
        changes.unshift({ oldStart: i, oldEnd, newStart: j, newEnd });
        inChange = false;
      }
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i]![j - 1]! >= lcs[i - 1]![j]!)) {
      if (!inChange) {
        oldEnd = i;
        newEnd = j;
        inChange = true;
      }
      j--;
    } else if (i > 0) {
      if (!inChange) {
        oldEnd = i;
        newEnd = j;
        inChange = true;
      }
      i--;
    }
  }

  if (inChange) {
    changes.unshift({ oldStart: 0, oldEnd, newStart: 0, newEnd });
  }

  return changes;
}

export function generateUnifiedDiff(oldLines: string[], newLines: string[], filePath: string): string {
  const CONTEXT_LINES = 3;
  const MAX_DIFF_INPUT_LINES = 2_000;
  const MAX_DIFF_INPUT_CHARS = 200_000;

  const totalInputLines = oldLines.length + newLines.length;
  const totalInputChars = oldLines.join("\n").length + newLines.join("\n").length;
  if (totalInputLines > MAX_DIFF_INPUT_LINES || totalInputChars > MAX_DIFF_INPUT_CHARS) {
    return [
      `Updated ${filePath}`,
      `Diff omitted: input too large for interactive diff rendering (${totalInputLines} lines / ${totalInputChars} chars).`,
    ].join("\n");
  }

  const lcs = computeLCS(oldLines, newLines);
  const changes =
    lcs.length === 0
      ? [{ oldStart: 0, oldEnd: oldLines.length, newStart: 0, newEnd: newLines.length }]
      : extractChanges(oldLines, newLines, lcs);

  const hunks: Array<{
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: Array<{ type: "+" | "-" | " "; content: string }>;
  }> = [];

  let accumulatedOffset = 0;

  for (let changeIdx = 0; changeIdx < changes.length; changeIdx++) {
    const change = changes[changeIdx]!;

    const contextStart = Math.max(0, change.oldStart - CONTEXT_LINES);
    const contextEnd = Math.min(oldLines.length, change.oldEnd + CONTEXT_LINES);

    if (hunks.length > 0) {
      const lastHunk = hunks[hunks.length - 1]!;
      const lastHunkEnd = lastHunk.oldStart + lastHunk.oldCount;

      if (lastHunkEnd >= contextStart) {
        const oldHunkEnd = lastHunk.oldStart + lastHunk.oldCount;
        const newContextEnd = Math.min(oldLines.length, change.oldEnd + CONTEXT_LINES);

        for (let idx = oldHunkEnd; idx < change.oldStart; idx++) {
          lastHunk.lines.push({ type: " ", content: oldLines[idx] ?? "" });
        }

        for (let idx = change.oldStart; idx < change.oldEnd; idx++) {
          lastHunk.lines.push({ type: "-", content: oldLines[idx] ?? "" });
        }
        for (let idx = change.newStart; idx < change.newEnd; idx++) {
          lastHunk.lines.push({ type: "+", content: newLines[idx] ?? "" });
        }

        for (let idx = change.oldEnd; idx < newContextEnd && idx < oldLines.length; idx++) {
          lastHunk.lines.push({ type: " ", content: oldLines[idx] ?? "" });
        }

        // Recompute counts from actual line data to handle cumulative merges correctly
        lastHunk.oldCount = lastHunk.lines.filter(l => l.type === " " || l.type === "-").length;
        lastHunk.newCount = lastHunk.lines.filter(l => l.type === " " || l.type === "+").length;

        continue;
      }
    }

    const hunk: (typeof hunks)[0] = {
      oldStart: contextStart + 1,
      oldCount: contextEnd - contextStart,
      newStart: contextStart + 1 + accumulatedOffset,
      newCount: contextEnd - contextStart + (change.newEnd - change.newStart) - (change.oldEnd - change.oldStart),
      lines: [],
    };

    for (let idx = contextStart; idx < change.oldStart; idx++) {
      hunk.lines.push({ type: " ", content: oldLines[idx] ?? "" });
    }

    for (let idx = change.oldStart; idx < change.oldEnd; idx++) {
      hunk.lines.push({ type: "-", content: oldLines[idx] ?? "" });
    }

    for (let idx = change.newStart; idx < change.newEnd; idx++) {
      hunk.lines.push({ type: "+", content: newLines[idx] ?? "" });
    }

    for (let idx = change.oldEnd; idx < contextEnd && idx < oldLines.length; idx++) {
      hunk.lines.push({ type: " ", content: oldLines[idx] ?? "" });
    }

    hunks.push(hunk);

    accumulatedOffset += (change.newEnd - change.newStart) - (change.oldEnd - change.oldStart);
  }

  let addedLines = 0;
  let removedLines = 0;

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.type === "+") addedLines++;
      if (line.type === "-") removedLines++;
    }
  }

  let summary = `Updated ${filePath}`;
  if (addedLines > 0 && removedLines > 0) {
    summary += ` with ${addedLines} addition${addedLines !== 1 ? "s" : ""} and ${removedLines} removal${
      removedLines !== 1 ? "s" : ""
    }`;
  } else if (addedLines > 0) {
    summary += ` with ${addedLines} addition${addedLines !== 1 ? "s" : ""}`;
  } else if (removedLines > 0) {
    summary += ` with ${removedLines} removal${removedLines !== 1 ? "s" : ""}`;
  } else if (changes.length === 0) {
    return `No changes in ${filePath}`;
  }

  let diff = summary + "\n";
  diff += `--- a/${filePath}\n`;
  diff += `+++ b/${filePath}\n`;

  for (const hunk of hunks) {
    diff += `@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@\n`;

    for (const line of hunk.lines) {
      diff += `${line.type}${line.content}\n`;
    }
  }

  return diff.trim();
}
