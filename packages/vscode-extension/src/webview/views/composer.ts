import { shouldSubmitComposerKey } from "../presentation.js"

export function composerSubmitIntent(
  event: {
    key: string
    shiftKey: boolean
    ctrlKey?: boolean
    metaKey?: boolean
    altKey: boolean
    isComposing: boolean
  },
  behavior?: "send" | "newline",
  active = false,
): "none" | "send" | "steer" {
  if (!shouldSubmitComposerKey(event, behavior)) return "none"
  return active && event.altKey ? "steer" : "send"
}
