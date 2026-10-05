import { describe, expect, it } from "vitest";
import { stripAudioEventTags } from "./audio-event-tags.js";

describe("stripAudioEventTags", () => {
  it.each([
    "[outro jingle]",
    "[phone ringing]",
    " [music] [applause] ",
    "(laughter)",
    "(music) (static)",
  ])("drops the sound-only transcript %j", (text) => {
    expect(stripAudioEventTags(text)).toBe("");
  });

  it("keeps the words around a sound label", () => {
    expect(stripAudioEventTags("[phone ringing] Coś się zepsuło. Nie słyszę, jak mówisz")).toBe(
      "Coś się zepsuło. Nie słyszę, jak mówisz",
    );
  });

  it("keeps parentheses inside real speech", () => {
    expect(stripAudioEventTags("check the deploy (the staging one) please")).toBe(
      "check the deploy (the staging one) please",
    );
  });
});
