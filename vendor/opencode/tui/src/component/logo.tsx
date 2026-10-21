import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useTheme } from "../context/theme"
import { useConfig } from "../config"
import { residentMark } from "../logo"
import { tint } from "../theme/color"

export function Logo(props: { width?: number } = {}) {
  const theme = useTheme()
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const [pointer, setPointer] = createSignal<number>()
  const [phase, setPhase] = createSignal(0)
  const available = () => props.width ?? dimensions().width
  const compact = () => available() < 46 || dimensions().height < 20
  const lines = createMemo(() => {
    const shade = (row: number, column: number) => residentMark.rows[row]?.[column] === "1" ? 2
      : residentMark.rows[row - 1]?.[column] === "1" ? 1 : 0
    return Array.from({ length: 4 }, (_, row) => [...residentMark.rows[0]].map((_, column) => ({
      top: shade(row * 2, column), bottom: shade(row * 2 + 1, column),
    })))
  })
  const width = () => compact() ? 7 : lines()[0].length
  const enabled = () => config.animations !== false

  createEffect(() => {
    if (pointer() === undefined || !enabled()) return
    const timer = setInterval(() => setPhase((value) => value + 1), 70)
    onCleanup(() => clearInterval(timer))
  })
  const color = (column: number) => {
    const x = pointer()
    const ink = column >= residentMark.accentColumn ? theme.text.base : theme.text.muted
    if (x === undefined) return ink
    if (!enabled()) return theme.text.action.primary.selected
    const distance = Math.abs(column - x + Math.sin(phase() / 4) * 2)
    return distance < 4 ? theme.text.action.primary.selected : ink
  }
  const pixelColor = (shade: number, column: number) => shade === 2 ? color(column)
    : shade === 1 ? tint(theme.background.base, color(column), 0.25) : theme.background.base

  return (
    <box
      id="neko.wordmark"
      width={width()}
      onMouseOver={(event) => setPointer(event.x - (event.currentTarget?.x ?? 0))}
      onMouseMove={(event) => setPointer(event.x - (event.currentTarget?.x ?? 0))}
      onMouseOut={() => { setPointer(undefined); setPhase(0) }}
    >
      <Show when={!compact()} fallback={<text fg={color(0)} selectable={false}>neko-pi</text>}>
        <For each={lines()}>{(line) => (
          <box flexDirection="row">
            <For each={line}>{(cell, column) => (
              <text fg={pixelColor(cell.top, column())} bg={pixelColor(cell.bottom, column())} selectable={false}>▀</text>
            )}</For>
          </box>
        )}</For>
      </Show>
    </box>
  )
}
