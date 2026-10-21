import { mkdirSync } from "node:fs"
import path from "node:path"
import { Schema } from "effect"
import { Flock } from "@opencode/util/flock"
import { Info, type Interface } from "./config"
import { readJson, writeJsonAtomic } from "./util/persistence"
import { isMissingPath } from "./util/config-directories"

export function createPiConfig(file: string): Interface {
  mkdirSync(path.dirname(file), { recursive: true })
  const validate = Schema.decodeUnknownSync(Info)
  const get = async (): Promise<Info> => {
    const value = await readJson<unknown>(file).catch((error: unknown) => {
      if (isMissingPath(error)) return {}
      throw error
    })
    validate(value)
    // Keep unknown fields, including $schema, when saving a known setting.
    return value as Info
  }
  return {
    path: file,
    get,
    update: (mutation) => Flock.withLock(file, async () => {
      const draft = await get()
      mutation(draft)
      validate(draft)
      await writeJsonAtomic(file, draft)
      return draft
    }, { dir: path.join(path.dirname(file), ".locks") }),
  }
}
