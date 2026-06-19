#!/usr/bin/env node

process.umask(0o077);

import { Command } from "commander";
import { existsSync } from "fs";
import { readFile, rm } from "fs/promises";
import { createWhatsAppClient } from "./whatsapp.js";
import { saveContacts } from "./contacts.js";
import { sendBatch, requestShutdown, shuttingDown } from "./sender.js";
import { getAuthDir } from "./config.js";
import type { ContactsFile } from "./types.js";

const program = new Command();

program
  .name("whatslist")
  .description("Export WhatsApp group contacts and send batch messages")
  .version("1.0.0");

function requireAuth(authDir: string): void {
  if (!existsSync(authDir)) {
    console.error("Not authenticated. Run `whatslist auth` first.");
    process.exit(1);
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (shuttingDown) process.exit(1);
    requestShutdown();
  });
}

program
  .command("auth")
  .description("Authenticate with WhatsApp by scanning a QR code")
  .option("--logout", "Remove stored authentication credentials")
  .action(async (opts: { logout?: boolean }) => {
    const authDir = getAuthDir();

    if (opts.logout) {
      if (!existsSync(authDir)) {
        console.log("No stored credentials found.");
        return;
      }
      await rm(authDir, { recursive: true });
      console.log("Logged out. Credentials removed.");
      return;
    }

    console.log("Connecting to WhatsApp...");
    const client = createWhatsAppClient(authDir);
    try {
      await client.connect();
      console.log(`\nAuthenticated successfully.`);
      console.log(`Credentials saved to ${authDir}`);
    } finally {
      await client.disconnect();
    }
  });

program
  .command("export")
  .description("Export contacts from a WhatsApp group")
  .requiredOption("--group <name>", "Group name to export contacts from")
  .option("-o, --output <file>", "Output file path", "contacts.json")
  .action(async (opts: { group: string; output: string }) => {
    const authDir = getAuthDir();
    requireAuth(authDir);

    const client = createWhatsAppClient(authDir);
    try {
      console.log("Connecting to WhatsApp...");
      await client.connect();

      console.log("Fetching groups...");
      const groups = await client.getGroups();

      const match = groups.find(
        (g) => g.subject.toLowerCase() === opts.group.toLowerCase(),
      );

      if (!match) {
        const similar = groups
          .filter((g) =>
            g.subject.toLowerCase().includes(opts.group.toLowerCase()),
          )
          .slice(0, 5);
        const suggestion =
          similar.length > 0
            ? ` Did you mean: ${similar.map((g) => `"${g.subject}"`).join(", ")}?`
            : "";
        console.error(`Group "${opts.group}" not found.${suggestion}`);
        process.exitCode = 1;
        return;
      }

      console.log(`Fetching contacts from "${match.subject}"...`);
      const contacts = await client.getGroupContacts(match.id);

      const data: ContactsFile = {
        group: { id: match.id, name: match.subject },
        exportedAt: new Date().toISOString(),
        contacts,
      };

      await saveContacts(opts.output, data);
      console.log(
        `\nExported ${contacts.length} contacts to ${opts.output}`,
      );
    } finally {
      await client.disconnect();
    }
  });

program
  .command("send")
  .description("Send a message to all contacts in a file")
  .requiredOption("--file <path>", "Path to contacts JSON file")
  .option("--message <text>", "Message text to send")
  .option("--message-file <path>", "Path to file containing message text")
  .option("--filter-out <path>", "Path to contacts JSON file of people to exclude")
  .option("--dry-run", "Preview recipients without sending", false)
  .action(
    async (opts: {
      file: string;
      message?: string;
      messageFile?: string;
      filterOut?: string;
      dryRun: boolean;
    }) => {
      if (opts.message && opts.messageFile) {
        console.error(
          "Use either --message or --message-file, not both.",
        );
        process.exit(1);
      }
      if (!opts.message && !opts.messageFile) {
        console.error("Provide either --message or --message-file.");
        process.exit(1);
      }

      let message: string;
      if (opts.messageFile) {
        try {
          message = await readFile(opts.messageFile, "utf-8");
        } catch {
          console.error(`Could not read message file: ${opts.messageFile}`);
          process.exit(1);
        }
      } else {
        message = opts.message!;
      }

      if (!message.trim()) {
        console.error("Message is empty. Provide a non-empty message.");
        process.exit(1);
      }

      const client = opts.dryRun ? null : (() => {
        const authDir = getAuthDir();
        requireAuth(authDir);
        return createWhatsAppClient(authDir);
      })();

      try {
        if (client) {
          console.log("Connecting to WhatsApp...");
          await client.connect();
        }

        const result = await sendBatch(client, {
          contactsFile: opts.file,
          message,
          dryRun: opts.dryRun,
          filterOutFile: opts.filterOut,
        });

        console.log(
          `\nDone: ${result.sent} sent, ${result.failed} failed, ${result.skipped} skipped`,
        );
      } finally {
        if (client) await client.disconnect();
      }
    },
  );

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
