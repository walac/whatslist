import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { sendBatch, deleteBatch, uniquifyMessage, resetShutdown, type SendOptions } from "../src/sender.js";
import type { WhatsAppClient } from "../src/whatsapp.js";
import type { ContactsFile, SentMessage } from "../src/types.js";

let msgCounter = 0;

function mockSendMessage(): (contactId: string, text: string) => Promise<SentMessage> {
  return vi.fn((contactId: string) =>
    Promise.resolve({
      contactId,
      messageId: `msg-${++msgCounter}`,
      remoteJid: contactId,
      timestamp: 1700000000 + msgCounter,
    }),
  );
}

function mockClient(
  overrides?: Partial<WhatsAppClient>,
): WhatsAppClient {
  return {
    connect: vi.fn(),
    getGroups: vi.fn(),
    getGroupContacts: vi.fn(),
    sendMessage: mockSendMessage(),
    deleteMessage: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn(),
    ...overrides,
  };
}

const sampleContacts: ContactsFile = {
  group: { id: "g1@g.us", name: "Test" },
  exportedAt: "2026-06-19T00:00:00Z",
  contacts: [
    {
      id: "111@s.whatsapp.net",
      phone: "+111",
      name: "Alice",
      isAdmin: false,
    },
    {
      id: "222@s.whatsapp.net",
      phone: "+222",
      name: "Bob",
      isAdmin: false,
    },
    {
      id: "333@s.whatsapp.net",
      phone: "+333",
      name: null,
      isAdmin: false,
    },
  ],
};

describe("uniquifyMessage", () => {
  it("picks one alternative from each variation slot", () => {
    const result = uniquifyMessage("{Olá|Oi}, {tudo bem|como vai}?");
    expect(result).toMatch(/^(Olá|Oi), (tudo bem|como vai)\?$/);
  });

  it("returns message unchanged when no slots present", () => {
    expect(uniquifyMessage("Hello!")).toBe("Hello!");
  });

  it("produces different variants across calls", () => {
    const template = "{A|B|C} {X|Y|Z}";
    const results = new Set(Array.from({ length: 50 }, () => uniquifyMessage(template)));
    expect(results.size).toBeGreaterThan(1);
  });

  it("handles single-alternative slots as constants", () => {
    expect(uniquifyMessage("{only}")).toBe("only");
  });
});

describe("sendBatch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "whatslist-test-"));
    msgCounter = 0;
  });

  afterEach(async () => {
    resetShutdown();
    await rm(tmpDir, { recursive: true });
  });

  async function writeContacts(): Promise<string> {
    const filePath = join(tmpDir, "contacts.json");
    await writeFile(filePath, JSON.stringify(sampleContacts), "utf-8");
    return filePath;
  }

  function opts(contactsFile: string, extra?: Partial<SendOptions>): SendOptions {
    return {
      contactsFile,
      message: "Hello!",
      dryRun: false,
      minDelayMs: 0,
      maxDelayMs: 0,
      ...extra,
    };
  }

  it("sends a message to every contact", async () => {
    const client = mockClient();
    const filePath = await writeContacts();

    const result = await sendBatch(client, opts(filePath));

    expect(result.sent).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(client.sendMessage).toHaveBeenCalledTimes(3);
    const firstCall = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(firstCall[0]).toBe("111@s.whatsapp.net");
    expect(firstCall[1]).toBe("Hello!");
  });

  it("skips contacts in dry-run mode", async () => {
    const client = mockClient();
    const filePath = await writeContacts();

    const result = await sendBatch(
      client,
      opts(filePath, { dryRun: true }),
    );

    expect(result.skipped).toBe(3);
    expect(result.sent).toBe(0);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("skips contacts when client is null (dry-run)", async () => {
    const filePath = await writeContacts();

    const result = await sendBatch(
      null,
      opts(filePath, { dryRun: true }),
    );

    expect(result.skipped).toBe(3);
    expect(result.sent).toBe(0);
  });

  it("skips already-sent contacts from send log", async () => {
    const client = mockClient();
    const filePath = await writeContacts();
    const logPath = filePath.replace(/\.json$/, ".send-log.json");
    await writeFile(
      logPath,
      JSON.stringify({
        sentIds: ["111@s.whatsapp.net"],
        startedAt: "2026-06-19T00:00:00Z",
      }),
      "utf-8",
    );

    const result = await sendBatch(client, opts(filePath));

    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(2);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("continues after per-contact failure and saves message keys for successes", async () => {
    const sendMessage = mockSendMessage() as ReturnType<typeof vi.fn>;
    sendMessage
      .mockReset()
      .mockResolvedValueOnce({ contactId: "111@s.whatsapp.net", messageId: "m1", remoteJid: "111@s.whatsapp.net", timestamp: 1700000001 })
      .mockRejectedValueOnce(new Error("unreachable"))
      .mockResolvedValueOnce({ contactId: "333@s.whatsapp.net", messageId: "m3", remoteJid: "333@s.whatsapp.net", timestamp: 1700000003 });
    const client = mockClient({ sendMessage });
    const filePath = await writeContacts();

    const result = await sendBatch(client, opts(filePath));

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(3);

    const msgPath = filePath.replace(/\.json$/, ".messages.json");
    const messages = JSON.parse(await readFile(msgPath, "utf-8"));
    expect(messages).toHaveLength(2);
    expect(messages[0].messageId).toBe("m1");
    expect(messages[1].messageId).toBe("m3");
  });

  it("persists send log after each successful send", async () => {
    const client = mockClient();
    const filePath = await writeContacts();

    await sendBatch(client, opts(filePath));

    const logPath = filePath.replace(/\.json$/, ".send-log.json");
    const log = JSON.parse(await readFile(logPath, "utf-8"));
    expect(log.sentIds).toHaveLength(3);
    expect(log.sentIds).toContain("111@s.whatsapp.net");
    expect(log.sentIds).toContain("222@s.whatsapp.net");
    expect(log.sentIds).toContain("333@s.whatsapp.net");
  });

  it("persists message keys to .messages.json after each send", async () => {
    const client = mockClient();
    const filePath = await writeContacts();

    await sendBatch(client, opts(filePath));

    const msgPath = filePath.replace(/\.json$/, ".messages.json");
    const messages = JSON.parse(await readFile(msgPath, "utf-8"));
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      contactId: "111@s.whatsapp.net",
      remoteJid: "111@s.whatsapp.net",
    });
    expect(messages[0].messageId).toBeDefined();
    expect(messages[0].timestamp).toBeGreaterThan(0);
  });

  it("skips contacts listed in filter-out file", async () => {
    const client = mockClient();
    const filePath = await writeContacts();

    const filterFile = join(tmpDir, "exclude.json");
    const excludeData: ContactsFile = {
      group: { id: "g2@g.us", name: "Other Group" },
      exportedAt: "2026-06-19T00:00:00Z",
      contacts: [
        { id: "111@s.whatsapp.net", phone: "+111", name: "Alice", isAdmin: false },
        { id: "333@s.whatsapp.net", phone: "+333", name: null, isAdmin: false },
      ],
    };
    await writeFile(filterFile, JSON.stringify(excludeData), "utf-8");

    const result = await sendBatch(
      client,
      opts(filePath, { filterOutFile: filterFile }),
    );

    expect(result.skipped).toBe(2);
    expect(result.sent).toBe(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const call = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("222@s.whatsapp.net");
    expect(call[1]).toBe("Hello!");
  });

  it("accepts send-log format for filter-out file", async () => {
    const client = mockClient();
    const filePath = await writeContacts();

    const filterFile = join(tmpDir, "previous.send-log.json");
    await writeFile(
      filterFile,
      JSON.stringify({
        sentIds: ["111@s.whatsapp.net", "333@s.whatsapp.net"],
        startedAt: "2026-06-19T00:00:00Z",
      }),
      "utf-8",
    );

    const result = await sendBatch(
      client,
      opts(filePath, { filterOutFile: filterFile }),
    );

    expect(result.skipped).toBe(2);
    expect(result.sent).toBe(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const call = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("222@s.whatsapp.net");
  });

  it("throws on corrupted send log missing sentIds", async () => {
    const client = mockClient();
    const filePath = await writeContacts();
    const logPath = filePath.replace(/\.json$/, ".send-log.json");
    await writeFile(
      logPath,
      JSON.stringify({ startedAt: "2026-06-19T00:00:00Z" }),
      "utf-8",
    );

    await expect(sendBatch(client, opts(filePath))).rejects.toThrow(
      "Invalid send log",
    );
  });

  it("logs 'no connection' instead of 'dry run' when client is null and dryRun is false", async () => {
    const consoleSpy = vi.spyOn(console, "log");
    const filePath = await writeContacts();

    await sendBatch(null, opts(filePath, { dryRun: false }));

    const logMessages = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(logMessages.some((m) => m.includes("no connection"))).toBe(true);
    expect(logMessages.every((m) => !m.includes("dry run"))).toBe(true);
    consoleSpy.mockRestore();
  });

  it("uses phone as display name when name is null", async () => {
    const consoleSpy = vi.spyOn(console, "log");
    const client = mockClient();
    const filePath = await writeContacts();

    await sendBatch(client, opts(filePath));

    const logMessages = consoleSpy.mock.calls.map((c) => c[0] as string);
    expect(logMessages.some((m) => m.includes("+333"))).toBe(true);
    consoleSpy.mockRestore();
  });

  it("maxSends has no effect in dry-run mode", async () => {
    const client = mockClient();
    const filePath = await writeContacts();

    const result = await sendBatch(
      client,
      opts(filePath, { dryRun: true, maxSends: 1 }),
    );

    expect(result.skipped).toBe(3);
    expect(result.sent).toBe(0);
    expect(client.sendMessage).not.toHaveBeenCalled();
  });

  it("stops after maxSends successful sends, not counting skips", async () => {
    const client = mockClient();
    const filePath = await writeContacts();

    const result = await sendBatch(
      client,
      opts(filePath, { maxSends: 2 }),
    );

    expect(result.sent).toBe(2);
    expect(result.skipped).toBe(0);
    expect(result.failed).toBe(0);
    expect(client.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("maxSends does not count filtered-out contacts", async () => {
    const client = mockClient();
    const filePath = await writeContacts();

    const filterFile = join(tmpDir, "exclude.send-log.json");
    await writeFile(
      filterFile,
      JSON.stringify({
        sentIds: ["111@s.whatsapp.net"],
        startedAt: "2026-06-19T00:00:00Z",
      }),
      "utf-8",
    );

    const result = await sendBatch(
      client,
      opts(filePath, { filterOutFile: filterFile, maxSends: 1 }),
    );

    expect(result.skipped).toBe(1);
    expect(result.sent).toBe(1);
    expect(client.sendMessage).toHaveBeenCalledTimes(1);
    const call = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("222@s.whatsapp.net");
  });

  it("expands variation slots in sent messages", async () => {
    const client = mockClient();
    const filePath = await writeContacts();

    await sendBatch(client, opts(filePath, { message: "{Hi|Hey} there" }));

    const calls = (client.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(3);
    for (const [, text] of calls) {
      expect(text).toMatch(/^(Hi|Hey) there$/);
    }
  });
});

describe("deleteBatch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "whatslist-test-"));
  });

  afterEach(async () => {
    resetShutdown();
    await rm(tmpDir, { recursive: true });
  });

  const sampleMessages: SentMessage[] = [
    { contactId: "111@s.whatsapp.net", messageId: "m1", remoteJid: "111@s.whatsapp.net", timestamp: 1700000001 },
    { contactId: "222@s.whatsapp.net", messageId: "m2", remoteJid: "222@s.whatsapp.net", timestamp: 1700000002 },
    { contactId: "333@s.whatsapp.net", messageId: "m3", remoteJid: "333@s.whatsapp.net", timestamp: 1700000003 },
  ];

  async function writeMessages(): Promise<string> {
    const filePath = join(tmpDir, "contacts.messages.json");
    await writeFile(filePath, JSON.stringify(sampleMessages), "utf-8");
    return filePath;
  }

  it("deletes all messages and empties the file", async () => {
    const client = mockClient();
    const filePath = await writeMessages();

    const result = await deleteBatch(client, {
      messagesFile: filePath,
      minDelayMs: 0,
      maxDelayMs: 0,
    });

    expect(result.deleted).toBe(3);
    expect(result.failed).toBe(0);
    expect(client.deleteMessage).toHaveBeenCalledTimes(3);
    expect(client.deleteMessage).toHaveBeenCalledWith(
      "111@s.whatsapp.net", "m1", 1700000001,
    );

    const remaining = JSON.parse(await readFile(filePath, "utf-8"));
    expect(remaining).toHaveLength(0);
  });

  it("continues after per-message failure and keeps failed entries", async () => {
    const deleteMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("server error"))
      .mockResolvedValueOnce(undefined);
    const client = mockClient({ deleteMessage });
    const filePath = await writeMessages();

    const result = await deleteBatch(client, {
      messagesFile: filePath,
      minDelayMs: 0,
      maxDelayMs: 0,
    });

    expect(result.deleted).toBe(2);
    expect(result.failed).toBe(1);

    const remaining = JSON.parse(await readFile(filePath, "utf-8"));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].messageId).toBe("m2");
  });

  it("returns zeros for empty messages file", async () => {
    const filePath = join(tmpDir, "empty.messages.json");
    await writeFile(filePath, "[]", "utf-8");

    const client = mockClient();
    const result = await deleteBatch(client, {
      messagesFile: filePath,
      minDelayMs: 0,
      maxDelayMs: 0,
    });

    expect(result.deleted).toBe(0);
    expect(result.failed).toBe(0);
    expect(client.deleteMessage).not.toHaveBeenCalled();
  });
});
