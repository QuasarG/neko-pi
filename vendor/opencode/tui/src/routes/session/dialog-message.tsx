import { createMemo } from "solid-js"
import { useData } from "../../context/data"
import { DialogSelect } from "../../ui/dialog-select"
import { useClipboard } from "../../context/clipboard"
import { useToast } from "../../ui/toast"
import { useTuiApp } from "../../context/runtime"
import { errorMessage } from "../../util/error"
import { DialogFork } from "./dialog-fork"
import type { PromptInfo } from "../../prompt/history"
import { projectedPromptInput } from "../../prompt/codec"
import { useNewDesigns } from "../../config"

export function DialogMessage(props: {
  messageID: string
  sessionID: string
  setPrompt?: (prompt: PromptInfo) => void
}) {
  const data = useData()
  const clipboard = useClipboard()
  const toast = useToast()
  const app = useTuiApp()
  const newDesigns = useNewDesigns()
  const message = createMemo(() => data.session.message.get(props.sessionID, props.messageID))
  const failed = createMemo(() => {
    const messages = data.session.message.list(props.sessionID)
    const user = messages.findLast((item) => item.type === "user")
    return user?.id === props.messageID && data.session.get(props.sessionID)?.outcome === "failed"
  })

  return (
    <DialogSelect
      title="Message Actions"
      renderFilter={!newDesigns()}
      options={[
        ...(app.nekoEndpoint && failed()
          ? [{
              title: "Retry",
              value: "message.retry",
              description: "resend this failed message with its original attachments",
              onSelect: async (dialog: { clear(): void }) => {
                const value = message()
                if (!value || value.type !== "user") return
                try {
                  const response = await fetch(`${app.nekoEndpoint}/api/session/${encodeURIComponent(props.sessionID)}/prompt`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ id: props.messageID, text: value.text, delivery: "queue" }),
                  })
                  if (!response.ok) {
                    const body = await response.json() as { message?: string }
                    throw new Error(body.message ?? `Retry failed (${response.status})`)
                  }
                  dialog.clear()
                } catch (error) {
                  toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
                }
              },
            }]
          : []),
        {
          title: "Jump to",
          value: "message.jump",
          description: "view message in session",
          onSelect: (dialog) => dialog.clear(),
        },
        {
          title: "Copy",
          value: "message.copy",
          description: "message text to clipboard",
          onSelect: async (dialog) => {
            const value = message()
            if (!value) return
            const text =
              value.type === "user"
                ? value.text
                : value.type === "assistant"
                  ? value.content
                      .filter((content) => content.type === "text")
                      .map((content) => content.text)
                      .join("\n")
                  : "text" in value
                    ? value.text
                    : ""
            try {
              await clipboard.write(text)
              dialog.clear()
            } catch (error) {
              toast.error(error)
            }
          },
        },
        {
          title: "Fork",
          value: "session.fork",
          description: "create a new session",
          onSelect: (dialog) => {
            const value = message()
            if (!value || value.type !== "user") return
            dialog.replace(() => <DialogFork sessionID={props.sessionID} messageID={props.messageID} />)
          },
        },
        ...(app.nekoEndpoint && props.setPrompt && message()?.type === "user"
          ? [{
              title: "Edit and resend",
              value: "message.edit",
              description: "remove this turn and later messages, then edit the prompt",
              onSelect: async (dialog: { clear(): void }) => {
                const value = message()
                if (!value || value.type !== "user") return
                try {
                  const response = await fetch(`${app.nekoEndpoint}/api/session/${encodeURIComponent(props.sessionID)}/truncate`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ messageID: props.messageID }),
                  })
                  if (!response.ok) {
                    const body = await response.json() as { message?: string }
                    throw new Error(body.message ?? `Message editing failed (${response.status})`)
                  }
                  props.setPrompt?.({ ...projectedPromptInput(value), pasted: [] })
                  dialog.clear()
                  data.session.message.invalidate(props.sessionID)
                  await data.session.message.sync(props.sessionID)
                } catch (error) {
                  toast.show({ message: errorMessage(error), variant: "error", duration: 5000 })
                }
              },
            }]
          : []),
      ]}
    />
  )
}
