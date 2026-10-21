// A fixed 5×7 alphabet keeps the wordmark reproducible and terminal-cell aligned.
export const alphabet: Readonly<Record<string, readonly string[]>> = {
  N: ["10001", "11001", "11001", "10101", "10011", "10011", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
}

export function wordmark(text: string, scale = 1): string[] {
  if (!Number.isInteger(scale) || scale < 1) throw new Error("Wordmark scale must be a positive integer")
  const glyphs = [...text.toUpperCase()].map((letter) => {
    const glyph = alphabet[letter]
    if (!glyph) throw new Error(`Unsupported wordmark letter: ${letter}`)
    return glyph
  })
  return Array.from({ length: 7 }, (_, row) =>
    glyphs.map((glyph) => [...glyph[row]].map((pixel) => (pixel === "1" ? "█" : " ").repeat(scale)).join("")).join(" ".repeat(scale)),
  )
}

export const logo = { left: wordmark("NEKO"), right: wordmark("-PI") }
export const go = { left: wordmark("N"), right: wordmark("PI") }
export const banner = wordmark("NEKO-PI", 2)

// Lowercase display lettering: shared x-height, square counters, and a p descender.
const residentGlyphs = [
  ["0000", "0000", "1110", "1001", "1001", "1001", "1001", "0000"],
  ["0000", "0000", "1111", "1001", "1111", "1000", "1111", "0000"],
  ["1000", "1000", "1001", "1010", "1100", "1010", "1001", "0000"],
  ["0000", "0000", "1111", "1001", "1001", "1001", "1111", "0000"],
  ["000", "000", "000", "111", "000", "000", "000", "000"],
  ["0000", "0000", "1111", "1001", "1001", "1111", "1000", "1000"],
  ["010", "000", "110", "010", "010", "010", "111", "000"],
]

export const residentMark = {
  rows: Array.from({ length: 8 }, (_, row) => residentGlyphs.map((glyph) => glyph[row]).join("0")),
  accentColumn: 24,
}
