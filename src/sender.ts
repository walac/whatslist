import { readFile, writeFile, rename } from "fs/promises";
import { parse, join } from "path";
import type { SendLog } from "./types.js";
import { loadContacts } from "./contacts.js";
import type { WhatsAppClient } from "./whatsapp.js";

export interface SendOptions {
  contactsFile: string;
  message: string;
  dryRun: boolean;
  filterOutFile?: string;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export interface SendResult {
  sent: number;
  failed: number;
  skipped: number;
}

function sendLogPath(contactsFile: string): string {
  const { dir, name } = parse(contactsFile);
  return join(dir, name + ".send-log.json");
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
  const minDelay = options.minDelayMs ?? 3000;
  const maxDelay = options.maxDelayMs ?? 7000;

  const data = await loadContacts(options.contactsFile);
  const logPath = sendLogPath(options.contactsFile);
  const log = await loadSendLog(logPath);
  const sentSet = new Set(log.sentIds);
  const result: SendResult = { sent: 0, failed: 0, skipped: 0 };

  let excludedIds: Set<string> | null = null;
  if (options.filterOutFile) {
    const excluded = await loadContacts(options.filterOutFile);
    excludedIds = new Set(excluded.contacts.map((c) => c.id));
  }

  for (let i = 0; i < data.contacts.length; i++) {
    if (shuttingDown) {
      console.log("\nShutting down gracefully...");
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

    try {
      await client.sendMessage(contact.id, options.message);
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

    if (!shuttingDown && i < data.contacts.length - 1) {
      await randomDelay(minDelay, maxDelay);
    }
  }

  return result;
}
