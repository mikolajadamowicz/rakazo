import { ACTIVE_RUN_STATUSES, BACKGROUND_RUN_TRIGGERS, plainTextFromMarkdown } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import type { MessageModel } from "./generated/prisma/models/Message.js";

export const activeRunStatuses = [...ACTIVE_RUN_STATUSES];
const backgroundRunTriggers = [...BACKGROUND_RUN_TRIGGERS];
const userVisibleBotRunTriggers = ["bot_message", ...BACKGROUND_RUN_TRIGGERS];
const latestBotRunOrderBy = [{ createdAt: "desc" as const }, { id: "desc" as const }];

/**
 * The newest conversational/foreground run for a bot's sidebar status. Background
 * ticket runs keep working silently, so they must not make the avatar spin.
 */
export const activeRunSelection = {
  where: {
    status: { in: activeRunStatuses },
    trigger: { notIn: backgroundRunTriggers },
  },
  orderBy: { createdAt: "desc" as const },
  take: 1,
  select: { status: true },
} as const;

/** Latest user-visible run for a bot roster error signal; later success clears an older failure. */
export const latestBotRunSelection = {
  where: { trigger: { notIn: userVisibleBotRunTriggers } },
  orderBy: latestBotRunOrderBy,
  take: 1,
  select: { id: true, status: true },
} as const;

/**
 * The newest `take` messages of each thread, newest first, in one query. A nested include
 * with `take` loads every message of every listed thread and trims them in memory.
 */
export async function latestThreadMessages(
  prisma: PrismaClient,
  threadIds: readonly string[],
  take: number,
): Promise<Map<string, MessageModel[]>> {
  const byThread = new Map<string, MessageModel[]>();
  if (threadIds.length === 0) return byThread;
  const rows = await prisma.$queryRaw<MessageModel[]>`
    SELECT m.* FROM unnest(${[...threadIds]}::text[]) AS t(id)
    CROSS JOIN LATERAL (
      SELECT * FROM messages WHERE "threadId" = t.id ORDER BY seq DESC LIMIT ${take}
    ) AS m`;
  for (const row of rows) {
    const messages = byThread.get(row.threadId) ?? [];
    messages.push(row);
    byThread.set(row.threadId, messages);
  }
  for (const messages of byThread.values()) messages.sort((a, b) => b.seq - a.seq);
  return byThread;
}

/** `latestBotRunSelection` for many threads in one bounded query. */
export async function latestBotRuns(
  prisma: PrismaClient,
  threadIds: readonly string[],
): Promise<Map<string, { id: string; status: string }>> {
  if (threadIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<Array<{ threadId: string; id: string; status: string }>>`
    SELECT r."threadId", r.id, r.status FROM unnest(${[...threadIds]}::text[]) AS t(id)
    CROSS JOIN LATERAL (
      SELECT "threadId", id, status FROM runs
      WHERE "threadId" = t.id AND NOT (trigger = ANY(${userVisibleBotRunTriggers}::text[]))
      ORDER BY "createdAt" DESC, id DESC
      LIMIT 1
    ) AS r`;
  return new Map(rows.map((row) => [row.threadId, { id: row.id, status: row.status }]));
}

export function previewFromBlocks(blocks: unknown): string {
  const rows = Array.isArray(blocks) ? blocks : [];
  for (const block of rows) {
    if (
      block &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return plainTextFromMarkdown((block as { text: string }).text);
    }
  }
  return "";
}
