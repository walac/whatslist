import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { phoneFromJid, saveContacts, loadContacts } from "../src/contacts.js";
import type { ContactsFile } from "../src/types.js";

describe("phoneFromJid", () => {
  it("extracts phone number from WhatsApp JID", () => {
    expect(phoneFromJid("5511999998888@s.whatsapp.net")).toBe("+5511999998888");
  });

  it("handles group JID", () => {
    expect(phoneFromJid("123456789@g.us")).toBe("+123456789");
  });

  it("strips linked-device suffix from JID", () => {
    expect(phoneFromJid("5511999998888:22@s.whatsapp.net")).toBe("+5511999998888");
  });
});

describe("saveContacts / loadContacts", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "whatslist-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true });
  });

  const sampleData: ContactsFile = {
    group: { id: "123@g.us", name: "Test Group" },
    exportedAt: "2026-06-19T15:00:00Z",
    contacts: [
      {
        id: "5511999998888@s.whatsapp.net",
        phone: "+5511999998888",
        name: "Alice",
        isAdmin: true,
      },
      {
        id: "5511777776666@s.whatsapp.net",
        phone: "+5511777776666",
        name: null,
        isAdmin: false,
      },
    ],
  };

  it("saves contacts as formatted JSON", async () => {
    const filePath = join(tmpDir, "contacts.json");
    await saveContacts(filePath, sampleData);

    const raw = await readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.group.name).toBe("Test Group");
    expect(parsed.contacts).toHaveLength(2);
  });

  it("round-trips save then load", async () => {
    const filePath = join(tmpDir, "contacts.json");
    await saveContacts(filePath, sampleData);
    const loaded = await loadContacts(filePath);

    expect(loaded).toEqual(sampleData);
  });

  it("preserves null name values", async () => {
    const filePath = join(tmpDir, "contacts.json");
    await saveContacts(filePath, sampleData);
    const loaded = await loadContacts(filePath);

    expect(loaded.contacts[1].name).toBeNull();
  });
});
