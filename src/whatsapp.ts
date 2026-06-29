import type { WASocket, Contact as BaileysContact } from "@whiskeysockets/baileys";
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

      sock.ev.on("contacts.upsert", mergeContacts);
      sock.ev.on("contacts.update", mergeContacts);
      sock.ev.on("messaging-history.set", ({ contacts }) => {
        if (contacts) mergeContacts(contacts);
      });

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
      if (!sock) throw new Error("Not connected");
      const groups = await withRetry(() => {
        if (!sock) throw new Error("Not connected");
        return sock.groupFetchAllParticipating();
      });
      return Object.values(groups).map((g) => ({
        id: g.id,
        subject: g.subject,
      }));
    },

    async getGroupContacts(groupId: string) {
      if (!sock) throw new Error("Not connected");

      await syncComplete;

      const metadata = await withRetry(() => {
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
      if (!sock) throw new Error("Not connected");
      const result = await withRetry(
        () => {
          if (!sock) throw new Error("Not connected");
          return sock.sendMessage(contactId, { text });
        },
        {
          shouldRetry: (err) => {
            if (err.message === "Not connected") return false;
            const msg = err.message.toLowerCase();
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

    async disconnect() {
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
