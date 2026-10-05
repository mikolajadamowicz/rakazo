// Speech-to-text models label sounds they hear, like "[phone ringing]" or "(laughter)".
// Those labels are not words the caller said, so a call must never send them as a turn.
const BRACKETED = /\[[^\]]*\]/g;
const PARENTHESIZED_ONLY = /^(?:\s*\([^)]*\)\s*)+$/;

/** Drops sound labels from a transcript; a transcript made only of labels becomes empty. */
export function stripAudioEventTags(text: string): string {
  const spoken = text.replace(BRACKETED, " ");
  if (PARENTHESIZED_ONLY.test(spoken)) return "";
  return spoken.replace(/\s+/g, " ").trim();
}
