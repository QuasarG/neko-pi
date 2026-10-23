import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { openPath } from "@opencode/util/open"
import { useRoute } from "../context/route"
import { useTuiApp } from "../context/runtime"
import { usePromptRef } from "../context/prompt"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

type PersonaFile = {
  path: string
  name: string
  kind: "identity" | "voice" | "manifest" | "memory" | "continuity"
  available: boolean
  directory: boolean
  modifiedAt?: number
  target?: string
  injection?: "full" | "catalog" | "state"
  changeEffect?: string
  pending?: boolean
}
const labels = { identity: "身份", voice: "语气", manifest: "身份配置", memory: "运行记忆", continuity: "近期状态" }
const icons = { identity: "◆", voice: "◇", manifest: "▣", memory: "◈", continuity: "◎" }
const groups: Array<{ kind: PersonaFile["kind"]; label: string }> = [
  { kind: "identity", label: "身份" },
  { kind: "voice", label: "语气" },
  { kind: "manifest", label: "配置" },
  { kind: "memory", label: "记忆" },
  { kind: "continuity", label: "状态" },
]

function usePersonaFiles(sessionId?: () => string | undefined) {
  const app = useTuiApp()
  const [files, setFiles] = createSignal<PersonaFile[]>([])
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  // path -> last seen mtime; a diff between refreshes means the file changed
  // on disk since we (and the model) last saw it. Only used on the home route
  // where no session receipt can anchor the comparison.
  const seen = new Map<string, number | undefined>()
  const [changed, setChanged] = createSignal<Set<string>>(new Set())
  // Session-scoped pending from the bridge: files whose content changed after
  // this session's last memory delivery receipt. Authoritative over the drift
  // view whenever a session is open — it clears by itself once the injection
  // lands, and different sessions show different sets.
  const [scoped, setScoped] = createSignal<Set<string>>(new Set())
  createEffect(() => {
    const endpoint = app.nekoEndpoint
    const session = sessionId?.()
    if (!endpoint) { setLoading(false); return }
    let active = true
    let pending = false
    setFiles([])
    setLoading(true)
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const response = await fetch(`${endpoint}/api/neko/files${session ? `?session=${encodeURIComponent(session)}` : ""}`)
        if (!response.ok) throw new Error("无法刷新文件清单")
        const value = await response.json() as { files: PersonaFile[] }
        if (!Array.isArray(value.files)) throw new Error("文件清单格式无效")
        if (!active) return
        const nextChanged = new Set(changed())
        for (const file of value.files) {
          const previous = seen.get(file.path)
          if (previous !== undefined && file.modifiedAt !== undefined && file.modifiedAt !== previous)
            nextChanged.add(file.path)
          seen.set(file.path, file.modifiedAt)
        }
        for (const path of [...nextChanged])
          if (!value.files.some((file) => file.path === path)) nextChanged.delete(path)
        setChanged(nextChanged)
        setScoped(new Set(value.files.filter((file) => file.pending).map((file) => file.path)))
        setFiles(value.files)
        setError("")
      } catch { if (active) setError("刷新失败，稍后自动重试") }
      finally { pending = false; if (active) setLoading(false) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    onCleanup(() => { active = false; clearInterval(timer) })
  })
  const flagged = () => (sessionId?.() ? scoped() : changed())
  return { files, error, loading, flagged }
}

function useOpenPersonaFile() {
  const toast = useToast()
  const renderer = useRenderer()
  return async (file: PersonaFile) => {
    if (renderer.getSelection()?.getSelectedText()) return
    if (!file.available) return
    try {
      const child = await openPath(file.path)
      child.once("exit", (code) => {
        if (code && code > 0) toast.show({ variant: "error", message: `系统无法打开 ${file.name}，请检查默认软件关联。` })
      })
    } catch { toast.show({ variant: "error", message: `无法打开 ${file.name}，请检查默认软件关联。` }) }
  }
}

export function PersonaFilesDialog() {
  const state = usePersonaFiles()
  const dialog = useDialog()
  const theme = useTheme()
  const open = useOpenPersonaFile()
  return <DialogSelect
    title="人设关联文件"
    placeholder="搜索文件名或路径"
    preserveSelection
    options={state.files().map((file) => ({
      title: `${file.name}${file.available ? "" : "（缺失）"}`,
      value: file.path,
      category: labels[file.kind],
      searchText: file.path,
      details: [file.path],
      onSelect: () => { if (file.available) { dialog.clear(); void open(file) } },
    }))}
    emptyView={<text fg={theme.text.muted}>{state.loading() ? "读取清单…" : state.error() || "尚未绑定文件，使用 /init 配置身份。"}</text>}
    footer={<text fg={theme.text.muted}>{state.error() || "回车用默认软件打开；此处只列 neko-pi 内部运行文件。"}</text>}
  />
}

export function PersonaFilesPanel(props: { maxRows: number }) {
  const app = useTuiApp()
  const route = useRoute()
  const prompt = usePromptRef()
  const theme = useTheme()
  const dialog = useDialog()
  const sessionId = () => (route.data.type === "session" ? route.data.sessionID : undefined)
  const state = usePersonaFiles(sessionId)
  const open = useOpenPersonaFile()
  const [hovered, setHovered] = createSignal("")
  const changed = () => state.flagged()
  const changedCount = () => changed().size

  return <Show when={app.nekoEndpoint}>
    <box
      id="neko.persona-files"
      width="100%"
      borderStyle="rounded"
      borderColor={theme.border.base}
      paddingLeft={1}
      paddingRight={1}
      flexShrink={0}
    >
      <text fg={theme.text.base} wrapMode="none" truncate>人设关联文件 · {state.files().length}</text>
      <Show when={state.files().length} fallback={<text fg={theme.text.muted} wrapMode="word">{state.loading() ? "读取清单…" : state.error() || "尚未绑定文件 · /init"}</text>}>
        <scrollbox height={Math.min(state.files().length * 2 + new Set(state.files().map((file) => file.kind)).size, props.maxRows)} width="100%">
          <For each={groups}>{(group) => {
            const groupFiles = () => state.files().filter((file) => file.kind === group.kind)
            return <Show when={groupFiles().length > 0}>
              <box width="100%">
                <text fg={theme.text.muted} wrapMode="none">{group.label}</text>
                <For each={groupFiles()}>{(file, groupIndex) => {
                  const isChanged = () => changed().has(file.path)
                  return <box
                    id={`neko.persona-file.${group.kind}.${groupIndex()}`}
                    marginLeft={1}
                    onMouseOver={() => setHovered(file.path)}
                    onMouseOut={() => setHovered("")}
                    onMouseUp={(event) => { event.stopPropagation(); if (file.available) void open(file); prompt.current?.focus() }}
                  >
                    <text
                      wrapMode="none" truncate
                      fg={!file.available ? theme.text.muted : isChanged() ? theme.text.feedback.warning.base : hovered() === file.path ? theme.text.action.primary.selected : theme.text.base}
                    >
                      {icons[file.kind]} {file.name}{file.available ? "" : "（缺失）"}{isChanged() ? " ⚠ 已修改" : ""}
                    </text>
                    <Show when={hovered() === file.path}>
                      <text fg={theme.text.muted} wrapMode="none" truncate>
                        {file.target ?? labels[file.kind]} · {file.changeEffect ?? ""}{file.injection === "full" ? " · 全文注入" : file.injection === "catalog" ? " · 目录注入" : file.injection === "state" ? " · 状态注入" : ""}
                      </text>
                    </Show>
                  </box>
                }}</For>
              </box>
            </Show>
          }}</For>
        </scrollbox>
      </Show>
      <Show when={changedCount() > 0}>
        <text fg={theme.text.feedback.warning.base} wrapMode="word">
          ⚠ {changedCount()} 个文件已变更：{[...changed()].map((path) => path.split("/").pop()).join("、")}——变更将在下一条消息注入。
        </text>
      </Show>
      <text fg={theme.text.muted} wrapMode="none" truncate onMouseUp={() => dialog.replace(() => <PersonaFilesDialog />)}>{state.error() || "/persona-files · 打开全部"}</text>
    </box>
  </Show>
}
