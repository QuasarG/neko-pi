import { createSignal, Show, onMount, onCleanup } from "solid-js"
import { NekoInit } from "./dialog-init"
import { useTuiApp } from "../context/runtime"
import { useTheme } from "../context/theme"
import { Keymap } from "../context/keymap"
import { DialogHeader, DialogLayout, useDialog } from "../ui/dialog"
import { useTerminalDimensions } from "@opentui/solid"
import { useToast } from "../ui/toast"
import { PersonaFilesDialog, PersonaFilesPanel } from "./persona-files"
import { SessionTreePanel } from "./session-tree"

export function NekoModelSetup() {
  const theme = useTheme()
  return (
    <DialogLayout header={<DialogHeader title="模型连接" />}>
      <box gap={1} paddingBottom={1}>
        <text fg={theme.text.base} wrapMode="word">模型连接由 pi 后端管理，使用 /models 选择已经配置的模型。</text>
        <text fg={theme.text.muted} wrapMode="word">新增模型请修改 ~/.neko_pi/models.json，并配置对应凭据，随后重启 neko-pi。</text>
      </box>
    </DialogLayout>
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
          界面偏好：/settings。统一目录：~/.neko_pi。身份与记忆由所有会话共享。
        </text>
      </box>
    </DialogLayout>
  )
}

export function NekoCommands() {
  const dialog = useDialog()
  const app = useTuiApp()
  const toast = useToast()
  onMount(() => {
    if (app.nekoEndpoint && !app.persona?.identityReady) toast.show({ variant: "info", message: "尚未配置全局身份，输入 /init 开始配置。", duration: 10000 })
  })
  Keymap.createLayer(() => ({ mode: "global", commands: [{
    id: "neko.status", title: "Neko 的身份与记忆状态", group: "Neko", slash: { name: "neko" },
    palette: true, run: () => dialog.replace(() => <NekoDetails />),
  }, {
    id: "neko.init", title: "初始化全局身份与记忆", group: "Neko", slash: { name: "init" },
    palette: true, run: () => dialog.replace(() => <NekoInit />),
  }, {
    id: "neko.files", title: "查看并打开人设关联文件", group: "Neko", slash: { name: "persona-files" },
    palette: true, run: () => dialog.replace(() => <PersonaFilesDialog />),
  }] }))
  return null
}

export function NekoPresence(props: { compact?: boolean }) {
  const dimensions = useTerminalDimensions()
  return (
    <Show when={dimensions().height >= 18}>
    <box width="100%" gap={1}>
    <SessionTreePanel maxRows={dimensions().height >= 40 ? 12 : 6} />
    <box id="neko.presence"><box id="neko.portrait-space" width={28} height={dimensions().height >= 40 ? 2 : 0} /></box>
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
