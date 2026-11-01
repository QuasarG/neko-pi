// Per-tool lucide icons, geometry verbatim from lucide-static@0.544.0 (ISC),
// the same set ZCode's tool rows render (spec catalog §2.7). Every icon keeps
// the lucide frame: viewBox 24, fill none, stroke currentColor, width 2,
// round caps and joins — callers size the svg, the paths never change.

interface ToolIconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

/** The shape every icon in this file renders as. */
export type IconComponent = (props: ToolIconProps) => React.ReactElement;

function iconPaths(children: React.ReactNode) {
  return function ToolIcon({ size = 16, strokeWidth = 2, className }: ToolIconProps) {
    return (
      <svg
        className={className}
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
      >
        {children}
      </svg>
    );
  };
}

export const SearchIcon = iconPaths(<><path d="m21 21-4.34-4.34" /><circle cx="11" cy="11" r="8" /></>);

export const PencilIcon = iconPaths(<><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" /><path d="m15 5 4 4" /></>);

export const SquareTerminalIcon = iconPaths(<><path d="m7 11 2-2-2-2" /><path d="M11 13h4" /><rect width="18" height="18" x="3" y="3" rx="2" /></>);

export const BotIcon = iconPaths(<><path d="M12 8V4H8" /><rect width="16" height="12" x="4" y="8" rx="2" /><path d="M2 14h2" /><path d="M20 14h2" /><path d="M15 13v2" /><path d="M9 13v2" /></>);

export const WrenchIcon = iconPaths(<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.106-3.105c.32-.322.863-.22.983.218a6 6 0 0 1-8.259 7.057l-7.91 7.91a1 1 0 0 1-2.999-3l7.91-7.91a6 6 0 0 1 7.057-8.259c.438.12.54.662.219.984z" />);

export const PlugIcon = iconPaths(<><path d="M12 22v-5" /><path d="M9 8V2" /><path d="M15 8V2" /><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z" /></>);

export const GlobeIcon = iconPaths(<><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></>);

export const ListTodoIcon = iconPaths(<><path d="M13 5h8" /><path d="M13 12h8" /><path d="M13 19h8" /><path d="m3 17 2 2 4-4" /><rect x="3" y="4" width="6" height="6" rx="1" /></>);

export const WandSparklesIcon = iconPaths(<><path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" /><path d="m14 7 3 3" /><path d="M5 6v4" /><path d="M19 14v4" /><path d="M10 2v2" /><path d="M7 8H3" /><path d="M21 16h-4" /><path d="M11 3H9" /></>);

export const CircleHelpIcon = iconPaths(<><circle cx="12" cy="12" r="10" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>);

export const GoalIcon = iconPaths(<><path d="M12 13V2l8 4-8 4" /><path d="M20.561 10.222a9 9 0 1 1-12.55-5.29" /><path d="M8.002 9.997a5 5 0 1 0 8.9 2.02" /></>);

export const MousePointerClickIcon = iconPaths(<><path d="M14 4.1 12 6" /><path d="m5.1 8-2.9-.8" /><path d="m6 12-1.9 2" /><path d="M7.2 2.2 8 5.1" /><path d="M9.037 9.69a.498.498 0 0 1 .653-.653l11 4.5a.5.5 0 0 1-.074.949l-4.349 1.041a1 1 0 0 0-.74.739l-1.04 4.35a.5.5 0 0 1-.95.074z" /></>);

export const BrainIcon = iconPaths(<><path d="M12 18V5" /><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" /><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" /><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" /><path d="M18 18a4 4 0 0 0 2-7.464" /><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" /><path d="M6 18a4 4 0 0 1-2-7.464" /><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" /></>);

export const ChevronRightIcon = iconPaths(<path d="m9 18 6-6-6-6" />);

export const ChevronDownIcon = iconPaths(<path d="m6 9 6 6 6-6" />);

export const ChevronLeftIcon = iconPaths(<path d="m15 18-6-6 6-6" />);

export const WorkflowIcon = iconPaths(<><rect width="8" height="8" x="3" y="3" rx="2" /><path d="M7 11v4a2 2 0 0 0 2 2h4" /><rect width="8" height="8" x="13" y="13" rx="2" /></>);

export const ActivityIcon = iconPaths(<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2" />);

export const ArrowRightIcon = iconPaths(<><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>);

export const ArrowDownIcon = iconPaths(<><path d="M12 5v14" /><path d="m19 12-7 7-7-7" /></>);

export const CheckCircle2Icon = iconPaths(<><circle cx="12" cy="12" r="10" /><path d="m9 12 2 2 4-4" /></>);

export const CircleIcon = iconPaths(<circle cx="12" cy="12" r="10" />);

export const ListChecksIcon = iconPaths(<><path d="M13 5h8" /><path d="M13 12h8" /><path d="M13 19h8" /><path d="m3 17 2 2 4-4" /><path d="m3 7 2 2 4-4" /></>);

export const Maximize2Icon = iconPaths(<><path d="M15 3h6v6" /><path d="m21 3-7 7" /><path d="m3 21 7-7" /><path d="M9 21H3v-6" /></>);

export const Minimize2Icon = iconPaths(<><path d="m14 10 7-7" /><path d="M20 10h-6V4" /><path d="m3 21 7-7" /><path d="M4 14h6v6" /></>);

export const EllipsisIcon = iconPaths(<><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></>);

export const LoaderCircleIcon = iconPaths(<path d="M21 12a9 9 0 1 1-6.219-8.56" />);

// Sidebar anatomy (recon-sidebar-theme-trajectory.md §7), geometry verbatim
// from lucide-static@0.544.0 — the ZCode new-task button, project rows and the
// sidebar footer's settings key.

export const MessageCirclePlusIcon = iconPaths(<><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" /><path d="M8 12h8" /><path d="M12 8v8" /></>);

export const FolderIcon = iconPaths(<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />);

export const FolderOpenIcon = iconPaths(<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />);

export const SettingsIcon = iconPaths(<><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915" /><circle cx="12" cy="12" r="3" /></>);

export const SquareIcon = iconPaths(<rect width="18" height="18" x="3" y="3" rx="2" />);

export const PauseIcon = iconPaths(<><rect x="14" y="3" width="5" height="18" rx="1" /><rect x="5" y="3" width="5" height="18" rx="1" /></>);

export const PlayIcon = iconPaths(<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z" />);

export const CircleCheckBigIcon = iconPaths(<><path d="M21.801 10A10 10 0 1 1 17 3.335" /><path d="m9 11 3 3L22 4" /></>);

export const CopyIcon = iconPaths(<><rect width="14" height="14" x="8" y="8" rx="2" ry="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></>);

export const CheckIcon = iconPaths(<path d="M20 6 9 17l-5-5" />);

export const ClockIcon = iconPaths(<><path d="M12 6v6l4 2" /><circle cx="12" cy="12" r="10" /></>);

export const MoonIcon = iconPaths(<path d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401" />);

export const SendIcon = iconPaths(<><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" /><path d="m21.854 2.147-10.94 10.939" /></>);

export const ReplyIcon = iconPaths(<><path d="M20 18v-2a4 4 0 0 0-4-4H4" /><path d="m9 17-5-5 5-5" /></>);

export const ClipboardCheckIcon = iconPaths(<><rect width="8" height="4" x="8" y="2" rx="1" ry="1" /><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><path d="m9 14 2 2 4-4" /></>);

export const CircleStopIcon = iconPaths(<><circle cx="12" cy="12" r="10" /><rect x="9" y="9" width="6" height="6" rx="1" /></>);

export const BookOpenTextIcon = iconPaths(<><path d="M12 7v14" /><path d="M16 12h2" /><path d="M16 8h2" /><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" /><path d="M6 12h2" /><path d="M6 8h2" /></>);

export const FileOutputIcon = iconPaths(<><path d="M14 2v4a2 2 0 0 0 2 2h4" /><path d="M4 7V4a2 2 0 0 1 2-2 2 2 0 0 0-2 2" /><path d="M4.063 20.999a2 2 0 0 0 2 1L18 22a2 2 0 0 0 2-2V7l-5-5H6" /><path d="m5 11-3 3" /><path d="m5 17-3-3h10" /></>);

export const NotepadTextIcon = iconPaths(<><path d="M8 2v4" /><path d="M12 2v4" /><path d="M16 2v4" /><rect width="16" height="18" x="4" y="4" rx="2" /><path d="M8 10h6" /><path d="M8 14h8" /><path d="M8 18h5" /></>);

export const MessageCircleQuestionIcon = iconPaths(<><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" /><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" /><path d="M12 17h.01" /></>);

export const MessageCircleReplyIcon = iconPaths(<><path d="M2.992 16.342a2 2 0 0 1 .094 1.167l-1.065 3.29a1 1 0 0 0 1.236 1.168l3.413-.998a2 2 0 0 1 1.099.092 10 10 0 1 0-4.777-4.719" /><path d="m10 15-3-3 3-3" /><path d="M7 12h8a2 2 0 0 1 2 2v1" /></>);

export const ImageIcon = iconPaths(<><rect width="18" height="18" x="3" y="3" rx="2" ry="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" /></>);

export const AppWindowIcon = iconPaths(<><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M10 4v4" /><path d="M2 8h20" /><path d="M6 4v4" /></>);

export const RotateCcwIcon = iconPaths(<><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" /></>);

export const CpuIcon = iconPaths(<><path d="M12 20v2" /><path d="M12 2v2" /><path d="M17 20v2" /><path d="M17 2v2" /><path d="M2 12h2" /><path d="M2 17h2" /><path d="M2 7h2" /><path d="M20 12h2" /><path d="M20 17h2" /><path d="M20 7h2" /><path d="M7 20v2" /><path d="M7 2v2" /><rect x="4" y="4" width="16" height="16" rx="2" /><rect x="8" y="8" width="8" height="8" rx="1" /></>);

/**
 * A tool name's lucide icon, the §2.7 mapping: read and the searches ride the
 * same SearchIcon, the edit family the PencilIcon, the shell family the
 * SquareTerminalIcon, agents the BotIcon, MCP tools the PlugIcon, codemode the
 * MousePointerClickIcon (ZCode's node_repl glyph). Anything else takes the
 * WrenchIcon fallback, as ZCode's fallback renderer does.
 */
export function toolIconFor(toolName: string): (props: ToolIconProps) => React.JSX.Element {
  const name = toolName.toLowerCase();
  if (name === "codemode" || name === "node_repl") return MousePointerClickIcon;
  if (name === "ask_user") return CircleHelpIcon;
  if (name === "goal_update" || name === "goal") return GoalIcon;
  if (name === "todo_write" || name === "todo") return ListTodoIcon;
  if (/^mcp__/.test(name)) return PlugIcon;
  if (/agent|subagent/.test(name)) return BotIcon;
  if (name === "image") return ImageIcon;
  if (/webfetch|web_fetch|web-fetch|fetch[-_]?url/.test(name)) return GlobeIcon;
  if (/^skill/.test(name)) return WandSparklesIcon;
  if (/bash|exec|terminal|powershell/.test(name)) return SquareTerminalIcon;
  if (/^send[-_]?message/.test(name)) return SendIcon;
  if (/^reply|^respond[-_]?to[-_]?coordinator/.test(name)) return ReplyIcon;
  if (/task[-_]?output/.test(name)) return FileOutputIcon;
  if (/task[-_]?stop/.test(name)) return CircleStopIcon;
  if (/read[-_]?session[-_]?context/.test(name)) return BookOpenTextIcon;
  if (/^cron|^schedule/.test(name)) return ClockIcon;
  if (/^offpeak/.test(name)) return MoonIcon;
  if (/^escalate/.test(name)) return MessageCircleQuestionIcon;
  if (/^resolve[-_]?workflow/.test(name)) return MessageCircleReplyIcon;
  if (/^switch[-_]?mode/.test(name)) return NotepadTextIcon;
  if (/^submit[-_]?result/.test(name)) return ClipboardCheckIcon;
  if (/^list[-_]?models/.test(name)) return CpuIcon;
  if (/^(apply[-_]?)?patch|edit|write|str_replace/.test(name)) return PencilIcon;
  if (/^(read|grep|find|ls|search|glob|explore)/.test(name)) return SearchIcon;
  return WrenchIcon;
}
