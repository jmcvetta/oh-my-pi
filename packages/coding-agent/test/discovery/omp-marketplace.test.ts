/**
 * Integration coverage for the split marketplace providers:
 *
 *   - `claude-plugins` reads only the Claude Code registry
 *     (`~/.claude/plugins` + `enabledPlugins` settings).
 *   - `omp-marketplace` reads OMP's own user/project registries and
 *     `--plugin-dir` roots.
 *
 * The suites below exercise the production registrations (via the
 * `discovery` barrel import) against real plugin trees and JSON registries:
 * independent provider disablement across all six legacy surfaces, selector
 * and cache isolation, warning isolation, and capability-key collision
 * precedence.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	disableProvider,
	enableUserSource,
	initializeWithSettings,
	loadCapability,
} from "@oh-my-pi/pi-coding-agent/capability";
import { clearCache as clearFsCache } from "@oh-my-pi/pi-coding-agent/capability/fs";
import { hookCapability } from "@oh-my-pi/pi-coding-agent/capability/hook";
import { mcpCapability, type MCPServer } from "@oh-my-pi/pi-coding-agent/capability/mcp";
import { ruleCapability } from "@oh-my-pi/pi-coding-agent/capability/rule";
import { slashCommandCapability } from "@oh-my-pi/pi-coding-agent/capability/slash-command";
import { toolCapability } from "@oh-my-pi/pi-coding-agent/capability/tool";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
// Barrel import wires the production provider registrations (claude-plugins,
// omp-marketplace, agent-plugins, …) before any capability load.
import "@oh-my-pi/pi-coding-agent/discovery";
import { resetCapabilityForTests } from "@oh-my-pi/pi-coding-agent/discovery";
import {
	clearClaudePluginRootsCache,
	injectPluginDirRoots,
	listClaudePluginRoots,
} from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { loadSkills } from "@oh-my-pi/pi-coding-agent/extensibility/skills";
import { discoverAgents } from "@oh-my-pi/pi-coding-agent/task/discovery";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "../helpers/settings-test-state";

// ── Fixture helpers ──────────────────────────────────────────────────────────

const CLAUDE_PLUGIN_ID = "claude-probe@claude-market";
const OMP_PLUGIN_ID = "omp-probe@omp-market";
const OMP_PROJECT_PLUGIN_ID = "omp-project@omp-market";

interface RegistryEntry {
	installPath: string;
	version: string;
	scope: "user" | "project" | "local";
	installedAt: string;
	lastUpdated: string;
	projectPath?: string;
}

function registryEntry(installPath: string, scope: "user" | "project" = "user", projectPath?: string): RegistryEntry {
	return {
		installPath,
		version: "1.0.0",
		scope,
		installedAt: "2025-01-01T00:00:00Z",
		lastUpdated: "2025-01-01T00:00:00Z",
		...(projectPath && { projectPath }),
	};
}

function writeRegistry(registryPath: string, plugins: Record<string, RegistryEntry[]>): void {
	fs.mkdirSync(path.dirname(registryPath), { recursive: true });
	fs.writeFileSync(registryPath, JSON.stringify({ version: 2, plugins }));
}

interface PluginNames {
	skill: string;
	rule: string;
	command: string;
	hook: string;
	tool: string;
	agent: string;
	/** MCP server key inside the config file. */
	server: string;
	/** Marker file name referenced through ${PLUGIN_ROOT} so the resolved arg identifies the origin. */
	argMarker: string;
}

/**
 * Write a full legacy-surface plugin tree:
 * skills/, rules/, commands/, hooks/pre/, tools/, agents/, and a
 * manifest-directed MCP config (`.omp-plugin` or `.claude-plugin`).
 */
function writePluginTree(rootDir: string, names: PluginNames, dialect: "omp" | "claude"): void {
	const skillDir = path.join(rootDir, "skills", names.skill);
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: ${names.skill}\ndescription: probe skill\n---\nbody\n`,
	);

	fs.mkdirSync(path.join(rootDir, "rules"), { recursive: true });
	fs.writeFileSync(path.join(rootDir, "rules", `${names.rule}.md`), `${names.rule} rule body\n`);

	fs.mkdirSync(path.join(rootDir, "commands"), { recursive: true });
	fs.writeFileSync(path.join(rootDir, "commands", `${names.command}.md`), `${names.command} command body\n`);

	fs.mkdirSync(path.join(rootDir, "hooks", "pre"), { recursive: true });
	fs.writeFileSync(path.join(rootDir, "hooks", "pre", `${names.hook}.sh`), `echo ${names.hook}\n`);

	fs.mkdirSync(path.join(rootDir, "tools"), { recursive: true });
	fs.writeFileSync(path.join(rootDir, "tools", `${names.tool}.ts`), `export default { name: "${names.tool}" };\n`);

	fs.mkdirSync(path.join(rootDir, "agents"), { recursive: true });
	fs.writeFileSync(
		path.join(rootDir, "agents", `${names.agent}.md`),
		`---\nname: ${names.agent}\ndescription: probe agent from ${dialect}\n---\nbody\n`,
	);

	const manifestDir = dialect === "omp" ? ".omp-plugin" : ".claude-plugin";
	const mcpFile = dialect === "omp" ? "mcp-omp.json" : "mcp-claude.json";
	// Concatenation avoids the no-template-curly-in-string lint on literal placeholder names.
	const rootVar = dialect === "omp" ? "$" + "{OMP_PLUGIN_ROOT}" : "$" + "{CLAUDE_PLUGIN_ROOT}";
	fs.mkdirSync(path.join(rootDir, manifestDir), { recursive: true });
	fs.writeFileSync(
		path.join(rootDir, manifestDir, "plugin.json"),
		JSON.stringify({ name: path.basename(rootDir), mcpServers: `./${mcpFile}` }),
	);
	fs.writeFileSync(
		path.join(rootDir, mcpFile),
		JSON.stringify({
			mcpServers: {
				[names.server]: {
					command: "./bin/server",
					args: [`${rootVar}/${names.argMarker}`],
				},
			},
		}),
	);
}

const CLAUDE_NAMES: PluginNames = {
	skill: "claude-skill",
	rule: "claude-rule",
	command: "claude-cmd",
	hook: "claude-hook",
	tool: "claude-tool",
	agent: "claude-agent",
	server: "probe",
	argMarker: "claude-cfg.json",
};

const OMP_NAMES: PluginNames = {
	skill: "omp-skill",
	rule: "omp-rule",
	command: "omp-cmd",
	hook: "omp-hook",
	tool: "omp-tool",
	agent: "omp-agent",
	server: "probe",
	argMarker: "omp-cfg.json",
};

// ── Suite ────────────────────────────────────────────────────────────────────

describe("omp-marketplace provider split", () => {
	let tempHome: string;
	let tempProject: string;
	let agentDir: string;
	let claudeRoot: string;
	let ompRoot: string;
	let ompProjectRoot: string;
	let originalHome: string | undefined;
	let originalClaudeConfigDir: string | undefined;
	let originalPiCodingAgentDir: string | undefined;
	let originalOmpProfile: string | undefined;
	let originalPiProfile: string | undefined;

	beforeEach(() => {
		originalHome = process.env.HOME;
		originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
		originalPiCodingAgentDir = process.env.PI_CODING_AGENT_DIR;
		originalOmpProfile = process.env.OMP_PROFILE;
		originalPiProfile = process.env.PI_PROFILE;
		delete process.env.CLAUDE_CONFIG_DIR;
		delete process.env.OMP_PROFILE;
		delete process.env.PI_PROFILE;

		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "omp-marketplace-home-"));
		tempProject = fs.mkdtempSync(path.join(os.tmpdir(), "omp-marketplace-project-"));
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-marketplace-agent-"));
		fs.mkdirSync(path.join(tempProject, ".git"), { recursive: true });

		claudeRoot = path.join(tempHome, "claude-cache", "claude-probe");
		ompRoot = path.join(tempHome, "omp-cache", "omp-probe");
		ompProjectRoot = path.join(tempProject, "omp-project-cache");
		writePluginTree(claudeRoot, CLAUDE_NAMES, "claude");
		writePluginTree(ompRoot, OMP_NAMES, "omp");

		// Claude user registry
		writeRegistry(path.join(tempHome, ".claude", "plugins", "installed_plugins.json"), {
			[CLAUDE_PLUGIN_ID]: [registryEntry(claudeRoot)],
		});
		// OMP user registry
		writeRegistry(path.join(tempHome, ".omp", "plugins", "installed_plugins.json"), {
			[OMP_PLUGIN_ID]: [registryEntry(ompRoot)],
		});
		// OMP project registry
		writeRegistry(path.join(tempProject, ".omp", "plugins", "installed_plugins.json"), {
			[OMP_PROJECT_PLUGIN_ID]: [registryEntry(ompProjectRoot)],
		});
		fs.mkdirSync(ompProjectRoot, { recursive: true });
		fs.mkdirSync(path.join(ompProjectRoot, "skills", "omp-project-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(ompProjectRoot, "skills", "omp-project-skill", "SKILL.md"),
			"---\nname: omp-project-skill\ndescription: probe project skill\n---\nbody\n",
		);
		fs.mkdirSync(path.join(ompProjectRoot, "agents"), { recursive: true });
		fs.writeFileSync(
			path.join(ompProjectRoot, "agents", "omp-project-agent.md"),
			"---\nname: omp-project-agent\ndescription: probe project agent\n---\nbody\n",
		);

		process.env.HOME = tempHome;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);
		clearFsCache();
		clearClaudePluginRootsCache();
		resetCapabilityForTests();
	});

	afterEach(async () => {
		clearFsCache();
		clearClaudePluginRootsCache();
		await injectPluginDirRoots(tempHome, []);
		vi.restoreAllMocks();
		resetCapabilityForTests();
		restoreEnvValue("HOME", originalHome);
		restoreEnvValue("CLAUDE_CONFIG_DIR", originalClaudeConfigDir);
		restoreEnvValue("PI_CODING_AGENT_DIR", originalPiCodingAgentDir);
		restoreEnvValue("OMP_PROFILE", originalOmpProfile);
		restoreEnvValue("PI_PROFILE", originalPiProfile);
		await removeSyncWithRetries(tempHome);
		await removeSyncWithRetries(tempProject);
		await removeSyncWithRetries(agentDir);
	});

	async function loadLegacySurfaces(): Promise<{
		skills: string[];
		rules: string[];
		commands: string[];
		hooks: string[];
		tools: string[];
		mcps: MCPServer[];
	}> {
		const [skills, rules, commands, hooks, tools, mcps] = await Promise.all([
			loadSkills({ cwd: tempProject }),
			loadCapability<{ name: string }>(ruleCapability.id, { cwd: tempProject }),
			loadCapability<{ name: string }>(slashCommandCapability.id, { cwd: tempProject }),
			loadCapability<{ name: string; path: string }>(hookCapability.id, { cwd: tempProject }),
			loadCapability<{ name: string }>(toolCapability.id, { cwd: tempProject }),
			loadCapability<MCPServer>(mcpCapability.id, { cwd: tempProject }),
		]);
		return {
			skills: skills.skills.map(s => s.name),
			rules: rules.items.map(r => r.name),
			commands: commands.items.map(c => c.name),
			hooks: hooks.items.map(h => h.path),
			tools: tools.items.map(t => t.name),
			mcps: mcps.items,
		};
	}

	test("keeps OMP marketplace surfaces when Claude provider is disabled", async () => {
		// Opt-in present; the hard disable must still win for claude-plugins.
		initializeWithSettings(Settings.isolated({ disabledProviders: ["claude-plugins"] }));
		enableUserSource("claude-plugins");

		const surfaces = await loadLegacySurfaces();
		// OMP user + project items survive with their resolved paths and content.
		expect(surfaces.skills).toContain("omp-skill");
		expect(surfaces.skills).toContain("omp-project-skill");
		expect(surfaces.skills).not.toContain("claude-skill");
		expect(surfaces.rules).toContain("omp-rule");
		expect(surfaces.rules).not.toContain("claude-rule");
		expect(surfaces.commands).toContain("omp-probe:omp-cmd");
		expect(surfaces.commands).not.toContain("claude-probe:claude-cmd");
		expect(surfaces.hooks.some(h => h.startsWith(ompRoot))).toBe(true);
		expect(surfaces.hooks.some(h => h.startsWith(claudeRoot))).toBe(false);
		expect(surfaces.tools).toContain("omp-tool");
		expect(surfaces.tools).not.toContain("claude-tool");

		const ompServer = surfaces.mcps.find(s => s.name === "omp-probe:probe");
		expect(ompServer).toBeDefined();
		// Manifest-directed config: absolute command and ${OMP_PLUGIN_ROOT}-expanded args.
		expect(ompServer?.command).toBe(path.join(ompRoot, "bin", "server"));
		expect(ompServer?.args).toEqual([path.join(ompRoot, "omp-cfg.json")]);
		expect(surfaces.mcps.find(s => s.name === "claude-probe:probe")).toBeUndefined();

		// Agent lanes: OMP user/project agents survive, Claude agents do not.
		const { agents } = await discoverAgents(tempProject, tempHome);
		const names = agents.map(a => a.name);
		expect(names).toContain("omp-agent");
		expect(names).toContain("omp-project-agent");
		expect(names).not.toContain("claude-agent");
	});

	test("keeps Claude marketplace surfaces when OMP provider is disabled", async () => {
		initializeWithSettings(Settings.isolated({ disabledProviders: ["omp-marketplace"] }));
		enableUserSource("claude-plugins");

		const surfaces = await loadLegacySurfaces();
		expect(surfaces.skills).toContain("claude-skill");
		expect(surfaces.skills).not.toContain("omp-skill");
		expect(surfaces.skills).not.toContain("omp-project-skill");
		expect(surfaces.rules).toContain("claude-rule");
		expect(surfaces.rules).not.toContain("omp-rule");
		expect(surfaces.commands).toContain("claude-probe:claude-cmd");
		expect(surfaces.commands).not.toContain("omp-probe:omp-cmd");
		expect(surfaces.hooks.some(h => h.startsWith(claudeRoot))).toBe(true);
		expect(surfaces.hooks.some(h => h.startsWith(ompRoot))).toBe(false);
		expect(surfaces.tools).toContain("claude-tool");
		expect(surfaces.tools).not.toContain("omp-tool");
		const claudeServer = surfaces.mcps.find(s => s.name === "claude-probe:probe");
		expect(claudeServer?.command).toBe(path.join(claudeRoot, "bin", "server"));
		expect(claudeServer?.args).toEqual([path.join(claudeRoot, "claude-cfg.json")]);
		expect(surfaces.mcps.find(s => s.name === "omp-probe:probe")).toBeUndefined();

		const { agents } = await discoverAgents(tempProject, tempHome);
		const names = agents.map(a => a.name);
		expect(names).toContain("claude-agent");
		expect(names).not.toContain("omp-agent");
		expect(names).not.toContain("omp-project-agent");
	});

	test("disabling both legacy providers removes both lanes", async () => {
		initializeWithSettings(Settings.isolated({ disabledProviders: ["claude-plugins", "omp-marketplace"] }));
		enableUserSource("claude-plugins");

		const surfaces = await loadLegacySurfaces();
		expect(surfaces.skills).not.toContain("claude-skill");
		expect(surfaces.skills).not.toContain("omp-skill");
		expect(surfaces.skills).not.toContain("omp-project-skill");
		expect(surfaces.commands).not.toContain("claude-probe:claude-cmd");
		expect(surfaces.commands).not.toContain("omp-probe:omp-cmd");
		expect(surfaces.hooks.some(h => h.startsWith(claudeRoot) || h.startsWith(ompRoot))).toBe(false);
		expect(surfaces.tools).not.toContain("claude-tool");
		expect(surfaces.tools).not.toContain("omp-tool");
		expect(surfaces.mcps.find(s => s.name.endsWith(":probe"))).toBeUndefined();

		const { agents } = await discoverAgents(tempProject, tempHome);
		const names = agents.map(a => a.name);
		expect(names).not.toContain("claude-agent");
		expect(names).not.toContain("omp-agent");
		expect(names).not.toContain("omp-project-agent");
	});

	test("injected --plugin-dir roots ride the OMP lane without foreign opt-in", async () => {
		initializeWithSettings(Settings.isolated({ disabledProviders: ["claude-plugins"] }));
		const injectedDir = path.join(tempHome, "injected-plugin");
		writePluginTree(injectedDir, { ...OMP_NAMES, skill: "injected-skill", agent: "injected-agent" }, "omp");
		await injectPluginDirRoots(tempHome, [injectedDir], tempProject);

		const surfaces = await loadLegacySurfaces();
		expect(surfaces.skills).toContain("injected-skill");
		const { agents } = await discoverAgents(tempProject, tempHome);
		expect(agents.map(a => a.name)).toContain("injected-agent");
	});

	test("selector modes stay isolated and cache invalidation reaches every variant", async () => {
		// No provider gating here: raw selector behavior on the same fixtures.
		const all = await listClaudePluginRoots(tempHome, tempProject);
		const claude = await listClaudePluginRoots(tempHome, tempProject, "claude");
		const omp = await listClaudePluginRoots(tempHome, tempProject, "omp");
		const allAgain = await listClaudePluginRoots(tempHome, tempProject);

		expect(claude.roots.map(r => r.id)).toEqual([CLAUDE_PLUGIN_ID]);
		expect(claude.roots.every(r => r.origin === "claude")).toBe(true);
		expect(omp.roots.map(r => r.id).sort()).toEqual([OMP_PLUGIN_ID, OMP_PROJECT_PLUGIN_ID].sort());
		expect(omp.roots.every(r => r.origin === "omp")).toBe(true);
		// Distinct plugin IDs coexist in the combined inventory.
		expect(all.roots.map(r => r.id).sort()).toEqual([CLAUDE_PLUGIN_ID, OMP_PLUGIN_ID, OMP_PROJECT_PLUGIN_ID].sort());
		expect(allAgain.roots).toEqual(all.roots);

		// Equal plugin ID in both registries: "claude" still sees its own root
		// after a combined read; "all" stays OMP-authoritative for that ID.
		const dupeRoot = path.join(tempHome, "dupe-cache", "dupe");
		fs.mkdirSync(dupeRoot, { recursive: true });
		writeRegistry(path.join(tempHome, ".claude", "plugins", "installed_plugins.json"), {
			[CLAUDE_PLUGIN_ID]: [registryEntry(claudeRoot)],
			"dupe@shared": [registryEntry(dupeRoot)],
		});
		writeRegistry(path.join(tempHome, ".omp", "plugins", "installed_plugins.json"), {
			[OMP_PLUGIN_ID]: [registryEntry(ompRoot)],
			"dupe@shared": [registryEntry(ompRoot)],
		});
		writeRegistry(path.join(tempHome, ".omp", "plugins", "installed_plugins.json"), {
			[OMP_PLUGIN_ID]: [registryEntry(ompRoot)],
			"dupe@shared": [registryEntry(ompRoot)],
		});
		clearFsCache();
		clearClaudePluginRootsCache();
		const claudeDupe = await listClaudePluginRoots(tempHome, tempProject, "claude");
		expect(claudeDupe.roots.map(r => r.id)).toContain("dupe@shared");
		const allDupe = await listClaudePluginRoots(tempHome, tempProject);
		const dupeRoots = allDupe.roots.filter(r => r.id === "dupe@shared");
		expect(dupeRoots).toHaveLength(1);
		expect(dupeRoots[0]?.origin).toBe("omp");

		// Registry content change is invisible until both caches clear, then
		// every selector variant sees the update.
		writeRegistry(path.join(tempHome, ".omp", "plugins", "installed_plugins.json"), {
			[OMP_PLUGIN_ID]: [registryEntry(ompRoot)],
			"dupe@shared": [registryEntry(ompRoot)],
			"added@omp-market": [registryEntry(ompRoot)],
		});
		const staleClaude = await listClaudePluginRoots(tempHome, tempProject, "claude");
		expect(staleClaude.roots.map(r => r.id)).toEqual([CLAUDE_PLUGIN_ID, "dupe@shared"]);
		clearFsCache();
		clearClaudePluginRootsCache();
		const freshClaude = await listClaudePluginRoots(tempHome, tempProject, "claude");
		expect(freshClaude.roots.map(r => r.id)).toEqual([CLAUDE_PLUGIN_ID, "dupe@shared"]);
		const freshOmp = await listClaudePluginRoots(tempHome, tempProject, "omp");
		expect(freshOmp.roots.map(r => r.id).sort()).toEqual(
			[OMP_PLUGIN_ID, "dupe@shared", "added@omp-market", OMP_PROJECT_PLUGIN_ID].sort(),
		);
	});

	test("a malformed registry only warns through its own provider", async () => {
		// Malformed Claude registry + valid OMP data: a direct omp-marketplace
		// capability load must not surface the Claude parse warning.
		fs.writeFileSync(path.join(tempHome, ".claude", "plugins", "installed_plugins.json"), "{ not json");
		initializeWithSettings(Settings.isolated({}));

		const ompOnly = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempProject,
			providers: ["omp-marketplace"],
		});
		expect(ompOnly.items.map(s => s.name)).toContain("omp-probe:probe");
		expect(ompOnly.warnings.some(w => w.includes("Claude Code plugin registry"))).toBe(false);

		// Inverse: malformed OMP user registry + valid Claude data; a direct
		// claude-plugins load must not surface the OMP warning.
		writeRegistry(path.join(tempHome, ".claude", "plugins", "installed_plugins.json"), {
			[CLAUDE_PLUGIN_ID]: [registryEntry(claudeRoot)],
		});
		fs.writeFileSync(path.join(tempHome, ".omp", "plugins", "installed_plugins.json"), "{ not omp json");
		clearFsCache();
		clearClaudePluginRootsCache();
		enableUserSource("claude-plugins");

		const claudeOnly = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempProject,
			providers: ["claude-plugins"],
		});
		expect(claudeOnly.warnings.some(w => w.includes("OMP plugin registry"))).toBe(false);

		// Malformed OMP project registry warns through the omp lane and names the
		// project registry; valid user entries still load.
		writeRegistry(path.join(tempHome, ".omp", "plugins", "installed_plugins.json"), {
			[OMP_PLUGIN_ID]: [registryEntry(ompRoot)],
		});
		fs.writeFileSync(path.join(tempProject, ".omp", "plugins", "installed_plugins.json"), "{ broken project");
		clearFsCache();
		clearClaudePluginRootsCache();
		const ompLoad = await loadCapability<MCPServer>(mcpCapability.id, {
			cwd: tempProject,
			providers: ["omp-marketplace"],
		});
		expect(
			ompLoad.warnings.some(
				w => w.includes("project plugin registry") && w.includes(path.join(tempProject, ".omp", "plugins")),
			),
		).toBe(true);
		expect(ompLoad.items.map(s => s.name)).toContain("omp-probe:probe");
	});

	test("equal capability keys resolve to OMP at priority 71; disabling OMP exposes Claude", async () => {
		// Same plugin name "dupe" in both registries; MCP server "dupe:probe"
		// collides on the capability key while arg markers differ.
		const dupeClaudeRoot = path.join(tempHome, "dupe-cache", "dupe");
		const dupeOmpRoot = path.join(tempHome, "dupe-omp-cache", "dupe");
		writePluginTree(dupeClaudeRoot, { ...CLAUDE_NAMES, agent: "dupe-agent" }, "claude");
		writePluginTree(dupeOmpRoot, { ...OMP_NAMES, agent: "dupe-agent" }, "omp");
		// Claude-only non-colliding capability must survive both providers enabled.
		const extraClaudeRoot = path.join(tempHome, "extra-cache", "claude-extra");
		fs.mkdirSync(path.join(extraClaudeRoot, "skills", "claude-extra-skill"), { recursive: true });
		fs.writeFileSync(
			path.join(extraClaudeRoot, "skills", "claude-extra-skill", "SKILL.md"),
			"---\nname: claude-extra-skill\ndescription: extra\n---\nbody\n",
		);
		writeRegistry(path.join(tempHome, ".claude", "plugins", "installed_plugins.json"), {
			"dupe@shared": [registryEntry(dupeClaudeRoot)],
			"claude-extra@claude-market": [registryEntry(extraClaudeRoot)],
		});
		writeRegistry(path.join(tempHome, ".omp", "plugins", "installed_plugins.json"), {
			"dupe@shared": [registryEntry(dupeOmpRoot)],
		});
		initializeWithSettings(Settings.isolated({}));
		enableUserSource("claude-plugins");

		const both = await loadCapability<MCPServer>(mcpCapability.id, { cwd: tempProject });
		const winner = both.items.find(s => s.name === "dupe:probe");
		expect(winner?.args).toEqual([path.join(dupeOmpRoot, "omp-cfg.json")]);

		// Equal agent names: the OMP body wins.
		const { agents } = await discoverAgents(tempProject, tempHome);
		const dupeAgent = agents.find(a => a.name === "dupe-agent");
		expect(dupeAgent?.description).toBe("probe agent from omp");

		const skillsBoth = await loadSkills({ cwd: tempProject });
		expect(skillsBoth.skills.map(s => s.name)).toContain("claude-extra-skill");

		// Without manual cache clearing, disabling the OMP provider re-exposes
		// the Claude server.
		disableProvider("omp-marketplace");
		const claudeOnly = await loadCapability<MCPServer>(mcpCapability.id, { cwd: tempProject });
		const exposed = claudeOnly.items.find(s => s.name === "dupe:probe");
		expect(exposed?.args).toEqual([path.join(dupeClaudeRoot, "claude-cfg.json")]);
	});
});
