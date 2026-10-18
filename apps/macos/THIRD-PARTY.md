# Desktop dependencies

This personal build links the published [cmux terminal client SDK](https://github.com/manaflow-ai/cmux/tree/main/Packages/Shared/CmuxTerminalClient) and bundles the `cmux-tui` 0.13.4 executable. The build script pins their public archives and verifies their digests. The SDK snapshot is `cmux-terminal-client-v0.1.0+6ba5de550cd4`.

cmux's repository and component licensing differ. Consult [the upstream repository](https://github.com/manaflow-ai/cmux) and the exact dependency revision before redistributing a bundle. This app's build/install workflow is for local personal use; it does not publish binaries.

The terminal renderer uses `@xterm/xterm`, `@xterm/addon-fit`, and `@xterm/addon-webgl` from this repository's npm lockfile. Their MIT license notices are copied alongside the bundled renderer. No renderer asset is fetched at application runtime.
