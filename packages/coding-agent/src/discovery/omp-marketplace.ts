/**
 * OMP Marketplace Plugin Provider
 *
 * Thin registration over the shared marketplace loader implementation
 * (./marketplace-provider.ts). Reads OMP's own registries
 * (~/.omp/plugins/installed_plugins.json, the nearest project registry) plus
 * injected --plugin-dir roots. Priority: 71 (above claude-plugins at 70 so an
 * OMP entry wins a shared capability key; below agent-plugins at 75 and
 * claude.ts at 80).
 */
import { registerMarketplaceProvider } from "./marketplace-provider";

registerMarketplaceProvider({
	id: "omp-marketplace",
	displayName: "OMP Marketplace",
	priority: 71,
	source: "omp",
});
