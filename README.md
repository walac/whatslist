# WhatsList

A command-line tool to export contacts from a WhatsApp group and send batch direct messages to them.

## How It Works

WhatsList connects to WhatsApp the same way WhatsApp Web does — by scanning a QR code with your phone. Once linked, it can read your groups and send messages on your behalf.

**Three commands:**

- **`auth`** — Link your WhatsApp account (one-time setup).
- **`export`** — Extracts all contacts from a WhatsApp group and saves them to a JSON file.
- **`send`** — Reads a contacts file and sends a private message to each person individually.

## Prerequisites

- **Node.js 18 or later** — check with `node --version`
- **A WhatsApp account** with the group you want to export

## Installation

```bash
git clone <this-repo>
cd whatslist
npm install
```

## Quick Start

### 1. Authenticate (one-time setup)

```bash
npx tsx src/index.ts auth
```

A QR code appears in your terminal:

```
▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄▄
█ ▄▄▄▄▄ █ ▄▄ █ ▄▄▄▄▄ █
...

Scan the QR code above with WhatsApp → Linked Devices
```

Open WhatsApp on your phone, go to **Settings > Linked Devices > Link a Device**, and scan the code:

```
Connecting to WhatsApp...

Authenticated successfully.
Credentials saved to /home/you/.config/whatslist/auth
```

You only need to do this once. Credentials are stored in `~/.config/whatslist/auth/` and reused automatically.

### 2. Export contacts from a group

```bash
npx tsx src/index.ts export --group "Family Chat"
```

```
Connecting to WhatsApp...
Fetching groups...
Fetching contacts from "Family Chat"...

Exported 12 contacts to contacts.json
```

### 3. Preview who would receive a message

Always preview first with `--dry-run`:

```bash
npx tsx src/index.ts send --file contacts.json --message "Hey! Party at my place Saturday" --dry-run
```

Output:

```
⊘ Maria Santos — dry run, would send
⊘ João Silva — dry run, would send
⊘ +5511888887777 — dry run, would send

Done: 0 sent, 0 failed, 12 skipped
```

### 4. Send the messages for real

```bash
npx tsx src/index.ts send --file contacts.json --message "Hey! Party at my place Saturday"
```

Output:

```
Connecting to WhatsApp...
✓ Maria Santos
✓ João Silva
✗ +5511888887777 — failed
✓ Ana Oliveira

Done: 11 sent, 1 failed, 0 skipped
```

Messages are sent with a random 3–7 second delay between each one to avoid triggering WhatsApp's spam detection.

## Command Reference

### `auth` — Link your WhatsApp account

```bash
npx tsx src/index.ts auth            # Scan QR code to authenticate
npx tsx src/index.ts auth --logout   # Remove stored credentials
```

| Option | Description |
|--------|-------------|
| `--logout` | Remove stored credentials and disconnect |

### `export` — Save group contacts to a file

```bash
npx tsx src/index.ts export --group "Group Name" [-o output.json]
```

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--group <name>` | Yes | — | Name of the WhatsApp group (case-insensitive match) |
| `-o, --output <file>` | No | `contacts.json` | Where to save the exported contacts |

If the group name doesn't match exactly, the tool suggests a close match:

```
Group "Fmily Chat" not found. Did you mean "Family Chat"?
```

### `send` — Send a message to each contact

```bash
npx tsx src/index.ts send --file contacts.json --message "Hello!"
npx tsx src/index.ts send --file contacts.json --message-file message.txt
```

| Option | Required | Default | Description |
|--------|----------|---------|-------------|
| `--file <path>` | Yes | — | Path to the contacts JSON file |
| `--message <text>` | One of these | — | Message text (inline) |
| `--message-file <path>` | is required | — | Read message from a text file (preserves newlines) |
| `--filter-out <path>` | No | — | Contacts JSON file of people to exclude |
| `--dry-run` | No | `false` | Preview recipients without sending |

`--message` and `--message-file` are mutually exclusive — use one or the other.

**Filtering out contacts** is useful when you want to skip certain people — for example, export two groups and send to one while excluding members of the other:

```bash
npx tsx src/index.ts export --group "Board Members" -o board.json
npx tsx src/index.ts send --file contacts.json --message "General update" --filter-out board.json
```

The filter file uses the same JSON format as the export, so any exported contacts file works as a filter.

**Using a message file** is useful for multi-line messages:

```bash
cat > message.txt << 'EOF'
Hi there!

Reminder: our meetup is this Saturday at 3pm.
Location: Central Park, near the fountain.

See you there!
EOF

npx tsx src/index.ts send --file contacts.json --message-file message.txt
```

## Contacts File Format

The exported JSON file looks like this:

```json
{
  "group": {
    "id": "123456789@g.us",
    "name": "Family Chat"
  },
  "exportedAt": "2026-06-19T15:30:00Z",
  "contacts": [
    {
      "id": "5511999998888@s.whatsapp.net",
      "phone": "+5511999998888",
      "name": "Maria Santos",
      "isAdmin": true
    },
    {
      "id": "5511777776666@s.whatsapp.net",
      "phone": "+5511777776666",
      "name": null,
      "isAdmin": false
    }
  ]
}
```

| Field | Description |
|-------|-------------|
| `id` | WhatsApp internal identifier (used for sending) |
| `phone` | Phone number with country code |
| `name` | Contact's WhatsApp profile name, or `null` if not set |
| `isAdmin` | Whether the contact is a group admin |

You can edit this file before sending — for example, remove contacts you don't want to message, or merge contacts from multiple groups.

## Resuming After a Failure

If the send process is interrupted (network issue, crash, Ctrl+C), it creates a log file alongside your contacts file (e.g., `contacts.send-log.json`) that tracks which contacts already received the message.

Simply re-run the same send command — it automatically skips contacts that were already messaged:

```
⊘ Maria Santos — already sent, skipping
⊘ João Silva — already sent, skipping
✓ Ana Oliveira

Done: 1 sent, 0 failed, 2 skipped
```

To start fresh (re-send to everyone), delete the `.send-log.json` file.

## Authentication

WhatsList stores your WhatsApp session in `~/.config/whatslist/auth/` (or `$XDG_CONFIG_HOME/whatslist/auth/` if you've customized `XDG_CONFIG_HOME`). This means:

- **First time**: run `whatslist auth` and scan the QR code
- **Subsequent runs**: it reconnects automatically — no QR code needed
- **Works from any directory**: credentials are stored globally, not per-project
- **To log out**: run `whatslist auth --logout`
- **Security**: never share your `~/.config/whatslist/auth/` folder — it contains your session keys

## Network Reliability

All network operations (connecting, fetching groups, sending messages) automatically retry on failure using exponential backoff:

- Up to 5 retries per operation
- Delays: ~1s, ~2s, ~4s, ~8s, ~16s (with slight randomization)
- If all retries fail, the operation reports an error and moves on

For batch sends, a single contact's failure doesn't stop the rest — the tool logs the failure and continues.

## Important Warnings

**Account risk**: WhatsApp does not officially support automation on personal accounts. Using this tool may result in temporary or permanent restrictions on your account. Use responsibly:

- Don't send messages to large numbers of contacts you don't know
- Don't send spam or unsolicited marketing
- Keep message volumes reasonable
- Use the built-in delays (don't bypass them)

**Not a marketing tool**: This is designed for legitimate personal use — notifying group members about events, sending updates to people you know, etc.

## Development

```bash
npm test              # Run tests
npm run test:watch    # Run tests in watch mode
npm run build         # Compile TypeScript to dist/
```

## License

ISC
