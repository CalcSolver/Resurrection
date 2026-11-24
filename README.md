# Resurrection

A full-text King James Version (KJV) scripture reader with an interactive **Luke 24:54** gateway wired to an Ultraviolet Service Worker on `/24/54/`.

## Features
- **All 66 Books:** Fetches public-domain KJV chapters dynamically with book/chapter navigation and instant verse filtering.
- **Luke 24:54 Cipher Trigger:** Navigating to **Luke 24**, clicking **Verse 24**, and then clicking the hidden **Verse 54** unlocks the `/24/54/` routing bar.
- **XOR Key `54` Codec:** Target URLs are encoded using bitwise XOR `54` under the `/24/54/` Service Worker scope.
- **Archive Fallback:** Optional Wayback Machine availability lookup (`archive.org/wayback/available`) to pull archived snapshots before routing.

## Setup
1. Place `index.html`, `uv.config.js`, `sw.js`, and `README.md` in your root directory.
2. Download the official Ultraviolet distribution files (`uv.bundle.js`, `uv.handler.js`, `uv.client.js`, `uv.sw.js`) from `@titaniumnetwork-dev/ultraviolet` and place them inside `/uv/`.
3. Configure your transport client (e.g., Bare-Mux + Epoxy/Wisp) and point it to a running Wisp or Bare backend server.
4. Serve over **HTTPS** (required for Service Worker registration).
