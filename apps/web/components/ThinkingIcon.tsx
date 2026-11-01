import { BrainIcon } from "./tool-icons";

/** The reasoning row's icon (§3 verbatim): a static BrainIcon — ZCode's
 * reasoning deliberately avoids a rotating loader; the running state is the
 * label's text sweep, never the icon. */
export function ThinkingIcon() {
  return <BrainIcon size={16} className="thinking-icon" />;
}
