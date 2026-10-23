import { createSignal, onCleanup, onMount, Show } from "solid-js"
import type { KeyEvent, PasteEvent } from "@opentui/core"
import { useRenderer } from "@opentui/solid"
import { useClient } from "../context/client"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useToast } from "../ui/toast"
import { useTheme } from "../context/theme"
import { useClipboard } from "../context/clipboard"

/**
 * Bridge-originated UI requests (B04): extensions running in the pi backend
 * ask a question over SSE (`neko.ui.request`), this component answers over
 * HTTP (`POST /api/neko/ui/:id/respond` or `/cancel`). Requests queue and are
 * served one at a time; closing a dialog cancels its request. Login progress
 * (`neko.auth.event`) is handled here too: this component stays mounted, so
 * events keep arriving even after the panel that started a login closes.
 */

type UiRequest = {
  requestId: string
  kind: "select" | "confirm" | "input"
  title: string
  options?: string[]
  message?: string
  placeholder?: string
  secret?: boolean
}

type UiNotify = {
  message: string
  type?: "info" | "warning" | "error"
}

type AuthEventData =
  | { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string }
  | { type: "progress"; message: string }

// The neko.* event types are bridge extensions outside the generated
// OpenCodeEvent union; subscribe through a narrowed structural view.
type EventSource = {
  on(type: "neko.ui.request", handler: (event: { data: UiRequest }) => void): () => void
  on(type: "neko.ui.notify", handler: (event: { data: UiNotify }) => void): () => void
  on(type: "neko.auth.event", handler: (event: { data: { provider: string; event: AuthEventData } }) => void): () => void
}

export function NekoUiRequests(props: { endpoint?: string }) {
  const client = useClient()
  const dialog = useDialog()
  const toast = useToast()
  const clipboard = useClipboard()
  const endpoint = () => props.endpoint
  const [queue, setQueue] = createSignal<readonly UiRequest[]>([])
  const [active, setActive] = createSignal<UiRequest | undefined>()

  const respond = async (requestId: string, body: Record<string, unknown>) => {
    const base = endpoint()
    if (!base) return
    await fetch(`${base}/api/neko/ui/${encodeURIComponent(requestId)}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => undefined)
  }

  const cancel = async (requestId: string) => {
    const base = endpoint()
    if (!base) return
    await fetch(`${base}/api/neko/ui/${encodeURIComponent(requestId)}/cancel`, {
      method: "POST",
    }).catch(() => undefined)
  }

  const finish = (request: UiRequest) => {
    setActive((current) => (current?.requestId === request.requestId ? undefined : current))
    pump()
  }

  const pump = () => {
    if (active()) return
    const next = queue()[0]
    if (!next) return
    setQueue((items) => items.slice(1))
    show(next)
  }

  const show = (request: UiRequest) => {
    setActive(request)
    const done = () => finish(request)
    if (request.kind === "select") {
      dialog.replace(() => (
        <DialogSelect
          title={request.title}
          options={(request.options ?? []).map((option) => ({ title: option, value: option }))}
          onSelect={(option) => {
            void respond(request.requestId, { value: option.value })
            done()
          }}
          onCancel={() => {
            void cancel(request.requestId)
            done()
          }}
        />
      ))
      return
    }
    if (request.kind === "confirm") {
      dialog.replace(() => (
        <DialogConfirm
          title={request.title}
          message={request.message ?? ""}
          onConfirm={() => {
            void respond(request.requestId, { confirmed: true })
            done()
          }}
          onCancel={() => {
            void cancel(request.requestId)
            done()
          }}
        />
      ))
      return
    }
    if (request.secret) {
      dialog.replace(() => (
        <SecretPrompt
          title={request.title}
          subtitle={request.message}
          placeholder={request.placeholder}
          onConfirm={(value) => {
            void respond(request.requestId, { value })
            done()
          }}
          onCancel={() => {
            void cancel(request.requestId)
            done()
          }}
        />
      ))
      return
    }
    dialog.replace(() => (
      <DialogPrompt
        title={request.title}
        subtitle={request.message}
        placeholder={request.placeholder ?? ""}
        onConfirm={(value) => {
          void respond(request.requestId, { value })
          done()
        }}
        onCancel={() => {
          void cancel(request.requestId)
          done()
        }}
      />
    ))
  }

  const enqueue = (request: UiRequest) => {
    setQueue((items) => [...items, request])
    pump()
  }

  // Copy through the TUI's clipboard service (navigator.clipboard does not
  // exist under bun) and only report success once the write resolved.
  // Returns whether the copy succeeded so callers can keep the dialog —
  // and its copyable content — open on failure.
  const copyToClipboard = async (text: string, successMessage: string): Promise<boolean> => {
    try {
      await clipboard.write(text)
      toast.show({ variant: "success", message: successMessage })
      return true
    } catch (error) {
      toast.show({
        variant: "error",
        message: `复制失败（内容仍在输入框中）：${error instanceof Error ? error.message : String(error)}`,
      })
      return false
    }
  }

  const showAuthEvent = (provider: string, data: AuthEventData) => {
    if (data.type === "auth_url") {
      dialog.replace(() => (
        <DialogPrompt
          title={`${provider} 登录`}
          subtitle={`在浏览器打开并完成授权，然后回到这里继续：\n${data.instructions ?? ""}`}
          value={data.url}
          onConfirm={async () => {
            // Close only after the copy resolved: on failure the dialog —
            // and the link it holds — stays available for a retry.
            if (await copyToClipboard(data.url, "链接已复制，等待授权完成…")) dialog.clear()
          }}
        />
      ))
      return
    }
    if (data.type === "device_code") {
      dialog.replace(() => (
        <DialogPrompt
          title={`${provider} 设备码`}
          subtitle={`访问 ${data.verificationUri} 并输入以下代码：`}
          value={data.userCode}
          onConfirm={async () => {
            if (await copyToClipboard(data.userCode, "设备码已复制，等待授权完成…")) dialog.clear()
          }}
        />
      ))
      return
    }
    toast.show({ variant: "info", message: `${provider}: ${data.message}` })
  }

  onMount(() => {
    const events = client.event as unknown as EventSource
    const offRequest = events.on("neko.ui.request", (event) => enqueue(event.data))
    const offNotify = events.on("neko.ui.notify", (event) => {
      toast.show({
        variant: event.data.type === "error" ? "error" : event.data.type === "warning" ? "warning" : "info",
        message: event.data.message,
      })
    })
    const offAuth = events.on("neko.auth.event", (event) => showAuthEvent(event.data.provider, event.data.event))
    onCleanup(() => {
      offRequest()
      offNotify()
      offAuth()
    })
  })

  return <Show when={false}>{null}</Show>
}


/**
 * A single-line secret input: the typed value never renders — only bullets.
 * Raw keypresses (renderer.keyInput) feed it, so nothing echoes to the
 * screen; the value exists only in memory until confirmed.
 */
export function SecretPrompt(props: {
  title: string
  subtitle?: string
  placeholder?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}) {
  const renderer = useRenderer()
  const theme = useTheme()
  const [value, setValue] = createSignal("")
  let settled = false

  const finish = (confirm: boolean, final: string) => {
    if (settled) return
    settled = true
    if (confirm) props.onConfirm(final)
    else props.onCancel()
  }

  onMount(() => {
    const keyInput = renderer.keyInput
    const onKey = (key: KeyEvent) => {
      if (settled) return
      if (key.name === "escape") {
        key.preventDefault()
        finish(false, "")
        return
      }
      if (key.name === "return" || key.name === "enter") {
        key.preventDefault()
        finish(true, value())
        return
      }
      if (key.name === "backspace") {
        key.preventDefault()
        setValue((current) => current.slice(0, -1))
        return
      }
      if (key.ctrl || key.meta || key.eventType !== "press") return
      const text = key.sequence ?? ""
      if (text.length === 0 || text.length > 4) return
      // Reject control sequences; accept printable characters only.
      if (![...text].every((char) => {
        const code = char.codePointAt(0) ?? 0
        return code >= 0x20 && code !== 0x7f
      }))
        return
      setValue((current) => current + text)
    }
    const onPaste = (event: PasteEvent) => {
      if (settled) return
      event.preventDefault()
      const text = new TextDecoder().decode(event.bytes).replace(/[\r\n]+/g, " ").trim()
      if (text) setValue((current) => current + text)
    }
    keyInput.on("keypress", onKey)
    keyInput.on("paste", onPaste)
    onCleanup(() => {
      keyInput.off("keypress", onKey)
      keyInput.off("paste", onPaste)
      // A dialog closed without confirming counts as cancellation.
      finish(false, "")
    })
  })

  const masked = () => {
    const current = value()
    return `${"\u2022".repeat([...current].length)}\u2588`
  }

  return (
    <DialogLayout header={<DialogHeader title={props.title} />}>
      <box gap={1} paddingBottom={1}>
        <Show when={props.subtitle}>
          <text fg={theme.text.muted} wrapMode="word">
            {`[敏感输入] ${props.subtitle ?? ""}\n输入内容不会显示在屏幕上，只交给请求方。`}
          </text>
        </Show>
        <Show when={value().length === 0 && props.placeholder}>
          <text fg={theme.text.faint}>{props.placeholder}</text>
        </Show>
        <text fg={theme.text.base}>{masked()}</text>
        <text fg={theme.text.faint}>return 确认 · esc 取消 · 粘贴自动脱换行</text>
      </box>
    </DialogLayout>
  )
}
