import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";
import { createWhatsAppClient } from "../src/whatsapp.js";

vi.mock("../src/auth.js", () => ({
  createSocket: vi.fn(),
}));

vi.mock("../src/retry.js", () => ({
  withRetry: vi.fn((fn: () => Promise<unknown>) => fn()),
}));

import { createSocket } from "../src/auth.js";

function mockSocket(overrides?: Record<string, unknown>) {
  const ev = new EventEmitter();
  const sock = {
    groupFetchAllParticipating: vi.fn().mockResolvedValue({
      "g1@g.us": { id: "g1@g.us", subject: "Group A" },
      "g2@g.us": { id: "g2@g.us", subject: "Group B" },
    }),
    groupMetadata: vi.fn().mockResolvedValue({
      participants: [
        { id: "111@s.whatsapp.net", admin: "admin", notify: "Alice" },
        { id: "222@s.whatsapp.net", admin: null },
      ],
    }),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    end: vi.fn(),
    ev,
    ...overrides,
  };
  // Simulate sync completion shortly after creation
  setTimeout(() => ev.emit("creds.update", { accountSyncCounter: 1 }), 10);
  return sock;
}

describe("createWhatsAppClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects via createSocket and allows getGroups", async () => {
    const sock = mockSocket();
    vi.mocked(createSocket).mockResolvedValue(sock as any);

    const client = createWhatsAppClient("/fake/auth");
    await client.connect();

    const groups = await client.getGroups();
    expect(groups).toEqual([
      { id: "g1@g.us", subject: "Group A" },
      { id: "g2@g.us", subject: "Group B" },
    ]);
  });

  it("extracts contacts with notify name and admin status", async () => {
    const sock = mockSocket();
    vi.mocked(createSocket).mockResolvedValue(sock as any);

    const client = createWhatsAppClient("/fake/auth");
    await client.connect();

    const contacts = await client.getGroupContacts("g1@g.us");
    expect(contacts[0]).toEqual({
      id: "111@s.whatsapp.net",
      phone: "+111",
      name: "Alice",
      isAdmin: true,
    });
    expect(contacts[1]).toEqual({
      id: "222@s.whatsapp.net",
      phone: "+222",
      name: null,
      isAdmin: false,
    });
  });

  it("returns null for empty-string notify name", async () => {
    const sock = mockSocket({
      groupMetadata: vi.fn().mockResolvedValue({
        participants: [
          { id: "444@s.whatsapp.net", admin: null, notify: "" },
        ],
      }),
    });
    vi.mocked(createSocket).mockResolvedValue(sock as any);

    const client = createWhatsAppClient("/fake/auth");
    await client.connect();
    const contacts = await client.getGroupContacts("g1@g.us");
    expect(contacts[0].name).toBeNull();
  });

  it("throws when calling methods before connect", async () => {
    const client = createWhatsAppClient("/fake/auth");
    await expect(client.getGroups()).rejects.toThrow("Not connected");
  });

  it("disconnect calls end on socket and clears it", async () => {
    const sock = mockSocket();
    vi.mocked(createSocket).mockResolvedValue(sock as any);

    const client = createWhatsAppClient("/fake/auth");
    await client.connect();
    await client.disconnect();

    expect(sock.end).toHaveBeenCalled();
    await expect(client.getGroups()).rejects.toThrow("Not connected");
  });

  it("sends a message via the socket", async () => {
    const sock = mockSocket();
    vi.mocked(createSocket).mockResolvedValue(sock as any);

    const client = createWhatsAppClient("/fake/auth");
    await client.connect();
    await client.sendMessage("111@s.whatsapp.net", "Hello!");

    expect(sock.sendMessage).toHaveBeenCalledWith("111@s.whatsapp.net", {
      text: "Hello!",
    });
  });
});
