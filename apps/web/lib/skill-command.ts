/**
 * Skills are typed as `#name args` in the composer (their own trigger, apart
 * from `/` commands and `@` files), but pi's expander reads `/skill:name args`.
 * The rewrite happens only for a name the running session registered: an
 * unknown `#foo` stays literal text instead of becoming a `/skill:foo` the
 * model would receive verbatim.
 */
export function skillCommandToSessionText(text: string, knownNames: ReadonlySet<string>): string {
  const match = /^#([^\s]+)(\s+[\s\S]*)?$/.exec(text);
  if (!match || !knownNames.has(match[1])) return text;
  return `/skill:${match[1]}${match[2] ?? ""}`;
}

/** What the transcript and the session list show for an expanded skill. */
export function skillInvocationCommand(name: string, args?: string): string {
  return args ? `#${name} ${args}` : `#${name}`;
}
