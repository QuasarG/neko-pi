import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import { useRenderer } from "@opentui/solid"
import { openPath } from "@opencode/util/open"
import { useTuiApp } from "../context/runtime"
import { usePromptRef } from "../context/prompt"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { FilePath } from "../ui/file-path"
import { useToast } from "../ui/toast"

type PersonaFile = {
  path: string
  name: string
  kind: "identity" | "voice" | "manifest" | "memory" | "continuity"
  available: boolean
  directory: boolean
  modifiedAt?: number
}
const labels = { identity: "身份", voice: "语气", manifest: "身份配置", memory: "运行记忆", continuity: "近期状态" }

function usePersonaFiles() {
  const app = useTuiApp()
  const [files, setFiles] = createSignal<PersonaFile[]>([])
  const [error, setError] = createSignal("")
  const [loading, setLoading] = createSignal(true)
  createEffect(() => {
    const endpoint = app.nekoEndpoint
    if (!endpoint) { setLoading(false); return }
    let active = true
    let pending = false
    setFiles([])
    setLoading(true)
    const refresh = async () => {
      if (pending) return
      pending = true
      try {
        const response = await fetch(`${endpoint}/api/neko/files`)
        if (!response.ok) throw new Error("无法刷新文件清单")
        const value = await response.json() as { files: PersonaFile[] }
        if (!Array.isArray(value.files)) throw new Error("文件清单格式无效")
        if (active) { setFiles(value.files); setError("") }
      } catch { if (active) setError("刷新失败，稍后自动重试") }
      finally { pending = false; if (active) setLoading(false) }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 2000)
    onCleanup(() => { active = false; clearInterval(timer) })
  })
  return { files, error, loading }
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
  const prompt = usePromptRef()
  const theme = useTheme()
  const dialog = useDialog()
  const state = usePersonaFiles()
  const open = useOpenPersonaFile()
  const [hovered, setHovered] = createSignal("")
  return <Show when={app.nekoEndpoint}>
    <box id="neko.persona-files" gap={1} width="100%" flexShrink={0} marginTop={1}>
      <text fg={theme.text.base}>人设关联文件 · {state.files().length}</text>
      <Show when={state.files().length} fallback={<text fg={theme.text.muted} wrapMode="word">{state.loading() ? "读取清单…" : state.error() || "尚未绑定文件 · /init"}</text>}>
        <scrollbox height={Math.min(state.files().length * 2, props.maxRows)} width="100%">
          <For each={state.files()}>{(file, index) => <box
            id={`neko.persona-file.${index()}`}
            height={2}
            onMouseOver={() => setHovered(file.path)}
            onMouseOut={() => setHovered("")}
            onMouseUp={(event) => { event.stopPropagation(); void open(file); prompt.current?.focus() }}
          >
            <text fg={!file.available ? theme.text.muted : hovered() === file.path ? theme.text.action.primary.selected : theme.text.base} wrapMode="none" truncate>
              {labels[file.kind]} · {file.name}{file.available ? "" : "（缺失）"}
            </text>
            <FilePath value={file.path} maxWidth={32} fg={theme.text.muted} />
          </box>}</For>
        </scrollbox>
      </Show>
      <text fg={theme.text.muted} onMouseUp={() => dialog.replace(() => <PersonaFilesDialog />)}>{state.error() || "/persona-files · 查看全部并打开"}</text>
    </box>
  </Show>
}
