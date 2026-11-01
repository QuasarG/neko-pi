"use client";

import { useI18n } from "@/hooks/useI18n";
import { getFileName } from "@/lib/file-paths";
import type { WrittenFile } from "@/lib/turn-written-files";
import { getFileIcon } from "./FileIcons";

/**
 * Lists the files a turn actually wrote, as buttons that open each one in the
 * preview pane. Entries come from the turn's successful `write`/`edit` tool
 * calls — the reply text is never scanned for paths.
 */
export function TurnWrittenFiles({ files, onOpenFile }: {
  files: WrittenFile[];
  onOpenFile?: (filePath: string) => void;
}) {
  const { t } = useI18n();
  if (files.length === 0) return null;

  return (
    <div className="turn-written-files" aria-label={t("chat.filesWritten")}>
      {files.map(({ filePath }) => {
        const name = getFileName(filePath);
        return (
          <button
            key={filePath}
            type="button"
            className="turn-written-file"
            title={filePath}
            aria-label={t("chat.openWrittenFile", { name })}
            onClick={() => onOpenFile?.(filePath)}
          >
            {getFileIcon(name, 12)}
            <span>{name}</span>
          </button>
        );
      })}
    </div>
  );
}
