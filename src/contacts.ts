import { readFile, writeFile, rename } from "fs/promises";
import type { ContactsFile } from "./types.js";

export function phoneFromJid(jid: string): string {
  const num = jid.split("@")[0].split(":")[0];
  return `+${num}`;
}

function validateContactsFile(data: unknown): asserts data is ContactsFile {
  if (
    typeof data !== "object" ||
    data === null ||
    !("group" in data) ||
    !("contacts" in data)
  ) {
    throw new Error(
      "Invalid contacts file: must contain 'group' and 'contacts' fields.",
    );
  }

  const obj = data as Record<string, unknown>;

  if (
    typeof obj.group !== "object" ||
    obj.group === null ||
    !("id" in (obj.group as Record<string, unknown>)) ||
    !("name" in (obj.group as Record<string, unknown>))
  ) {
    throw new Error(
      "Invalid contacts file: 'group' must have 'id' and 'name' fields.",
    );
  }

  if (typeof obj.exportedAt !== "string") {
    throw new Error(
      "Invalid contacts file: 'exportedAt' must be a string.",
    );
  }

  if (!Array.isArray(obj.contacts)) {
    throw new Error("Invalid contacts file: 'contacts' must be an array.");
  }

  for (let i = 0; i < obj.contacts.length; i++) {
    const c = obj.contacts[i];
    if (typeof c !== "object" || c === null || typeof c.id !== "string" || typeof c.phone !== "string") {
      throw new Error(
        `Invalid contacts file: contact at index ${i} must have string 'id' and 'phone' fields.`,
      );
    }
  }
}

export async function saveContacts(
  filePath: string,
  data: ContactsFile,
): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
  await rename(tmpPath, filePath);
}

export async function loadContacts(
  filePath: string,
): Promise<ContactsFile> {
  const raw = await readFile(filePath, "utf-8");
  const data: unknown = JSON.parse(raw);
  validateContactsFile(data);
  return data;
}
