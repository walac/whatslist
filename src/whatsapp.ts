import type { WASocket } from "@whiskeysockets/baileys";
import type { Contact } from "./types.js";
import { phoneFromJid } from "./contacts.js";
import { withRetry } from "./retry.js";
import { createSocket } from "./auth.js";

export interface WhatsAppClient {
  connect(): Promise<void>;
  getGroups(): Promise<Array<{ id: string; subject: string }>>;
  getGroupContacts(groupId: string): Promise<Contact[]>;
  sendMessage(contactId: string, text: string): Promise<void>;
  disconnect(): Promise<void>;
}

function extractNotifyName(participant: Record<string, unknown>): string | null {
  if ("notify" in participant && typeof participant.notify === "string" && participant.notify !== "") {
    return participant.notify;
  }
  return null;
}

export function createWhatsAppClient(authDir: string): WhatsAppClient {
  let sock: WASocket | null = null;

  return {
    async connect() {
      sock = await withRetry(() => createSocket(authDir), {
        shouldRetry: (err) => !err.message.includes("Logged out"),
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
      const metadata = await withRetry(() => {
        if (!sock) throw new Error("Not connected");
        return sock.groupMetadata(groupId);
      });
      return metadata.participants.map((p) => ({
        id: p.id,
        phone: phoneFromJid(p.id),
        name: extractNotifyName(p as unknown as Record<string, unknown>),
        isAdmin: p.admin === "admin" || p.admin === "superadmin",
      }));
    },

    async sendMessage(contactId: string, text: string) {
      if (!sock) throw new Error("Not connected");
      await withRetry(
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
    },

    async disconnect() {
      if (sock) {
        sock.end(undefined);
        sock = null;
      }
    },
  };
}
