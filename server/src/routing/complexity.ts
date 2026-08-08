import type { ChatCompletionRequest, ChatMessage } from "../types.js";

/**
 * Rule-based "is this request complex enough to warrant the large model"
 * heuristic. No ML classifier, no self-assessment round-trip — just simple,
 * documented signals over the request text, per PRD §6.3 Step 2.
 *
 * Thresholds below are deliberately conservative defaults tuned for a
 * self-hosted gateway where the "fast" model is the cost-preferred default:
 * we only escalate to "large" when there's a reasonably clear signal.
 */

// Sum of all message content lengths (flattening multi-part content to its
// text length) beyond which we consider the prompt "long" on its own.
const LONG_PROMPT_CHAR_THRESHOLD = 4000;

// A single fenced code block at or above this many characters is treated as
// a complexity signal (large code review/refactor tasks tend to want the
// bigger model).
const LARGE_CODE_BLOCK_CHAR_THRESHOLD = 800;

// Keyword/phrase markers commonly associated with deep multi-step reasoning
// requests. Matched case-insensitively as substrings.
const COMPLEX_REASONING_MARKERS = [
  "step by step",
  "step-by-step",
  "prove",
  "analyze in depth",
  "in-depth analysis",
  "think through",
  "reason through",
  "chain of thought",
];

export type ComplexitySignals = {
  totalPromptLength: number;
  hasComplexReasoningMarker: boolean;
  hasLargeCodeBlock: boolean;
  hasMultiPartQuestion: boolean;
  toolsRequested: boolean;
};

export function computeComplexitySignals(request: ChatCompletionRequest): ComplexitySignals {
  const text = flattenMessages(request.messages);
  const lowerText = text.toLowerCase();

  return {
    totalPromptLength: text.length,
    hasComplexReasoningMarker: COMPLEX_REASONING_MARKERS.some((marker) => lowerText.includes(marker)),
    hasLargeCodeBlock: hasLargeFencedCodeBlock(text),
    hasMultiPartQuestion: hasMultiPartQuestion(text),
    toolsRequested: Array.isArray(request.tools) && request.tools.length > 0,
  };
}

/**
 * Whether the request is "complex" enough that, all else equal, we should
 * prefer a large model over a fast one (when both are viable candidates).
 */
export function isComplex(signals: ComplexitySignals): boolean {
  return (
    signals.totalPromptLength >= LONG_PROMPT_CHAR_THRESHOLD ||
    signals.hasComplexReasoningMarker ||
    signals.hasLargeCodeBlock ||
    signals.hasMultiPartQuestion
  );
}

function flattenMessages(messages: ChatMessage[]): string {
  return messages
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      // An assistant message that only carries tool_calls has content: null —
      // the standard shape of every multi-turn tool conversation. Calling
      // .map on it threw, so the second turn of any tool exchange crashed the
      // router with a 500.
      if (!Array.isArray(message.content)) return "";
      return message.content
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join(" ");
    })
    .join("\n");
}

function hasLargeFencedCodeBlock(text: string): boolean {
  const fenceMatches = text.match(/```[\s\S]*?```/g);
  if (!fenceMatches) return false;
  return fenceMatches.some((block) => block.length >= LARGE_CODE_BLOCK_CHAR_THRESHOLD);
}

/**
 * Crude "multi-part question" detector: several distinct numbered/lettered
 * list items (e.g. "1) ... 2) ...") or several question marks, indicating
 * the caller is asking the model to juggle multiple sub-questions at once.
 */
function hasMultiPartQuestion(text: string): boolean {
  const numberedItems = text.match(/(?:^|\s)\d+[).]\s/g);
  if (numberedItems && numberedItems.length >= 2) return true;

  const questionMarks = text.match(/\?/g);
  if (questionMarks && questionMarks.length >= 3) return true;

  return false;
}
