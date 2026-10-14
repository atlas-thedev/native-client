# Native Client – SignPath code signing (PRD)

## Problem
Open-source Electron Minecraft launcher (public repo atlas-thedev/native-client, sells server-side cosmetics). Windows builds were unsigned (SmartScreen). Goal: qualify for free SignPath Foundation OSS signing and wire it into GitHub Actions. User language: Sinhala.

## Done (Jun 2026)
- LICENSE (MIT) + package.json "license": "MIT"
- README.md with SignPath credit line, Code signing policy (team roles), Privacy policy
- .github/workflows/release.yml: new `build-windows` job (package --dir -> SignPath sign app exe -> --prepackaged installer/zip -> SignPath sign installer -> finalize -> gh release upload); publish waits on it
- scripts/finalize-signed-installer.js: swaps signed installer, rebuilds blockmap, rewrites latest.yml sha512/size (tested locally with fake files)
- .signpath/artifact-configurations/{win-unpacked,installer}.xml to paste into SignPath

## User TODO
- Apply at signpath.org, create project slug `native-client`, signing policy `release-signing`, artifact configs `win-unpacked` + `installer`
- GitHub secrets: SIGNPATH_API_TOKEN, SIGNPATH_ORGANIZATION_ID
- Add SignPath credit + link to code signing policy on playnative.net download page (website code not in this repo)

## Backlog
- P1: Real CI run validation after SignPath approval
- P2: Set win publisherName once signed so auto-updater verifies signature
