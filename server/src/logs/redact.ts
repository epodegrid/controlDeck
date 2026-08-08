/**
 * Keeps prompt and completion text out of the log stream.
 *
 * Model servers log generously. ik_llama.cpp and llama.cpp will print the
 * prompt itself at higher verbosity — chat-template markers, tool-call JSON,
 * whatever the caller sent — straight to stdout. The log panel streams
 * container stdout, so without this an operator sees prompt content in a
 * surface that has nothing to do with the audit trail.
 *
 * That matters because it silently defeats PRD §6.8: content logging is opt-in
 * and scoped per team, model and key, and the Audit page is careful to honour
 * it. A prompt that reaches the screen through the Monitoring page instead has
 * bypassed every one of those toggles — the operator believes content logging
 * is off for that team, and it is, and they are reading the prompt anyway.
 *
 * Operational lines — timings, slot state, HTTP status, errors — are exactly
 * what the panel is for and are never touched. Only content is masked, and the
 * mask is visible so nobody mistakes a redacted stream for a quiet one.
 */

/** Chat-template and tool-call markers that only ever appear inside content. */
const CONTENT_MARKERS = [
  /<\|im_start\|>/,
  /<\|im_end\|>/,
  /<\|start_header_id\|>/,
  /<\|end_header_id\|>/,
  /<\|eot_id\|>/,
  /<\|endoftext\|>/,
  /<\|user\|>/,
  /<\|assistant\|>/,
  /\[INST\]|\[\/INST\]/,
  /<tool_call>|<\/tool_call>/,
];

/** Lines that announce a prompt dump; everything after is content. */
const CONTENT_BLOCK_START = /^\s*(prompt|formatted prompt|full prompt|completion|generated)\s*:\s*$/i;

/**
 * Shapes that mark a line as a log record rather than content. Used to decide
 * when a prompt dump has ended — the next real log line closes the block.
 */
const LOG_LINE_SHAPES = [
  /^(INFO|WARN|WARNING|ERROR|DEBUG|TRACE)\b/i,
  /^\[\d+\]/, // llama.cpp's [timestamp] prefix
  /^slot\s+\w+/, // slot launch_slot_, slot print_timing, ...
  /^\w+:\s+id\s+\d+/,
  /\btid="\d+"/,
  /^(llama_|ggml_|common_|srv\s)/,
];

export const REDACTED = "[content redacted — see the Audit view, where scoped logging applies]";

export function redactionEnabled(): boolean {
  // On by default: leaking prompt text is the more expensive mistake, and an
  // operator who needs raw model output can opt out deliberately.
  return process.env.LOG_REDACT_PROMPTS !== "false";
}

function looksLikeLogLine(text: string): boolean {
  return LOG_LINE_SHAPES.some((re) => re.test(text));
}

function hasContentMarker(text: string): boolean {
  return CONTENT_MARKERS.some((re) => re.test(text));
}

/**
 * Stateful because a prompt dump spans many lines: the opening `prompt:` is a
 * log line, and everything after it is content until the next real log line.
 * One instance per stream.
 */
export function createRedactor(enabled = redactionEnabled()) {
  let inContentBlock = false;

  return function redact(message: string): string {
    if (!enabled) return message;

    if (CONTENT_BLOCK_START.test(message)) {
      inContentBlock = true;
      return `${message.trim()} ${REDACTED}`;
    }

    if (inContentBlock) {
      // A recognisable log line ends the dump; anything else is still content.
      if (looksLikeLogLine(message)) {
        inContentBlock = false;
      } else {
        return REDACTED;
      }
    }

    // Content markers can also appear inline, on a line that is otherwise
    // shaped like a log record.
    if (hasContentMarker(message)) return REDACTED;

    return message;
  };
}
