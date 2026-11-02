import { CodexCliAdapter } from "./codex-cli-adapter";
import { FakeCodexAdapter } from "./fake-adapter";
import type { CodexAdapter } from "./types";

export * from "./codex-cli-adapter";
export * from "./fake-adapter";
export * from "./types";

/** Real subscription-backed generation is deliberately opt-in. */
export function createCodexAdapter(
  adapterName = process.env.CODEX_ADAPTER ?? "fake",
): CodexAdapter {
  switch (adapterName.toLowerCase()) {
    case "fake":
      return new FakeCodexAdapter();
    case "codex":
      return new CodexCliAdapter();
    default:
      throw new Error(
        `Unsupported CODEX_ADAPTER=${JSON.stringify(adapterName)}; expected "fake" or "codex"`,
      );
  }
}
