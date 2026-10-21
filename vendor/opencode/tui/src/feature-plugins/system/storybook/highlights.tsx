import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { onMount } from "solid-js"
import { DialogHighlights } from "../../../component/dialog-highlights"
import type { Story } from "./index"
import { StoryFooter } from "./footer"

// Local examples for exercising release-highlight layouts.
const items = [
  {
    title: "Neko 的状态",
    body: "使用 /neko 查看身份包、语气参考和记忆文件的可用状态。文件存在不代表本轮已经读取。",
  },
  {
    title: "本地立绘",
    body: "宽屏侧栏显示本地身份包中的立绘。私人图片不随项目分发。",
  },
  {
    title: "界面偏好",
    body: "在 /settings 调整鼠标、动画、复制行为和消息显示方式；偏好保存在本地。",
  },
  {
    title: "清晰字标",
    body: "点阵字标由固定字形生成，并随终端宽度切换尺寸。",
  },
  {
    title: "鼠标反馈",
    body: "悬浮字标时显示局部高亮；关闭动画后保留静态反馈。",
  },
]

function HighlightsStory(props: { context: Plugin.Context }) {
  const dimensions = useTerminalDimensions()
  const open = (count: number) =>
    props.context.ui.dialog.show(() => <DialogHighlights version="2.0.27" items={items.slice(0, count)} />)

  props.context.keymap.layer(() => ({
    commands: [
      { bind: "o", title: "Open five highlights", group: "Storybook", run: () => open(5) },
      { bind: "t", title: "Open two highlights", group: "Storybook", run: () => open(2) },
      {
        bind: "escape",
        title: "Back to storybook",
        group: "Storybook",
        run: () => props.context.ui.router.navigate({ type: "plugin", name: "storybook" }),
      },
    ],
  }))
  onMount(() => open(5))

  return (
    <box width={dimensions().width} height={dimensions().height} backgroundColor={props.context.theme.background.base}>
      <box flexGrow={1} />
      <StoryFooter
        context={props.context}
        title="storybook / release highlights"
        controls={[
          { shortcut: "o", label: "five highlights" },
          { shortcut: "t", label: "two highlights" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const highlightsStory: Story = {
  id: "highlights",
  title: "Release highlights",
  render: (context) => <HighlightsStory context={context} />,
}
