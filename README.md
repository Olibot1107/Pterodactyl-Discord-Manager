# Pterodactyl Discord Manager

A Discord bot for managing user registration, server creation, and administration for a [Pterodactyl](https://pterodactyl.io/) panel. Users can register via email OTP, create servers, and manage their panel accounts directly from Discord.

## Features

- **User Registration:** Register with email verification and OTP.
- **Server Creation:** Create servers with resource tiers (Free/Premium) and select from Node.js, Python, or Java eggs.
- **Account Management:** Delete account and view owned servers.
- **Admin Tools:** Suspend/unsuspend servers, timeout users, and ban users.
- **Role Sync:** Automatically assign roles based on server ownership.

## Commands

- `/register <email>` – Register a new panel account.
- `/create <egg> <servername>` – Create a new server.
- `/delete <serverid>` – Delete one of your servers.
- `/deleteaccount` – Delete your panel account and all servers.
- `/list` – View your servers.
- `/server <start|stop|restart|kill|status|suspend|unsuspend>` – Manage server power and suspension.
- `/timeout <user> <minutes> [reason]` – (Admin) Timeout user and suspend all their servers.
- `/ban <user> [reason] [prune_hours]` – (Admin) Ban user from the guild.
- `/stick <add|edit|remove|remove_from_list|list|config|toggle>` – (Admin) Manage multiple sticky messages per channel (use sticky IDs or list index).
- `/ping` – Check bot latency.

## Setup

### Prerequisites

- Node.js v18+
- MongoDB database
- A Pterodactyl panel with API access
- A Discord bot token

### Installation

1. **Clone the repository:**
   ```sh
   git clone <your-repo-url>
   cd Pterodactyl-Discord-Manager
   ```

2. **Install dependencies:**
   ```sh
   npm install
   ```

3. **Configure settings:**
   - Copy `settings.js` and fill in your credentials:
   - Discord bot token
   - MongoDB connection string
   - Admin Discord user ID
    - Pterodactyl panel URL and API keys

4. **Configure SMTP for email verification:**
   - Edit [`src/structures/sendVerificationEmail.js`](src/structures/sendVerificationEmail.js) and set your SMTP credentials.

5. **Start the bot:**
   ```sh
   npm start
   ```

## File Structure

- [`src/commands/`](src/commands/) – All bot commands (Panel and Misc).
- [`src/events/`](src/events/) – Discord event handlers.
- [`src/models/`](src/models/) – Mongoose models for users.
- [`src/structures/`](src/structures/) – Utility classes and API wrappers.
- [`settings.js`](settings.js) – Main configuration file.

## Notes

- Only admins can use moderation commands like `/server suspend`, `/server unsuspend`, `/timeout`, and `/ban`.
