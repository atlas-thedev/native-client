# Native Client

A free, open-source Minecraft launcher for Windows, macOS and Linux.

- Website: https://playnative.net
- Downloads: https://github.com/atlas-thedev/native-client-releases/releases
- Support: support@playnative.net

## Building

```bash
npm ci
npm run dev        # launcher in development mode
npm test           # unit tests
npm run dist:win   # Windows installer (unsigned, local)
```

Official releases are built by GitHub Actions (`.github/workflows/release.yml`) from tagged commits in this repository.

## Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

Windows release binaries (`Native Client.exe` and `Native-Client-Setup-*.exe`) are built exclusively on GitHub-hosted runners from the source code in this repository and signed through SignPath. Every signing request is manually approved.

**Team roles**

- Committers and reviewers: [atlas-thedev](https://github.com/atlas-thedev)
- Approvers: [atlas-thedev](https://github.com/atlas-thedev)

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

When you use the launcher it connects to:

- **Microsoft / Mojang** (`login.live.com`, `api.minecraftservices.com`, `*.mojang.com`) to sign in and download the game.
- **Mod and loader sources** (Modrinth, CurseForge, Fabric, Quilt, Forge, NeoForge, Adoptium) when you browse or install mods, loaders or Java.
- **Native Client services** (`playnative.net`, `api.playnative.net`) for your profile, cosmetics, friends, store and crash reports you choose to send.
- **Log paste services** (`mclo.gs`, `pastes.dev`) only when you choose to share a log.

Purchases are handled by our payment provider; the launcher never stores card details.

## License

[MIT](LICENSE)
