import { homedir } from "os";
import { join } from "path";

export function getAuthDir(): string {
  const configHome =
    process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(configHome, "whatslist", "auth");
}
