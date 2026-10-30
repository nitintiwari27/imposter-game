# Who's the Impostor?

A real-time party game for 3–20 players. Share a six-character room code, trade clues about a secret word, discuss, and vote for the impostor. No player accounts are needed.

## Play locally

Install Node.js 20 or newer, then run:

```powershell
npm ci
npm test
npm run build
$env:NODE_ENV = "production"
npm start
```

Open <http://localhost:3000>. The production server serves the web app and Socket.IO from the same port. To use hot reload while developing, run `npm run dev` and `npm run dev:client` in separate terminals, then open <http://localhost:5173>.

## Rules and scoring

The host starts a round after at least three players join. The server privately gives one player the impostor role and the rest the same secret word. The impostor sees the word category, but not the word. Everyone submits one clue, the crew discusses in room chat, and each player locks one vote. A tied vote lets the impostor escape. If the impostor is caught, they get one final word guess.

- Crew: +1 for voting for the impostor; +2 each when the impostor is caught.
- Impostor: +2 for escaping; +3 for guessing the word after being caught.
- First player to 10 points wins the match. A host can start another round; a completed match can be reset for a new match.

## Deploy on Render

The repository includes [`render.yaml`](render.yaml), which configures a single Node web service in Render's Singapore region. It serves the React app and Socket.IO from one public URL, so no separate frontend service, API key, or database setup is needed.

1. Put this project in a GitHub repository. The repository must include `package.json`, `package-lock.json`, `render.yaml`, and the `client`, `server`, and `shared` folders. Do not upload `node_modules`, `dist`, or `dist-server`.
2. In Render, choose **New → Blueprint**, connect the GitHub repository, and select **Apply**. Render reads `render.yaml`, installs dependencies, builds the app, and starts the game server.
3. Wait for the first deploy to finish, open the `onrender.com` URL Render gives you, and check that the game loads. The health endpoint is `<your-URL>/healthz` and should return `{"ok":true}`.
4. Open the game URL in two separate browser profiles/devices, create a room in one, and join it from the other. Add a third player to start a round.

No application environment variables need to be supplied manually. The Blueprint sets `NODE_ENV=production`; Render supplies `PORT` automatically.

### Push the project to GitHub from PowerShell

Create an empty repository on GitHub first. From this project folder, run the commands below, replacing the repository URL with your own. GitHub may ask you to sign in through its normal browser flow.

```powershell
git init
git add .
git commit -m "Build Who's the Impostor multiplayer game"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPOSITORY.git
git push -u origin main
```

Then connect that repository in Render as described above. When you push later changes to `main`, Render redeploys the service.

## Architecture

- `client/`: React, TypeScript, Vite, and Tailwind CSS frontend.
- `server/`: Express and Socket.IO server; owns rooms, roles, clues, chat, votes, timers, reveals, and scoring.
- `shared/`: client/server event and room snapshot types.
- `tests/`: Socket.IO integration tests using multiple independent clients.

Room codes are randomly generated, and room state is held in server memory. Private roles and the word are sent only to the relevant socket until the final reveal. Room state is not written to a database.

## Hosting limits

Render's free web services can sleep when idle, take around a minute to wake, and may restart. A restart clears active rooms and scores because the game intentionally has no database. Use this deployment for a free challenge/demo launch; choose an always-on paid service and add shared persistence before relying on it for uninterrupted public events or multiple server instances.
