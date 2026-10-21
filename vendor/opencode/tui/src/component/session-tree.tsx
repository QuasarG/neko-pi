import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useTuiApp } from "../context/runtime"
import { useRoute } from "../context/route"
import { useSessionTabs } from "../context/session-tabs"
import { useData } from "../context/data"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { DialogSessionList } from "./dialog-session-list"

type SessionEntry = { id: string; title: string; directory: string; updated: number; running: boolean; outcome?: string }

export function SessionTreePanel(props: { maxRows: number }) {
  const app = useTuiApp()
  const theme = useTheme()
  const route = useRoute()
  const tabs = useSessionTabs()
  const data = useData()
  const dialog = useDialog()
  const toast = useToast()
  const [sessions, setSessions] = createSignal<SessionEntry[]>([])
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  const [hovered, setHovered] = createSignal("")
  const [collapsed, setCollapsed] = createSignal(new Set<string>())
  const [opening, setOpening] = createSignal("")
  const groups = createMemo(() => {
    const result = new Map<string, SessionEntry[]>()
    for (const session of sessions()) result.set(session.directory, [...(result.get(session.directory) ?? []), session])
    return [...result]
  })
  onMount(() => {
    if (!app.nekoEndpoint) return
    let active = true
    let pending = false
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const response = await fetch(`${app.nekoEndpoint}/api/neko/sessions`)
        if (!response.ok) throw new Error("会话列表暂不可用")
        const value = await response.json() as { sessions: SessionEntry[] }
        if (!Array.isArray(value.sessions)) throw new Error("会话列表格式无效")
        if (active) { setSessions(value.sessions); setError("") }
      } catch { if (active) setError("刷新失败，稍后重试") }
      finally { pending = false; if (active) setLoading(false) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    onCleanup(() => { active = false; clearInterval(timer) })
  })
  const open = async (id: string) => {
    if (opening()) return
    setOpening(id)
    try {
      await data.session.sync(id)
      tabs.open(id)
      route.navigate({ type: "session", sessionID: id })
    } catch { toast.show({ variant: "error", message: "无法加载会话，请稍后重试。" }) }
    finally { setOpening("") }
  }
  const active = (id: string) => route.data.type === "session" && route.data.sessionID === id
  const row = (session: SessionEntry, recent: boolean) => <box
    id={`neko.session.${recent ? "recent" : "tree"}.${session.id}`}
    height={1}
    onMouseOver={() => setHovered(`${recent}:${session.id}`)}
    onMouseOut={() => setHovered("")}
    onMouseUp={(event) => { event.stopPropagation(); void open(session.id) }}
    backgroundColor={active(session.id) ? theme.background.action.primary.hovered : undefined}
  ><text wrapMode="none" truncate fg={active(session.id) || hovered() === `${recent}:${session.id}` ? theme.text.action.primary.selected : theme.text.base}>
    {recent ? "" : "  "}{session.running ? "* " : session.outcome === "failed" ? "! " : active(session.id) ? "> " : "  "}{session.title}
  </text></box>
  return <Show when={app.nekoEndpoint}>
    <box id="neko.session-tree" width="100%" borderStyle="rounded" borderColor={theme.border.base} paddingLeft={1} paddingRight={1} flexShrink={0}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base}>会话</text>
        <text id="neko.session-new" fg={theme.text.muted} onMouseUp={() => tabs.enabled() ? tabs.add() : route.navigate({ type: "home" })}>+ 新建</text>
      </box>
      <Show when={sessions().length} fallback={<text fg={theme.text.muted}>{loading() ? "读取会话…" : error() || "从新对话开始"}</text>}>
        <scrollbox height={Math.min(props.maxRows, sessions().length + groups().length + Math.min(5, sessions().length) + 2)} width="100%">
          <For each={groups()}>{([directory, entries]) => <box>
            <text wrapMode="none" truncate fg={theme.text.muted} onMouseUp={() => setCollapsed((previous) => {
              const next = new Set(previous); next.has(directory) ? next.delete(directory) : next.add(directory); return next
            })}>{collapsed().has(directory) ? ">" : "v"} {directory.split(/[\\/]/).filter(Boolean).at(-1) || directory}</text>
            <Show when={!collapsed().has(directory)}><For each={entries}>{(session) => row(session, false)}</For></Show>
          </box>}</For>
          <box height={1} />
          <text fg={theme.text.muted}>最近</text>
          <For each={sessions().slice(0, 5)}>{(session) => row(session, true)}</For>
        </scrollbox>
      </Show>
      <text fg={theme.text.muted} onMouseUp={() => dialog.replace(() => <DialogSessionList />)}>{opening() ? "正在加载…" : error() || "/sessions · 查看全部"}</text>
    </box>
  </Show>
}
