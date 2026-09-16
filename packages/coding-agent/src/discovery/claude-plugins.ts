/**
 * Claude Code Marketplace Plugin Provider
 *
 * Thin registration over the shared marketplace loader implementation
 * (./marketplace-provider.ts). Reads only the Claude Code registry
 * (~/.claude/plugins/cache/ plus its enabledPlugins settings).
 * Priority: 70 (below claude.ts at 80, so user overrides in .claude/ take
 * precedence).
 */
import { registerMarketplaceProvider } from "./marketplace-provider";

registerMarketplaceProvider({
	id: "claude-plugins",
	displayName: "Claude Code Marketplace",
	priority: 70,
	source: "claude",
});
