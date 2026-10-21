import { createSignal, onMount, Show } from "solid-js"
import { useTuiApp } from "../context/runtime"
import { useTheme } from "../context/theme"
import { DialogPrompt } from "../ui/dialog-prompt"
import { useDialog } from "../ui/dialog"

type Draft = { step: number; name: string; identity: string; voice: string; timeZone: string }
const steps = [
  { field: "name", title: "1/5 · 称呼", description: "给这个全局人设取名。所有会话共用同一身份；已有配置会自动填入。" },
  { field: "identity", title: "2/5 · 身份与关系", description: "写清身份、性格、关系与边界。可粘贴多行完整文本；只保存到 ~/.neko_pi/persona，不改动 AGENTS.md 或 .neko_mem。" },
  { field: "voice", title: "3/5 · 表达习惯", description: "填写称呼、说话方式、动作表达和例句。可留空；避免重复整个身份文本。" },
  { field: "timeZone", title: "4/5 · 时间", description: "填写 IANA 时区，例如 Asia/Shanghai。每轮对话会在隐藏系统上下文中附上当前时间。" },
  { field: "name", title: "5/5 · 确认", description: "回车确认全局配置。常驻记忆预算 800、近期状态 400、召回 1800，按 UTF-8 字节保守计量；状态六小时失效。模型使用 /models 选择，新增连接配置见 ~/.neko_pi/models.json。" },
] as const

export function NekoInit() {
  const app = useTuiApp()
  const dialog = useDialog()
  const theme = useTheme()
  const [draft, setDraft] = createSignal<Draft>()
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal("")
  const endpoint = `${app.nekoEndpoint}/api/neko/init`
  onMount(async () => {
    try {
      const response = await fetch(endpoint)
      if (!response.ok) throw new Error("无法读取配置草稿")
      setDraft(await response.json() as Draft)
    } catch (cause) { setError(String(cause)) }
  })
  const submit = async (value: string) => {
    const current = draft()
    if (!current || busy()) return
    const final = current.step === 4
    const next = { ...current, ...(!final ? { [steps[current.step]!.field]: value } : {}), step: Math.min(4, current.step + 1) }
    setBusy(true)
    setError("")
    try {
      const response = await fetch(endpoint, { method: final ? "POST" : "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) })
      if (!response.ok) {
        const result = await response.json() as { message?: string }
        throw new Error(result.message ?? "保存失败")
      }
      if (final) dialog.clear()
      else setDraft(next)
    } catch (cause) { setError(String(cause)) }
    finally { setBusy(false) }
  }
  return <Show when={draft()} keyed fallback={<text fg={theme.text.muted}>{error() || "读取配置…"}</text>}>
    {(current) => <DialogPrompt
      title={steps[current.step]!.title}
      multiline={current.step === 1 || current.step === 2}
      value={current.step === 4 ? "" : current[steps[current.step]!.field]}
      placeholder={current.step === 4 ? "回车保存；Esc 保留草稿并退出" : "输入后回车继续；Esc 保留草稿"}
      busy={busy()}
      actions={current.step > 0 ? [{ title: "上一步", command: "neko.init.previous", onTrigger: () => {
        const previous = { ...current, step: current.step - 1 }
        void fetch(endpoint, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(previous) }).then(async (response) => {
          if (!response.ok) throw new Error("无法保存草稿")
          setDraft(previous)
        }).catch((cause) => setError(String(cause)))
      } }] : []}
      description={() => <box gap={1}><text wrapMode="word" fg={theme.text.base}>{steps[current.step]!.description}</text><Show when={current.step === 4}><text wrapMode="word" fg={theme.text.base}>称呼：{current.name} · 时区：{current.timeZone}{"\n"}身份：{current.identity.slice(0, 120)}{current.identity.length > 120 ? "…" : ""}</text></Show><Show when={error()}><text wrapMode="word" fg={theme.text.muted}>{error()}</text></Show></box>}
      onConfirm={(value) => void submit(value)}
      onCancel={() => dialog.clear()}
    />}
  </Show>
}
