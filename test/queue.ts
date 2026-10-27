export const queueWrapper = (notice: string) =>
  'The user sent a new message while you were working:\n' + notice +
  '\n\nThis is how Claude Code surfaces messages the user sends mid-turn — within the running turn, often alongside the next tool result, rather than as a separate conversation turn. Address the message above as you continue this turn.'
