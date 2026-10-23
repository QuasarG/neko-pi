import { createSignal, For, Show, onMount, onCleanup } from "solid-js"
import { errorMessage } from "../util/error"
import { NekoInit } from "./dialog-init"
import { useTuiApp } from "../context/runtime"
import { useRoute } from "../context/route"
import { useTheme } from "../context/theme"
import { Keymap } from "../context/keymap"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect } from "../ui/dialog-select"
import { useTerminalDimensions } from "@opentui/solid"
import { useCapabilities } from "../context/capabilities"
import { useToast } from "../ui/toast"
import { PersonaFilesDialog, PersonaFilesPanel } from "./persona-files"
import { SessionTreePanel } from "./session-tree"

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const

type ProviderEntry = { id: string; name: string; connections: unknown[] }

/** Provider credentials management: list, login, and logout through the bridge. */
export function NekoModelSetup() {
  const dialog = useDialog()
  const app = useTuiApp()
  const toast = useToast()
  const theme = useTheme()
  const [providers, setProviders] = createSignal<readonly ProviderEntry[]>([])

  const endpoint = () => app.nekoEndpoint
  const load = async () => {
    if (!endpoint()) return
    try {
      const response = await fetch(`${endpoint()}/api/integration`)
      if (!response.ok) return
      const body = (await response.json()) as { data: readonly ProviderEntry[] }
      setProviders(body.data)
    } catch {
      // Keep the last list while reconnecting.
    }
  }
  onMount(() => void load())

  const act = (provider: ProviderEntry) => {
    const connected = provider.connections.length > 0
    dialog.replace(() => (
      <DialogSelect
        title={`${provider.name}（${connected ? "已连接" : "未连接"}）`}
        options={[
          { title: "登录 · API Key", value: "api_key" as const },
          { title: "登录 · OAuth", value: "oauth" as const },
          { title: "退出登录", value: "logout" as const },
        ]}
        // Esc from the action menu returns to the provider list (which
        // reloads its state on mount) instead of leaving it open forever.
        onCancel={() => dialog.replace(() => <NekoModelSetup />)}
        onSelect={(option) => {
          if (option.value === "logout") {
            void fetch(`${endpoint()}/api/integration/${encodeURIComponent(provider.id)}/logout`, {
              method: "POST",
            })
              .then(async (response) => {
                if (!response.ok) throw new Error(await response.text())
                toast.show({ variant: "success", message: `已退出 ${provider.name}` })
                void load()
              })
              .catch((error) =>
                toast.show({ variant: "error", message: `退出失败: ${errorMessage(error)}` }),
              )
            return
          }
          void fetch(`${endpoint()}/api/neko/auth/${encodeURIComponent(provider.id)}/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ type: option.value }),
          })
            .then(async (response) => {
              if (!response.ok) throw new Error(await response.text())
              toast.show({ variant: "info", message: `${provider.name} 登录已开始…` })
            })
            .catch((error) => toast.show({ variant: "error", message: `登录失败: ${errorMessage(error)}` }))
        }}
      />
    ))
  }

  // The dialog renders its element closure once, so the provider list must
  // stay reactive INSIDE DialogSelect (options()/emptyView), not branch at
  // the component root — a root branch would freeze on the first render.
  return (
    <DialogSelect
      flat
      title="模型连接 · 选择提供商"
      options={providers().map((provider) => ({
        title: `${provider.name}${provider.connections.length > 0 ? " · 已连接" : " · 未连接"}`,
        value: provider,
      }))}
      emptyView={
        <box gap={1} paddingBottom={1}>
          <text fg={theme.text.muted} wrapMode="word">没有已注册的提供商：在 ~/.neko_pi/models.json 配置后重启。</text>
          <text fg={theme.text.faint} wrapMode="word">注意：模型的 id 会原样作为 API 模型代号发送，必须是提供商接受的代号（如 glm-5.3-flash）；自定义后缀会被提供商拒绝。</text>
          <text fg={theme.text.faint} wrapMode="word">注意：模型的 id 会原样作为 API 模型代号发送，必须是提供商接受的代号（如 glm-5.3-flash）；自定义后缀会被提供商拒绝。</text>
          <text fg={theme.text.muted} wrapMode="word">登录输入经桥的 UI 通道弹窗；凭据只进入 pi 的私有存储，不出现在会话里。</text>
        </box>
      }
      onSelect={(option) => act(option.value)}
      onCancel={() => dialog.clear()}
    />
  )
}

export function NekoDetails() {
  const theme = useTheme()
  const persona = livePersona()
  return (
    <DialogLayout header={<DialogHeader title={`${persona()?.name ?? "Neko"} 的状态`} />}>
      <box gap={0} paddingBottom={1}>
        <text fg={theme.text.base}>身份包：{persona()?.identityReady ? "已安装" : "未安装"}</text>
        <text fg={theme.text.base}>语气参考：{persona()?.voiceReady ? "已配置" : "未单独配置"}</text>
        <text fg={theme.text.base}>运行记忆：{persona()?.memoryFiles ?? 0} 条</text>
        <text fg={theme.text.base}>人设初始化：/init</text>
        <text fg={theme.text.muted}>最近读取：{persona()?.memoryReadAt ?? "尚未读取"}</text>
        <text fg={theme.text.muted}>记忆维护：{({ completed: "已完成", failed: "失败，保留原记录", pending: "等待本轮完成", skipped: "已跳过" } as Record<string, string>)[persona()?.memoryMaintenance ?? ""] ?? "尚未运行"}</text>
        <text fg={theme.text.muted} wrapMode="word">
          这里统计统一目录中的运行记录。记录存在不代表本轮已注入；私人内容不会展示。
        </text>
        <text fg={theme.text.muted} wrapMode="word">
          界面偏好：/settings。运行设置：/runtime-settings。统一目录：~/.neko_pi。身份与记忆由所有会话共享。
        </text>
      </box>
    </DialogLayout>
  )
}

type RuntimeSetting = {
  key: string
  label: string
  type: "string" | "boolean" | "enum"
  values?: readonly string[]
  description: string
  appliesTo: "next-session" | "immediately"
}

/** Runtime settings group: read from and written to pi's SettingsManager via the bridge. */
export function NekoRuntimeSettings() {
  const dialog = useDialog()
  const app = useTuiApp()
  const toast = useToast()
  const theme = useTheme()
  const [settings, setSettings] = createSignal<readonly RuntimeSetting[]>([])
  const [values, setValues] = createSignal<Record<string, unknown>>({})
  const [editing, setEditing] = createSignal<string | undefined>()

  const load = async () => {
    if (!app.nekoEndpoint) return
    try {
      const response = await fetch(`${app.nekoEndpoint}/api/neko/settings`)
      if (!response.ok) return
      const data = (await response.json()) as {
        runtime: { settings?: readonly RuntimeSetting[]; values?: Record<string, unknown> }
      }
      setSettings(data.runtime.settings ?? [])
      setValues(data.runtime.values ?? {})
    } catch {
      // Keep the last loaded settings; the dialog stays actionable on retry.
    }
  }

  const save = async (key: string, value: unknown) => {
    setEditing(key)
    try {
      const response = await fetch(`${app.nekoEndpoint}/api/neko/settings/runtime`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      })
      const body = (await response.json().catch(() => undefined)) as { values?: Record<string, unknown>; message?: string } | undefined
      if (!response.ok) {
        toast.show({ variant: "error", message: `保存失败: ${body?.message ?? response.status}` })
        return
      }
      if (body?.values) setValues(body.values)
      toast.show({ variant: "success", message: `已保存 ${key}（回读一致）` })
    } catch (error) {
      toast.show({ variant: "error", message: `保存失败: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setEditing(undefined)
    }
  }

  onMount(() => void load())

  const choose = (setting: RuntimeSetting) => {
    if (setting.type === "boolean") {
      void save(setting.key, !values()[setting.key])
      return
    }
    const options = (setting.type === "enum" ? setting.values ?? [] : setting.key === "defaultThinkingLevel" ? THINKING_LEVELS : []).map(
      (value) => ({
        title: String(value) === String(values()[setting.key]) ? `▶ ${value}` : `  ${value}`,
        value,
        onSelect: () => void save(setting.key, value),
      }),
    )
    if (options.length === 0) {
      dialog.replace(() => (
        <RuntimeValuePrompt
          setting={setting}
          current={values()[setting.key]}
          busy={editing() === setting.key}
          onSubmit={(value) => void save(setting.key, value)}
        />
      ))
      return
    }
    dialog.replace(() => <DialogSelect title={setting.label} options={options} />)
  }

  return (
    <DialogLayout header={<DialogHeader title="运行设置（pi 后端）" closeLabel="esc" />}>
      <box gap={0} paddingBottom={1}>
        <For each={settings()}>
          {(setting) => (
            <box
              flexDirection="row"
              gap={1}
              onMouseUp={() => choose(setting)}
            >
              <text fg={theme.text.base}>{setting.label}</text>
              <text fg={theme.text.muted}>=</text>
              <text fg={editing() === setting.key ? theme.text.faint : theme.text.base}>
                {editing() === setting.key ? "保存中…" : formatValue(values()[setting.key])}
              </text>
            </box>
          )}
        </For>
        <Show when={settings().length === 0}>
          <text fg={theme.text.muted} wrapMode="word">
            未取得运行设置列表：桥端点不可用或未接适配器。界面偏好仍在 /settings。
          </text>
        </Show>
        <text fg={theme.text.faint} wrapMode="word">
          修改经 pi 的 SettingsManager 持久化；标注“下次会话”的项对已运行的会话不生效。
        </text>
      </box>
    </DialogLayout>
  )
}

function formatValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "（未设置）"
  return String(value)
}

function RuntimeValuePrompt(props: {
  setting: RuntimeSetting
  current: unknown
  busy: boolean
  onSubmit: (value: string) => void
}) {
  return (
    <DialogPrompt
      title={props.setting.label}
      subtitle={props.setting.description}
      placeholder={`当前值：${formatValue(props.current)}`}
      busy={props.busy}
      busyText="保存中…"
      onConfirm={(value) => props.onSubmit(value)}
    />
  )
}

type ContextAudit = {
  session: { id: string; title: string; directory: string }
  persona?: { name: string; identityBytes: number; voiceBytes: number; sections: string[] }
  memory: {
    persona: { records: number; version: number; activeBytes: number; catalogBytes: number; continuityBytes: number; titles?: string[] }
    project: { records: number; version: number; activeBytes: number; catalogBytes: number; continuityBytes: number; titles?: string[] }
  }
  activity: { through: number; events: Array<{ seq: number; kind: string; text: string }>; outfit?: unknown }
  receipts: Array<{ kind: string; ref: string; version?: number }>
  messages: Array<{ id: string; text: string; injectedSummary?: string }>
}

/** What the model actually sees this turn: persona, memory, activity, receipts, injections. */
export function NekoContextAudit() {
  const app = useTuiApp()
  const route = useRoute()
  const theme = useTheme()
  const [audit, setAudit] = createSignal<ContextAudit>()
  const [error, setError] = createSignal<string>()

  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)

  const load = async () => {
    const id = sessionID()
    if (!app.nekoEndpoint || !id) return
    try {
      const response = await fetch(`${app.nekoEndpoint}/api/session/${encodeURIComponent(id)}/context`)
      if (!response.ok) {
        setError(`查询失败：${response.status}`)
        return
      }
      setAudit((await response.json()) as ContextAudit)
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  onMount(() => void load())

  const bytes = (n: number) => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)

  return (
    <DialogLayout header={<DialogHeader title="上下文审计（模型看到的一切）" />}>
      <box gap={1} paddingBottom={1}>
        <Show when={error()}>
          <text fg={theme.text.feedback.error.base}>{error()}</text>
        </Show>
        <Show when={!error() && !audit()}>
          <text fg={theme.text.muted}>加载中…（先打开一个会话）</text>
        </Show>
        <Show when={audit()}>
          {(data) => (
            <box gap={0}>
              <text fg={theme.text.base}>人设包：{data().persona ? `${data().persona!.name} · 身份 ${bytes(data().persona!.identityBytes)}${data().persona!.voiceBytes ? ` · 语气 ${bytes(data().persona!.voiceBytes)}` : ""}` : "未安装"}</text>
              <text fg={theme.text.base}>
                记忆 persona：{data().memory.persona.records} 条 · v{data().memory.persona.version} · 目录 {bytes(data().memory.persona.catalogBytes)} · 连续 {bytes(data().memory.persona.continuityBytes)}
              </text>
              <text fg={theme.text.base}>
                记忆 project：{data().memory.project.records} 条 · v{data().memory.project.version} · 目录 {bytes(data().memory.project.catalogBytes)} · 连续 {bytes(data().memory.project.continuityBytes)}
              </text>
              <text fg={theme.text.base}>活动游标：{data().activity.through} · 事件 {data().activity.events.length}{data().activity.outfit ? " · 衣橱已注入" : ""}</text>
              <text fg={theme.text.muted}>送达回据：{data().receipts.length} 项</text>
              <box marginTop={1}>
                <text fg={theme.text.base}>最近消息的注入明细：</text>
              </box>
              <For each={data().messages}>
                {(message) => (
                  <box flexDirection="column" paddingLeft={2}>
                    <text fg={theme.text.muted} wrapMode="none">· {message.text.slice(0, 40) || "(空)"}</text>
                    <Show when={message.injectedSummary}>
                      <text fg={theme.text.feedback.info.base} wrapMode="none">  ↳ 注入：{message.injectedSummary}</text>
                    </Show>
                  </box>
                )}
              </For>
              <text fg={theme.text.faint} wrapMode="word">
                原始注入内容（活动事件、记忆正文、时间戳）经 GET /api/session/:id/context 全量可取；本面板显示摘要与计数。
              </text>
            </box>
          )}
        </Show>
      </box>
    </DialogLayout>
  )
}

/** Thinking level picker for the open session, driven by the real backend endpoint. */
export function NekoThinkingPicker() {
  const dialog = useDialog()
  const app = useTuiApp()
  const toast = useToast()
  const route = useRoute()
  const sessionID = () => (route.data.type === "session" ? route.data.sessionID : undefined)

  const run = async () => {
    if (!app.nekoEndpoint) return
    const id = sessionID()
    if (!id) {
      toast.show({ variant: "info", message: "先打开一个会话，再设置思考强度。" })
      return
    }
    let current: { level?: string; model?: { name?: string; id?: string; reasoning?: boolean } } | undefined
    try {
      const response = await fetch(`${app.nekoEndpoint}/api/session/${encodeURIComponent(id)}/thinking`)
      current = response.ok ? await response.json() : undefined
    } catch {
      current = undefined
    }
    // The executing model decides: refuse BEFORE the user picks a level that
    // would only fail server-side, and say which config flag to flip.
    if (current?.model && !current.model.reasoning) {
      toast.show({
        variant: "info",
        message: `${current.model.name ?? current.model.id} 未启用思考强度（models.json 中该模型 reasoning: false）——打开推理模型或改配置后再调。`,
      })
      return
    }
    dialog.replace(() => (
      <DialogSelect
        title="思考强度"
        options={THINKING_LEVELS.map((level) => ({
          title: level === current?.level ? `▶ ${level}` : `  ${level}`,
          value: level,
        }))}
        onSelect={async (option) => {
          const response = await fetch(`${app.nekoEndpoint}/api/session/${encodeURIComponent(id)}/thinking`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ level: option.value }),
          }).catch(() => undefined)
          if (response?.ok) toast.show({ variant: "success", message: `思考强度已设为 ${option.value}` })
          else toast.show({ variant: "error", message: `设置失败: ${response ? await response.text() : "网络错误"}` })
        }}
      />
    ))
  }

  return { run }
}

export function NekoCommands() {
  const dialog = useDialog()
  const app = useTuiApp()
  const toast = useToast()
  const capabilities = useCapabilities()
  const thinking = NekoThinkingPicker()
  onMount(() => {
    if (app.nekoEndpoint && !app.persona?.identityReady) toast.show({ variant: "info", message: "尚未配置全局身份，输入 /init 开始配置。", duration: 10000 })
  })
  Keymap.createLayer(() => ({ mode: "global", commands: [{
    id: "neko.status", title: "Neko 的身份与记忆状态", group: "Neko", slash: { name: "neko" },
    palette: true, run: () => dialog.replace(() => <NekoDetails />),
  }, {
    id: "neko.thinking", title: "设置思考强度", group: "Neko", slash: { name: "thinking" },
    palette: true,
    run: async () => {
      const entry = capabilities.data()?.global.thinkingLevel
      if (entry && entry.status === "unavailable") {
        toast.show({
          variant: "info",
          message: `思考强度不可用${entry.limitations?.[0] ? `：${entry.limitations[0]}` : ""}`,
        })
        return
      }
      await thinking.run()
    },
  }, {
    id: "neko.init", title: "初始化全局身份与记忆", group: "Neko", slash: { name: "init" },
    palette: true, run: () => dialog.replace(() => <NekoInit />),
  }, {
    id: "neko.files", title: "查看并打开人设关联文件", group: "Neko", slash: { name: "persona-files" },
    palette: true, run: () => dialog.replace(() => <PersonaFilesDialog />),
  }, {
    id: "neko.runtime-settings", title: "运行设置（pi 后端）", group: "Neko", slash: { name: "runtime-settings" },
    palette: true, run: () => dialog.replace(() => <NekoRuntimeSettings />),
  }, {
    id: "neko.context", title: "上下文审计（模型看到的一切）", group: "Neko", slash: { name: "context" },
    palette: true, run: () => dialog.replace(() => <NekoContextAudit />),
  }] }))
  return null
}

export function NekoPresence(props: { compact?: boolean }) {
  const dimensions = useTerminalDimensions()
  return (
    <Show when={dimensions().height >= 18}>
    <box width="100%" gap={1}>
      <SessionTreePanel maxRows={dimensions().height >= 40 ? 12 : 6} />
      <PersonaFilesPanel maxRows={dimensions().height >= 40 ? 6 : 4} />
    </box>
    </Show>
  )
}

function livePersona() {
  const app = useTuiApp()
  const [persona, setPersona] = createSignal(app.persona)
  onMount(() => {
    if (!app.nekoEndpoint) return
    const refresh = async () => {
      try {
        const response = await fetch(`${app.nekoEndpoint}/api/neko/status`)
        if (response.ok) setPersona(await response.json())
      } catch { /* Keep the last successful status while reconnecting. */ }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 3000)
    onCleanup(() => clearInterval(timer))
  })
  return persona
}
