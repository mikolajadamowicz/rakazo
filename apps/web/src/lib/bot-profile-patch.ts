import { BOT_DESCRIPTION_MAX_LENGTH, BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";

export type BotProfileText = { description: string; instructions: string };

/**
 * Bot settings send the description and instructions only when that field
 * itself changed: saving another setting must not rewrite either, and a
 * stored value above its limit must not fail every save. An edit is clamped to
 * the field's own limit.
 *
 * The panel trims fields before saving, so stored values are compared trimmed
 * as well: stray whitespace around stored text is not an edit.
 *
 * `stored` is the text last saved from this panel, not a bot prop that may
 * still be stale when a roster refresh skips replacing the list.
 */
export function botProfilePatch(
  stored: BotProfileText,
  next: BotProfileText,
): Partial<BotProfileText> {
  return {
    ...(next.description !== stored.description.trim()
      ? { description: next.description.slice(0, BOT_DESCRIPTION_MAX_LENGTH) }
      : {}),
    ...(next.instructions !== stored.instructions.trim()
      ? { instructions: next.instructions.slice(0, BOT_INSTRUCTIONS_MAX_LENGTH) }
      : {}),
  };
}
