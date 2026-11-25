// Claude's `session-title` adapter: reads a UserPromptSubmit hook's input and writes the output that
// sets the session's title. Translation only; whether to set a title is the caller's decision.
//
// Claude passes the submitted prompt as `prompt` and the session's custom title, whether a person
// or an earlier hook set it, as `session_title`; the field is absent when no custom title is set.

// Throws on input that is not a JSON object, so the caller can stay silent on malformed input.
function readHookInput(text) {
  const input = JSON.parse(text);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("hook input is not a JSON object");
  return {
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    title: typeof input.session_title === "string" && input.session_title.trim() ? input.session_title : null,
  };
}

function hookOutput({ title }) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", sessionTitle: title } });
}

export const claudeSessionTitle = Object.freeze({ readHookInput, hookOutput });
