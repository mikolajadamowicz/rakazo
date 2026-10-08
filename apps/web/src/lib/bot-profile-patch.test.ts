import { BOT_DESCRIPTION_MAX_LENGTH, BOT_INSTRUCTIONS_MAX_LENGTH } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { botProfilePatch } from "./bot-profile-patch.js";

const profile = (description: string, instructions = description) => ({
  description,
  instructions,
});

describe("bot profile patch", () => {
  it("sends nothing when neither field was touched", () => {
    const stored = profile("I".repeat(BOT_DESCRIPTION_MAX_LENGTH + 1500));
    expect(botProfilePatch(stored, stored)).toEqual({});
  });

  it("treats whitespace around stored text as untouched", () => {
    expect(
      botProfilePatch(
        profile(" Billing questions ", "Answer\n"),
        profile("Billing questions", "Answer"),
      ),
    ).toEqual({});
  });

  it("sends only the field that was edited", () => {
    expect(botProfilePatch(profile("Billing", "Long"), profile("Invoices", "Long"))).toEqual({
      description: "Invoices",
    });
    expect(botProfilePatch(profile("Billing", "Long"), profile("Billing", "Longer"))).toEqual({
      instructions: "Longer",
    });
  });

  it("clamps an edited value to each field's own limit", () => {
    const long = "D".repeat(BOT_INSTRUCTIONS_MAX_LENGTH + 100);
    const patch = botProfilePatch(profile("short"), profile(long));
    expect(patch.description).toHaveLength(BOT_DESCRIPTION_MAX_LENGTH);
    expect(patch.instructions).toHaveLength(BOT_INSTRUCTIONS_MAX_LENGTH);
  });

  it("still sends cleared fields", () => {
    expect(botProfilePatch(profile("Invoices"), profile(""))).toEqual({
      description: "",
      instructions: "",
    });
  });
});
