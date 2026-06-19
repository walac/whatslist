import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";
import { mkdirSync, chmodSync, readdirSync, statSync } from "fs";
import { join } from "path";
import qrcode from "qrcode-terminal";

const CONNECTION_TIMEOUT_MS = 120_000;

function ensureSecureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function lockdownAuthFiles(dir: string): void {
  try {
    for (const entry of readdirSync(dir)) {
      const fullPath = join(dir, entry);
      if (statSync(fullPath).isFile()) {
        chmodSync(fullPath, 0o600);
      }
    }
  } catch {
    // best-effort — dir may not exist yet on first run
  }
}

export async function createSocket(
  authDir: string,
  timeoutMs: number = CONNECTION_TIMEOUT_MS,
): Promise<WASocket> {
  ensureSecureDir(authDir);
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  lockdownAuthFiles(authDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("creds.update", () => {
    saveCreds()
      .then(() => lockdownAuthFiles(authDir))
      .catch((err) => {
        console.error("Failed to save credentials:", err instanceof Error ? err.message : String(err));
      });
  });

  const timeoutMsg = `Connection timed out after ${timeoutMs / 1000}s. Check your network or try again.`;

  return new Promise<WASocket>((resolve, reject) => {
    let settled = false;

    function settle<T>(fn: (value: T) => void, value: T): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }

    let timer = setTimeout(() => {
      sock.end(undefined);
      settle(reject, new Error(timeoutMsg));
    }, timeoutMs);

    sock.ev.on("connection.update", (update) => {
      if (settled) return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          sock.end(undefined);
          settle(reject, new Error(timeoutMsg));
        }, timeoutMs);

        qrcode.generate(qr, { small: true });
        console.log(
          "\nScan the QR code above with WhatsApp → Linked Devices\n",
        );
      }

      if (connection === "open") {
        settle(resolve, sock);
      }

      if (connection === "close") {
        const statusCode =
          (lastDisconnect?.error as { output?: { statusCode?: number } })?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          settle(
            reject,
            new Error(
              "Logged out. Run 'whatslist auth --logout' then 'whatslist auth' to re-authenticate.",
            ),
          );
        } else {
          settle(
            reject,
            new Error(
              `Connection closed: ${lastDisconnect?.error?.message ?? "unknown reason"}`,
            ),
          );
        }
      }
    });
  });
}
