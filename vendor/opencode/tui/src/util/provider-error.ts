/** Explain common provider failures without changing their retry policy. */
export function providerErrorMessage(message: string): string {
  if (/\b1301\b/.test(message))
    return "The provider rejected this request under its content policy (1301). Review and edit the message before resending."
  if (/\b401\b|invalid[_ -]?api[_ -]?key|unauthorized/i.test(message))
    return "Provider authentication failed (401). Check your credentials or sign in again, then retry."
  if (/\b429\b|rate[_ -]?limit|too many requests/i.test(message))
    return "The provider rate limit was reached (429). Wait before retrying."
  if (/\b50[0-9]\b|\b5[1-9][0-9]\b/.test(message))
    return "The provider service failed (5xx). Wait and retry, or select another available provider."
  if (/timeout|timed out|fetch failed|network/i.test(message))
    return "The provider connection failed. Check your connection and retry."
  return message
}
