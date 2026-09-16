/**
 * Agent discovery from filesystem.
 *
 * Discovers agent definitions from OMP-native task-agent roots:
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *   - <ext>/agents/*.md for every OMP extension package wired through
 *     `listOmpExtensionRoots` (CLI `--extension` roots, `extensions:` in
 *     settings, and enabled npm/link plugins under `<plugins>/node_modules/`).
 *     Mirrors the same sub-discovery convention applied to `skills/`,
 *     `hooks/`, `tools/`, etc. by `discovery/omp-plugins.ts`.
 *
 * Claude Code marketplace plugin agents are discovered separately via the
 * claude-plugins provider. Direct cross-harness roots such as .claude/agents
 * are intentionally skipped because their frontmatter schema is not the OMP
 * task-agent contract.
 *
 * Agent files use markdown with YAML frontmatter.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import { isProviderEnabled, isUserSourceEnabled } from "../capability";
import type { EffectiveExtensionRoots } from "../capability/types";
import { findAllNearestProjectConfigDirs, getConfigDirs } from "../config";
import { pluginUsesClaudeModelDialect } from "../discovery/agent-plugin-format";
import { type ClaudePluginRoot, listClaudePluginRoots } from "../discovery/helpers";
import { listOmpExtensionRoots } from "../discovery/omp-extension-roots";
import { loadBundledAgents, parseAgent } from "./agents";
import type { AgentDefinition, AgentSource } from "./types";

const TASK_AGENT_CONFIG_SOURCE = ".omp";

/** Result of agent discovery */
export interface DiscoveryResult {
	agents: AgentDefinition[];
	projectAgentsDir: string | null;
}

interface AgentDirectory {
	dir: string;
	source: AgentSource;
	ignoreModel?: boolean;
}

/**
 * Load agents from a directory.
 */
async function loadAgentsFromDir({ dir, source, ignoreModel }: AgentDirectory): Promise<AgentDefinition[]> {
	const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
	const files = entries
		.filter(entry => (entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md"))
		.sort((a, b) => a.name.localeCompare(b.name))
		.map(file => {
			const filePath = path.join(dir, file.name);
			return fs
				.readFile(filePath, "utf-8")
				.then(content => {
					const agent = parseAgent(filePath, content, source, "warn");
					if (ignoreModel) agent.model = undefined;
					return agent;
				})
				.catch(error => {
					logger.warn("Failed to read agent file", { filePath, error });
					return null;
				});
		});

	return (await Promise.all(files)).filter(Boolean) as AgentDefinition[];
}

/**
 * Append one marketplace lane's agent directories, project scope before user
 * scope. `ignoreModel` marks roots whose `model:` frontmatter follows the
 * Claude dialect and must not be read as OMP selectors.
 */
async function appendMarketplaceAgentDirs(
	orderedDirs: AgentDirectory[],
	roots: ClaudePluginRoot[],
	ignoreModel: (root: ClaudePluginRoot) => boolean | Promise<boolean>,
): Promise<void> {
	const sorted = [...roots].sort((a, b) => {
		if (a.scope === b.scope) return 0;
		return a.scope === "project" ? -1 : 1;
	});
	const drops = await Promise.all(sorted.map(root => ignoreModel(root)));
	sorted.forEach((root, index) => {
		orderedDirs.push({
			dir: path.join(root.path, "agents"),
			source: root.scope === "project" ? "project" : "user",
			ignoreModel: drops[index],
		});
	});
}

/**
 * Discover agents from filesystem and merge with bundled agents.
 * Precedence (highest wins): project `.omp/agents`, user `.omp/agents`,
 * OMP extension-package agents from the effective `extensions` setting,
 * installed npm/link plugins, Claude marketplace plugin agents (project scope
 * before user), then bundled.
 * @param cwd - Current working directory for project agent discovery
 * @param home - Home directory for user and marketplace discovery
 * @param extensionRoots - Session-local extension roots (explicit + mode + configured)
 */
export async function discoverAgents(
	cwd: string,
	home: string = os.homedir(),
	extensionRoots?: EffectiveExtensionRoots,
): Promise<DiscoveryResult> {
	const resolvedCwd = path.resolve(cwd);

	const userDirs = getConfigDirs("agents", { project: false })
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const projectDirs = findAllNearestProjectConfigDirs("agents", resolvedCwd)
		.filter(entry => entry.source === TASK_AGENT_CONFIG_SOURCE)
		.map(entry => ({
			...entry,
			path: path.resolve(entry.path),
		}));

	const orderedDirs: AgentDirectory[] = [];
	const project = projectDirs[0];
	if (project) orderedDirs.push({ dir: project.path, source: "project" });
	const user = userDirs[0];
	if (user) orderedDirs.push({ dir: user.path, source: "user" });

	// Extension-package agents use the same effective root set as sibling
	// skills/hooks/tools, threaded whole so explicit roots and mode survive.
	const packageRoots = isProviderEnabled("omp-plugins")
		? await listOmpExtensionRoots({ cwd: resolvedCwd, home, repoRoot: null, extensionRoots })
		: [];
	for (const root of packageRoots) {
		orderedDirs.push({ dir: path.join(root.path, "agents"), source: root.level });
	}

	// Marketplace plugin agents load through two independently gated lanes.
	// The OMP lane (OMP registries + --plugin-dir roots) is gated only by the
	// omp-marketplace whole-provider switch — these are OMP's own installs and
	// need no foreign opt-in. The Claude lane keeps the claude-plugins
	// user-source opt-in for user-scope roots; project roots stay available
	// without it (mirroring allowedRoots in discovery/marketplace-provider.ts).
	// The OMP lane runs first so equal agent names resolve to OMP bodies.
	if (isProviderEnabled("omp-marketplace")) {
		const { roots } = await listClaudePluginRoots(home, resolvedCwd, "omp");
		await appendMarketplaceAgentDirs(orderedDirs, roots, plugin => pluginUsesClaudeModelDialect(plugin.path));
	}
	if (isProviderEnabled("claude-plugins")) {
		const claudePluginsUserEnabled = isUserSourceEnabled("claude-plugins") || isUserSourceEnabled("claude");
		const { roots } = await listClaudePluginRoots(home, resolvedCwd, "claude");
		const scopedRoots = roots.filter(r => r.scope === "project" || claudePluginsUserEnabled);
		// The `model:` dialect follows the plugin's declared manifest, not the
		// registry that supplied it (#7966, #12028). Claude-origin roots always
		// use Claude aliases, so their frontmatter `model:` is dropped.
		await appendMarketplaceAgentDirs(orderedDirs, scopedRoots, () => true);
	}

	const seen = new Set<string>();
	const loadedAgents = (await Promise.all(orderedDirs.map(loadAgentsFromDir))).flat().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const bundledAgents = loadBundledAgents().filter(agent => {
		if (seen.has(agent.name)) return false;
		seen.add(agent.name);
		return true;
	});

	const projectAgentsDir = projectDirs.length > 0 ? projectDirs[0].path : null;

	return { agents: [...loadedAgents, ...bundledAgents], projectAgentsDir };
}

/**
 * Get an agent by name from discovered agents.
 */
export function getAgent(agents: AgentDefinition[], name: string): AgentDefinition | undefined {
	return agents.find(a => a.name === name);
}
