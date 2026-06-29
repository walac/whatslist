import { DisconnectReason, type WASocket, type Contact as BaileysContact } from "@whiskeysockets/baileys";
import { readFile, writeFile, rename } from "fs/promises";
import { join } from "path";
import type { Contact, SentMessage } from "./types.js";
import { phoneFromJid } from "./contacts.js";
import { withRetry } from "./retry.js";
import { createSocket } from "./auth.js";

export interface WhatsAppClient {
  connect(): Promise<void>;
  getGroups(): Promise<Array<{ id: string; subject: string }>>;
  getGroupContacts(groupId: string): Promise<Contact[]>;
  sendMessage(contactId: string, text: string): Promise<SentMessage | undefined>;
  deleteMessage(remoteJid: string, messageId: string, timestamp: number): Promise<void>;
  disconnect(): Promise<void>;
}

interface StoredName {
  notify?: string;
  name?: string;
  verifiedName?: string;
}

function pickName(c: StoredName): string | null {
  if (c.notify) return c.notify;
  if (c.name) return c.name;
  if (c.verifiedName) return c.verifiedName;
  return null;
}

function isLid(jid: string): boolean {
  return jid.endsWith("@lid");
}

function contactsDbPath(authDir: string): string {
  return join(authDir, "contacts.json");
}

async function loadContactsDb(
  path: string,
): Promise<Map<string, StoredName>> {
  try {
    const raw = await readFile(path, "utf-8");
    const entries: Record<string, StoredName> = JSON.parse(raw);
    return new Map(Object.entries(entries));
  } catch {
    return new Map();
  }
}

async function saveContactsDb(
  path: string,
  store: Map<string, StoredName>,
): Promise<void> {
  const obj = Object.fromEntries(store);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(obj), "utf-8");
  await rename(tmp, path);
}

export function createWhatsAppClient(authDir: string): WhatsAppClient {
  let sock: WASocket | null = null;
  let syncComplete: Promise<void> = Promise.resolve();
  let syncTimeout: ReturnType<typeof setTimeout> | undefined;
  let forceSync: (() => void) | undefined;
  const contactStore = new Map<string, StoredName>();
  let dirty = false;

  let connected: Promise<void> = Promise.resolve();
  let resolveConnected: (() => void) | null = null;
  let rejectConnected: ((err: Error) => void) | null = null;
  let closed = false;

  function registerContactListeners(socket: WASocket): void {
    socket.ev.on("contacts.upsert", mergeContacts);
    socket.ev.on("contacts.update", mergeContacts);
    socket.ev.on("messaging-history.set", ({ contacts }) => {
      if (contacts) mergeContacts(contacts);
    });
  }

  function setupConnectionMonitor(socket: WASocket): void {
    socket.ev.on("connection.update", (update) => {
      const { connection, lastDisconnect } = update;
      if (connection !== "close" || closed) return;

      const statusCode =
        (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
      const reason = lastDisconnect?.error?.message ?? "unknown reason";

      (socket.ev as unknown as NodeJS.EventEmitter).removeAllListeners();
      socket.end(undefined);
      sock = null;

      connected = new Promise((resolve, reject) => {
        resolveConnected = resolve;
        rejectConnected = reject;
      });

      if (statusCode === DisconnectReason.loggedOut) {
        console.error("\nLogged out from WhatsApp. Cannot reconnect.");
        rejectConnected!(new Error("Logged out"));
        return;
      }

      console.log(`\nConnection lost: ${reason}. Attempting to reconnect...`);
      attemptReconnect().catch(() => {});
    });
  }

  async function attemptReconnect(): Promise<void> {
    const maxAttempts = 5;
    const baseDelay = 2000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (closed) {
        rejectConnected?.(new Error("Client disconnected"));
        return;
      }

      const delay = baseDelay * 2 ** attempt;
      console.log(`  Reconnect attempt ${attempt + 1}/${maxAttempts} in ${delay / 1000}s...`);
      await new Promise((r) => setTimeout(r, delay));
      if (closed) {
        rejectConnected?.(new Error("Client disconnected"));
        return;
      }

      try {
        const newSock = await createSocket(authDir);
        sock = newSock;
        registerContactListeners(newSock);
        setupConnectionMonitor(newSock);
        console.log("  Reconnected successfully.");
        resolveConnected?.();
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`  Reconnect attempt ${attempt + 1} failed: ${msg}`);
        if (msg.includes("Logged out")) {
          rejectConnected?.(err instanceof Error ? err : new Error(msg));
          return;
        }
      }
    }

    const err = new Error("Failed to reconnect after maximum attempts");
    console.error(`\n${err.message}`);
    rejectConnected?.(err);
  }

  function mergeContacts(contacts: Partial<BaileysContact>[]): void {
    for (const c of contacts) {
      if (!c.id) continue;
      const nameData: StoredName = {};
      if (c.notify) nameData.notify = c.notify;
      if (c.name) nameData.name = c.name;
      if (c.verifiedName) nameData.verifiedName = c.verifiedName;
      if (!pickName(nameData)) continue;

      const existing = contactStore.get(c.id);
      contactStore.set(c.id, existing ? { ...existing, ...nameData } : nameData);
      if (c.lid) {
        const existingLid = contactStore.get(c.lid);
        contactStore.set(c.lid, existingLid ? { ...existingLid, ...nameData } : nameData);
      }
      dirty = true;
    }
  }

  return {
    async connect() {
      sock = await withRetry(() => createSocket(authDir), {
        shouldRetry: (err) => !err.message.includes("Logged out"),
      });

      const dbPath = contactsDbPath(authDir);
      const persisted = await loadContactsDb(dbPath);
      for (const [k, v] of persisted) contactStore.set(k, v);

      registerContactListeners(sock);
      setupConnectionMonitor(sock);

      syncComplete = new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => {
          if (resolved) return;
          resolved = true;
          clearTimeout(syncTimeout);
          syncTimeout = undefined;
          forceSync = undefined;
          resolve();
        };
        forceSync = done;
        syncTimeout = setTimeout(done, 10_000);

        sock!.ev.on("creds.update", (update) => {
          if ("accountSyncCounter" in update) done();
        });
        sock!.ev.on("messaging-history.set", () => done());
      });
    },

    async getGroups() {
      await connected;
      if (!sock) throw new Error("Not connected");
      const groups = await withRetry(async () => {
        await connected;
        if (!sock) throw new Error("Not connected");
        return sock.groupFetchAllParticipating();
      });
      return Object.values(groups).map((g) => ({
        id: g.id,
        subject: g.subject,
      }));
    },

    async getGroupContacts(groupId: string) {
      await connected;
      if (!sock) throw new Error("Not connected");

      await syncComplete;

      const metadata = await withRetry(async () => {
        await connected;
        if (!sock) throw new Error("Not connected");
        return sock.groupMetadata(groupId);
      });

      const lidIds = metadata.participants
        .filter((p) => isLid(p.id) && !p.phoneNumber)
        .map((p) => p.id);

      const lidToPhone = new Map<string, string>();
      if (lidIds.length > 0 && sock.signalRepository?.lidMapping) {
        const mappings = await sock.signalRepository.lidMapping
          .getPNsForLIDs(lidIds)
          .catch(() => null);
        if (mappings) {
          for (const m of mappings) {
            lidToPhone.set(m.lid, m.pn);
          }
        }
      }

      return metadata.participants.map((p) => {
        const phoneJid = p.phoneNumber ?? lidToPhone.get(p.id) ?? p.id;
        const contactId = isLid(p.id) ? phoneJid : p.id;

        const stored = contactStore.get(p.id) ?? contactStore.get(phoneJid);
        const name = pickName(p) ?? (stored ? pickName(stored) : null);

        return {
          id: contactId,
          phone: phoneFromJid(phoneJid),
          name,
          isAdmin: p.admin === "admin" || p.admin === "superadmin",
        };
      });
    },

    async sendMessage(contactId: string, text: string) {
      await connected;
      if (!sock) throw new Error("Not connected");
      const result = await withRetry(
        async () => {
          await connected;
          if (!sock) throw new Error("Not connected");
          return sock.sendMessage(contactId, { text });
        },
        {
          shouldRetry: (err) => {
            const msg = err.message.toLowerCase();
            if (msg.includes("not connected") || msg.includes("logged out") || msg.includes("disconnected") || msg.includes("reconnect")) return false;
            return !msg.includes("not on whatsapp") && !msg.includes("blocked");
          },
        },
      );
      if (!result?.key?.id || !result.key.remoteJid) return undefined;
      return {
        contactId,
        messageId: result.key.id,
        remoteJid: result.key.remoteJid,
        timestamp: typeof result.messageTimestamp === "number"
          ? result.messageTimestamp
          : Number(result.messageTimestamp ?? 0),
      };
    },

    async deleteMessage(remoteJid: string, messageId: string, timestamp: number) {
      await connected;
      if (!sock) throw new Error("Not connected");
      await withRetry(
        async () => {
          await connected;
          if (!sock) throw new Error("Not connected");
          return sock.chatModify(
            {
              deleteForMe: {
                deleteMedia: false,
                key: { id: messageId, fromMe: true, remoteJid },
                timestamp,
              },
            },
            remoteJid,
          );
        },
        {
          shouldRetry: (err) => {
            const msg = err.message.toLowerCase();
            if (msg.includes("not connected") || msg.includes("logged out") || msg.includes("disconnected") || msg.includes("reconnect")) return false;
            return !msg.includes("not found");
          },
        },
      );
    },

    async disconnect() {
      closed = true;
      rejectConnected?.(new Error("Client disconnected"));
      if (sock) {
        if (forceSync) forceSync();
        await syncComplete;
        if (dirty) {
          await saveContactsDb(contactsDbPath(authDir), contactStore)
            .catch(() => {});
        }
        (sock.ev as unknown as NodeJS.EventEmitter).removeAllListeners();
        sock.end(undefined);
        sock = null;
      }
    },
  };
}
