import { RGBA, TextAttributes } from "@opentui/core"
import { For, type JSX } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { tint } from "../theme/color"
import { banner, go, logo } from "../logo"

export function Logo() {
  const theme = useTheme()
  const dimensions = useTerminalDimensions()

  const renderLine = (line: string, fg: RGBA, bold: boolean): JSX.Element[] => {
    const shadow = tint(theme.background.base, fg, 0.25)
    const attrs = bold ? TextAttributes.BOLD : undefined
    return Array.from(line).map((char) => {
      if (char === "_") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            {" "}
          </text>
        )
      }
      if (char === "^") {
        return (
          <text fg={fg} bg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === "~") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▀
          </text>
        )
      }
      if (char === ",") {
        return (
          <text fg={shadow} attributes={attrs} selectable={false}>
            ▄
          </text>
        )
      }
      return (
        <text fg={fg} attributes={attrs} selectable={false}>
          {char}
        </text>
      )
    })
  }

  // Wide banner (pasted by the boss from an ASCII art generator): outline strokes in
  // the foreground color, ▓▒░ fills mapped to three theme brightness steps.
  const renderBannerLine = (line: string): JSX.Element[] => {
    const dim = tint(theme.background.base, theme.text.muted, 0.55)
    return Array.from(line).map((char, index) => {
      if (char === "▓") {
        return (
          <text key={index} fg={theme.text.base} selectable={false}>
            ▓
          </text>
        )
      }
      if (char === "▒") {
        return (
          <text key={index} fg={theme.text.muted} selectable={false}>
            ▒
          </text>
        )
      }
      if (char === "░") {
        return (
          <text key={index} fg={dim} selectable={false}>
            ░
          </text>
        )
      }
      return renderLine(char, theme.text.base, false)[0]
    })
  }

  return (
    <box>
      {dimensions().height < 12 ? null : dimensions().width >= 66 ? (
        <For each={banner}>
          {(line) => (
            <box flexDirection="row">
              {renderBannerLine(line)}
            </box>
          )}
        </For>
      ) : dimensions().width < 22 ? (
        <For each={go.right.slice(1)}>
          {(line) => <box flexDirection="row">{renderLine(line, theme.text.base, true)}</box>}
        </For>
      ) : dimensions().width < 44 ? (
        <>
          <For each={logo.left.slice(1)}>
            {(line) => <box flexDirection="row">{renderLine(line, theme.text.muted, false)}</box>}
          </For>
          <For each={logo.right}>
            {(line) => <box flexDirection="row">{renderLine(line, theme.text.base, true)}</box>}
          </For>
        </>
      ) : (
        <For each={logo.left}>
          {(line, index) => (
            <box flexDirection="row" gap={1}>
              <box flexDirection="row">{renderLine(line, theme.text.muted, false)}</box>
              <box flexDirection="row">{renderLine(logo.right[index()], theme.text.base, true)}</box>
            </box>
          )}
        </For>
      )}
    </box>
  )
}
