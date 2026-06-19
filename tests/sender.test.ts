import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { sendBatch, resetShutdown, type SendOptions } from "../src/sender.js";
import type { WhatsAppClient } from "../src/whatsapp.js";
import type { ContactsFile } from "../src/types.js";

function mockClient(
  overrides?: Partial<WhatsAppClient>,
): WhatsAppClient {
  return {
    connect: vi.fn(),
    getGroups: vi.fn(),
    getGroupContacts: vi.fn(),
    sendMessage: vi.fn().mockResolvedValue(undefined),
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

describe("sendBatch", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "whatslist-test-"));
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
    expect(client.sendMessage).toHaveBeenCalledWith(
      "111@s.whatsapp.net",
      "Hello!",
    );
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

  it("continues after per-contact failure", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("unreachable"))
      .mockResolvedValueOnce(undefined);
    const client = mockClient({ sendMessage });
    const filePath = await writeContacts();

    const result = await sendBatch(client, opts(filePath));

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
    expect(sendMessage).toHaveBeenCalledTimes(3);
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
    expect(client.sendMessage).toHaveBeenCalledWith(
      "222@s.whatsapp.net",
      "Hello!",
    );
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
});
