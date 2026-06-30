import { readFile, writeFile, rename } from "fs/promises";
import { parse, join } from "path";
import type { SendLog, SentMessage } from "./types.js";
import { loadContacts } from "./contacts.js";
import type { WhatsAppClient } from "./whatsapp.js";

export interface SendOptions {
  contactsFile: string;
  message: string;
  dryRun: boolean;
  filterOutFile?: string;
  maxSends?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export interface SendResult {
  sent: number;
  failed: number;
  skipped: number;
}

export interface DeleteResult {
  deleted: number;
  failed: number;
}

function sendLogPath(contactsFile: string): string {
  const { dir, name } = parse(contactsFile);
  return join(dir, name + ".send-log.json");
}

function messagesPath(contactsFile: string): string {
  const { dir, name } = parse(contactsFile);
  return join(dir, name + ".messages.json");
}

export async function loadMessages(path: string): Promise<SentMessage[]> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as SentMessage[];
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

async function saveMessages(path: string, messages: SentMessage[]): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(messages, null, 2), "utf-8");
  await rename(tmpPath, path);
}

function validateSendLog(data: unknown): asserts data is SendLog {
  if (
    typeof data !== "object" ||
    data === null ||
    !Array.isArray((data as Record<string, unknown>).sentIds)
  ) {
    throw new Error("Invalid send log: must contain a 'sentIds' array.");
  }
  const arr = (data as Record<string, unknown>).sentIds as unknown[];
  for (let i = 0; i < arr.length; i++) {
    if (typeof arr[i] !== "string") {
      throw new Error(
        `Invalid send log: sentIds[${i}] must be a string.`,
      );
    }
  }
}

async function loadSendLog(path: string): Promise<SendLog> {
  try {
    const raw = await readFile(path, "utf-8");
    const data: unknown = JSON.parse(raw);
    validateSendLog(data);
    return data;
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return { sentIds: [], startedAt: new Date().toISOString() };
    }
    throw err;
  }
}

async function saveSendLog(path: string, log: SendLog): Promise<void> {
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, JSON.stringify(log, null, 2), "utf-8");
  await rename(tmpPath, path);
}

export function uniquifyMessage(message: string): string {
  const suffix = Math.floor(Math.random() * 1_000_000_000).toString().padStart(9, "0");
  return `${message}\n\n${suffix}`;
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const effectiveMax = Math.max(minMs, maxMs);
  if (effectiveMax <= 0) return Promise.resolve();
  const delay = minMs + Math.random() * (effectiveMax - minMs);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export let shuttingDown = false;

export function requestShutdown(): void {
  shuttingDown = true;
}

export function resetShutdown(): void {
  shuttingDown = false;
}

export async function sendBatch(
  client: WhatsAppClient | null,
  options: SendOptions,
): Promise<SendResult> {
  const minDelay = options.minDelayMs ?? 15000;
  const maxDelay = options.maxDelayMs ?? 45000;

  const data = await loadContacts(options.contactsFile);
  const logPath = sendLogPath(options.contactsFile);
  const log = await loadSendLog(logPath);
  const sentSet = new Set(log.sentIds);
  const result: SendResult = { sent: 0, failed: 0, skipped: 0 };

  const msgPath = messagesPath(options.contactsFile);
  const messages = await loadMessages(msgPath);

  let excludedIds: Set<string> | null = null;
  if (options.filterOutFile) {
    try {
      const filterLog = await loadSendLog(options.filterOutFile);
      excludedIds = new Set(filterLog.sentIds);
    } catch {
      const excluded = await loadContacts(options.filterOutFile);
      excludedIds = new Set(excluded.contacts.map((c) => c.id));
    }
  }

  for (let i = 0; i < data.contacts.length; i++) {
    if (shuttingDown) {
      console.log("\nShutting down gracefully...");
      break;
    }

    if (options.maxSends != null && result.sent >= options.maxSends) {
      console.log(`\nReached send limit of ${options.maxSends}.`);
      break;
    }

    const contact = data.contacts[i];
    const displayName = contact.name ?? contact.phone;

    if (excludedIds?.has(contact.id)) {
      console.log(`⊘ ${displayName} — filtered out, skipping`);
      result.skipped++;
      continue;
    }

    if (sentSet.has(contact.id)) {
      console.log(`⊘ ${displayName} — already sent, skipping`);
      result.skipped++;
      continue;
    }

    if (options.dryRun || !client) {
      const reason = !client ? "no connection" : "dry run";
      console.log(`⊘ ${displayName} — ${reason}, would send`);
      result.skipped++;
      continue;
    }

    const personalizedMessage = uniquifyMessage(options.message);
    let sentMsg: SentMessage | undefined;
    try {
      sentMsg = await client.sendMessage(contact.id, personalizedMessage);
      console.log(`✓ ${displayName}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ ${displayName} — ${msg}`);
      result.failed++;
      continue;
    }

    try {
      log.sentIds.push(contact.id);
      sentSet.add(contact.id);
      await saveSendLog(logPath, log);
      result.sent++;
    } catch (logErr) {
      console.error(
        `\n⚠ CRITICAL: Sent message to ${displayName} but failed to save send log. Halting to prevent duplicate sends.`,
      );
      throw logErr;
    }

    if (sentMsg) {
      messages.push(sentMsg);
      await saveMessages(msgPath, messages).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`⚠ Failed to save message key for ${displayName}: ${msg}`);
      });
    }

    if (!shuttingDown && i < data.contacts.length - 1) {
      await randomDelay(minDelay, maxDelay);
    }
  }

  return result;
}

export interface DeleteOptions {
  messagesFile: string;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export async function deleteBatch(
  client: WhatsAppClient,
  options: DeleteOptions,
): Promise<DeleteResult> {
  const minDelay = options.minDelayMs ?? 1000;
  const maxDelay = options.maxDelayMs ?? 3000;

  const messages = await loadMessages(options.messagesFile);
  if (messages.length === 0) {
    console.log("No messages to delete.");
    return { deleted: 0, failed: 0 };
  }

  const deletedIds = new Set<string>();
  const result: DeleteResult = { deleted: 0, failed: 0 };

  for (let i = 0; i < messages.length; i++) {
    if (shuttingDown) {
      console.log("\nShutting down gracefully...");
      break;
    }

    const msg = messages[i];
    const displayName = msg.contactId.split("@")[0];

    try {
      await client.deleteMessage(msg.remoteJid, msg.messageId, msg.timestamp);
      console.log(`✓ deleted message to ${displayName}`);
      deletedIds.add(msg.messageId);
      result.deleted++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.log(`✗ ${displayName} — ${errMsg}`);
      result.failed++;
      continue;
    }

    const remaining = messages.filter((m) => !deletedIds.has(m.messageId));
    await saveMessages(options.messagesFile, remaining).catch((err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`⚠ Failed to update messages file: ${errMsg}`);
    });

    if (!shuttingDown && i < messages.length - 1) {
      await randomDelay(minDelay, maxDelay);
    }
  }

  return result;
}
