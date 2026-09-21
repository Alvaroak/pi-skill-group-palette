/**
 * skill-group-palette
 *
 * Owns skill discovery for the skills shelf (~/skills-shelf), grouped by the
 * top-level folder (databricks/, alvaroak/, ...). Pi does NOT autodiscover the
 * shelf: there is no ~/.pi/agent/skills symlink into it. Instead this extension
 * decides, in `resources_discover`, which group directories pi loads — only the
 * enabled ones. Disabling a group means pi never discovers those skills at all:
 * no system-prompt block, no `/skill:name` command. That is the whole point.
 *
 * Toggling a group calls ctx.reload() so the change takes effect immediately
 * (discovery is decided at scan time, so a reload is required to re-scan).
 *
 * /skillgroups              - open the palette overlay
 * /skillgroups list          - print group status
 * /skillgroups <name> on     - enable a group (re-scan, load its skills)
 * /skillgroups <name> off    - disable a group (re-scan, drop its skills)
 *
 * In the overlay:
 *   Tab / ←→   cycle to the next/previous group (resets skill search)
 *   Enter      on the group tab bar: toggle that group on/off (persists for the
 *              session; each new session resets groups to alvaroak + misc on,
 *              while per-skill toggles persist across sessions)
 *   type / ↑↓  drop into that group's skill list: fuzzy-filter, navigate
 *   Enter      inside the skill list: queue/unqueue the highlighted skill
 *              for the next message
 *   ctrl+t     inside the skill list: enable/disable the highlighted skill
 *              (disabled skills get no prompt block, no /skill:name command,
 *              no token cost — same semantics as a disabled group; inside a
 *              disabled group the toggle opts individual skills back in)
 *   Esc        close (or back out of the skill list to the tab bar)
 *
 * Always-on skills: a skill whose SKILL.md frontmatter declares `always-on: true`
 * is rendered in the palette's success color with a ↻ marker, so you can tell at
 * a glance which skills are always active (e.g. unslop, mandated by AGENTS.md)
 * versus skills the model pulls in only when a task matches.
 */

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

interface SkillInfo {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	group: string;
	alwaysOn: boolean;
	searchName: string;
	searchDescription: string;
}

const STATE_FILE = path.join(os.homedir(), ".pi", "agent", "skill-group-palette-state.json");
// The skills shelf this extension owns discovery for. Pi is intentionally NOT
// pointed at this directory (no ~/.pi/agent/skills symlink), so nothing here is
// autodiscovered; `resources_discover` below hands pi only the enabled groups.
// Override with SKILLS_SHELF if the shelf lives elsewhere.
const SHELF_ROOT = process.env.SKILLS_SHELF || path.join(os.homedir(), "skills-shelf");
const MAX_QUEUED_SKILLS = 3;
const LARGE_QUEUE_WARN_CHARS = 30_000;
const UNGROUPED = "(ungrouped)";
// Groups enabled by default: every new session starts with only these on and
// everything else on the shelf off, so newly added groups start disabled until
// explicitly enabled. /reload does NOT reset, so toggles made mid-session
// survive a hot reload.
//
// Configured via ~/.pi/agent/pi-skill-groups.json ("defaultEnabled": [...],
// "pinned": [...]). Unconfigured: every discovered group starts enabled.
function loadGroupConfig(): { defaultEnabled: string[]; pinned: string[] } {
	try {
		const raw = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi/agent/pi-skill-groups.json"), "utf-8")) as {
			defaultEnabled?: string[];
			pinned?: string[];
		};
		return {
			defaultEnabled: Array.isArray(raw.defaultEnabled) ? raw.defaultEnabled : [],
			pinned: Array.isArray(raw.pinned) ? raw.pinned : [],
		};
	} catch {
		return { defaultEnabled: [], pinned: [] };
	}
}

let GROUP_CONFIG: { defaultEnabled: string[]; pinned: string[] } | null = null;
function groupConfig() {
	if (!GROUP_CONFIG) GROUP_CONFIG = loadGroupConfig();
	return GROUP_CONFIG;
}

function defaultEnabledGroups(): string[] {
	return groupConfig().defaultEnabled;
}

/** Groups that should be off at session start: everything but the defaults. */
function defaultDisabledGroups(): Set<string> {
	const off = new Set<string>();
	for (const dir of listGroupDirs()) {
		const name = path.basename(dir);
		if (!defaultEnabledGroups().includes(name)) off.add(name);
	}
	return off;
}
// Tab-bar order: pinned groups first (in this order), everything else alphabetical.
function pinnedGroupOrder(): string[] {
	return groupConfig().pinned;
}

// ═══════════════════════════════════════════════════════════════════════════
// Persisted state: which groups and skills are disabled
// ═══════════════════════════════════════════════════════════════════════════

interface PersistedState {
	disabledGroups: string[];
	disabledSkills: string[];
	enabledSkills: string[];
}

function loadState(): { disabledGroups: Set<string>; disabledSkills: Set<string>; enabledSkills: Set<string> } {
	try {
		const raw = fs.readFileSync(STATE_FILE, "utf-8");
		const parsed = JSON.parse(raw) as Partial<PersistedState>;
		return {
			disabledGroups: new Set(Array.isArray(parsed.disabledGroups) ? parsed.disabledGroups : []),
			disabledSkills: new Set(Array.isArray(parsed.disabledSkills) ? parsed.disabledSkills : []),
			enabledSkills: new Set(Array.isArray(parsed.enabledSkills) ? parsed.enabledSkills : []),
		};
	} catch {
		// No state file yet: seed with defaults and persist so this only happens once.
		const disabledGroups = defaultDisabledGroups();
		saveState(disabledGroups, new Set(), new Set());
		return { disabledGroups, disabledSkills: new Set(), enabledSkills: new Set() };
	}
}

/**
 * Reset groups to the defaults at session start: everything but alvaroak +
 * misc off. Skill-level opt-ins and opt-outs are deliberately kept —
 * individually activated skills persist across sessions.
 */
function resetGroupsToDefaults(): void {
	disabledGroups.clear();
	for (const name of defaultDisabledGroups()) disabledGroups.add(name);
	saveState(disabledGroups, disabledSkills, enabledSkills);
}

function saveState(groups: Set<string>, skills: Set<string>, optIns: Set<string>): void {
	fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
	fs.writeFileSync(
		STATE_FILE,
		JSON.stringify(
			{ disabledGroups: [...groups].sort(), disabledSkills: [...skills].sort(), enabledSkills: [...optIns].sort() },
			null,
			2,
		),
	);
}

// Module-level, loaded once and mutated in place so every part of the
// extension (overlay, system-prompt filter, footer) shares one source of truth.
const { disabledGroups, disabledSkills, enabledSkills } = loadState();
const queuedSkills: Set<string> = new Set();
let lastLoadedSkills: SkillInfo[] = [];

function toggleGroup(name: string): boolean {
	const nowDisabled = !disabledGroups.has(name);
	if (nowDisabled) {
		disabledGroups.add(name);
	} else {
		disabledGroups.delete(name);
	}
	saveState(disabledGroups, disabledSkills, enabledSkills);
	return nowDisabled;
}

/**
 * Toggle one skill's enable state. Only shelf skills can be toggled: pi
 * discovers non-shelf skills (project skills etc.) itself, so for those we
 * can only strip the prompt block (stripDisabledSkills), not discovery.
 * Returns null when the skill is not on the shelf.
 */
function toggleSkill(skill: SkillInfo): boolean | null {
	if (!skill.baseDir.startsWith(SHELF_ROOT)) return null;
	// Inside an enabled group the toggle drives the opt-out set
	// (disabledSkills); inside a disabled group, the opt-in set (enabledSkills).
	// Writing to the set that matches the group state keeps toggles meaningful
	// across group on/off cycles: a skill opted out stays off after the group
	// cycles off and back on, and vice versa.
	const turningOff = disabledGroups.has(skill.group)
		? enabledSkills.has(skill.name)
		: !disabledSkills.has(skill.name);
	if (turningOff) {
		if (disabledGroups.has(skill.group)) enabledSkills.delete(skill.name);
		else disabledSkills.add(skill.name);
	} else {
		if (disabledGroups.has(skill.group)) enabledSkills.add(skill.name);
		else disabledSkills.delete(skill.name);
	}
	saveState(disabledGroups, disabledSkills, enabledSkills);
	return turningOff;
}

// ═══════════════════════════════════════════════════════════════════════════
// Skill / group discovery (mirrors pi's own loaded-skill list, grouped by
// the immediate parent folder of each skill's directory)
// ═══════════════════════════════════════════════════════════════════════════

let loadedSkillsSource: ReturnType<ExtensionCommandContext["getSystemPromptOptions"]>["skills"];
let loadedSkillsCache: SkillInfo[] = [];

function deriveGroup(baseDir: string): string {
	const parent = path.dirname(baseDir);
	const parentName = path.basename(parent);
	// A skill directly under a "skills" root (no grouping folder) is ungrouped.
	return parentName === "skills" ? UNGROUPED : parentName;
}

function toSkillInfo(
	skill: { name: string; description: string; filePath: string; baseDir: string },
	alwaysOn = false,
): SkillInfo {
	return {
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		group: deriveGroup(skill.baseDir),
		alwaysOn,
		searchName: skill.name.toLowerCase(),
		searchDescription: skill.description.toLowerCase(),
	};
}

function getLoadedSkills(ctx: ExtensionCommandContext): SkillInfo[] {
	const source = ctx.getSystemPromptOptions().skills;
	if (source === loadedSkillsSource) return loadedSkillsCache;

	loadedSkillsSource = source;
	loadedSkillsCache = (source ?? []).map((skill) => toSkillInfo(skill, isAlwaysOn(skill.filePath)));
	lastLoadedSkills = loadedSkillsCache;
	return loadedSkillsCache;
}

// Always-on detection for skills pi loaded from outside the shelf (project
// skills etc.): read the frontmatter straight from the loaded SKILL.md.
const alwaysOnCache = new Map<string, boolean>();

function isAlwaysOn(filePath: string): boolean {
	const cached = alwaysOnCache.get(filePath);
	if (cached !== undefined) return cached;
	let value = false;
	try {
		value = readFrontmatterField(fs.readFileSync(filePath, "utf-8"), "always-on").toLowerCase() === "true";
	} catch {
		// Unreadable file: not always-on.
	}
	alwaysOnCache.set(filePath, value);
	return value;
}

// ── Shelf discovery (owned by this extension) ──────────────────────────────
// Pi does not scan SHELF_ROOT, so we do it ourselves to (a) tell pi which
// group dirs to load and (b) show disabled groups in the palette so they can
// be re-enabled. We read only the frontmatter of each SKILL.md, cheaply.

function readFrontmatterField(raw: string, field: string): string {
	if (!raw.startsWith("---")) return "";
	const end = raw.indexOf("\n---", 3);
	const front = end === -1 ? raw : raw.slice(0, end);
	const match = front.match(new RegExp(`^${field}:\\s*(.+)$`, "m"));
	return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

/** Directories of groups present on the shelf (top-level folders holding skills). */
function listGroupDirs(): string[] {
	try {
		return fs
			.readdirSync(SHELF_ROOT, { withFileTypes: true })
			.map((e) => ({
				name: e.name,
				// Follow symlinked group dirs too (e.g. a group folder symlinked
				// into the shelf from a git repo); Dirents report symlinks as
				// non-directories, so stat the target.
				isDir: e.isDirectory() || (e.isSymbolicLink() && fs.statSync(path.join(SHELF_ROOT, e.name)).isDirectory()),
			}))
			.filter((e) => e.isDir && !e.name.startsWith("."))
			.map((e) => path.join(SHELF_ROOT, e.name))
			.sort();
	} catch {
		return [];
	}
}

/**
 * Paths pi should actually discover. A group with no per-skill state is handed
 * over whole; otherwise it is expanded into only its enabled skill directories
 * (pi's dir scan loads exactly one skill per directory containing a SKILL.md).
 * Never mixes both — a group dir plus its skill dirs would load skills twice.
 * A skill is enabled when: group on and not opted out (disabledSkills), or
 * group off and explicitly opted in (enabledSkills).
 */
function enabledGroupPaths(): string[] {
	const paths: string[] = [];
	for (const dir of listGroupDirs()) {
		const groupOff = disabledGroups.has(path.basename(dir));
		const skillDirs = listSkillDirs(dir);
		const enabledDirs = skillDirs
			.filter((s) => (groupOff ? enabledSkills.has(s.name) : !disabledSkills.has(s.name)))
			.map((s) => s.baseDir);
		if (!groupOff && enabledDirs.length === skillDirs.length) {
			paths.push(dir);
		} else {
			paths.push(...enabledDirs);
		}
	}
	return paths;
}

/** Skill dirs directly under a group dir, with their frontmatter names. */
function listSkillDirs(groupDir: string): Array<{ name: string; baseDir: string }> {
	const out: Array<{ name: string; baseDir: string }> = [];
	// A loose SKILL.md at group level loads as one skill covering the whole
	// group dir — no per-skill control there; empty list keeps the group path.
	if (fs.existsSync(path.join(groupDir, "SKILL.md"))) return out;
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(groupDir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		// Same symlink handling as scanShelfSkills.
		const baseDir = path.join(groupDir, entry.name);
		let isDir = entry.isDirectory();
		if (!isDir && entry.isSymbolicLink()) {
			try {
				isDir = fs.statSync(baseDir).isDirectory();
			} catch {
				continue;
			}
		}
		if (!isDir) continue;
		const filePath = path.join(baseDir, "SKILL.md");
		let raw: string;
		try {
			raw = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const name = readFrontmatterField(raw, "name") || entry.name;
		if (!readFrontmatterField(raw, "description")) continue;
		out.push({ name, baseDir });
	}
	return out;
}

/** Scan every skill on the shelf (enabled or not), reading only frontmatter. */
function scanShelfSkills(): SkillInfo[] {
	const skills: SkillInfo[] = [];
	for (const groupDir of listGroupDirs()) {
		let entries: fs.Dirent[];
		try {
			entries = fs.readdirSync(groupDir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			// Follow symlinked skill directories too (e.g. a repo whose skill
			// folder is symlinked into the shelf); readdirSync Dirents report
			// symlinks as non-directories, so stat the target.
			const baseDir = path.join(groupDir, entry.name);
			let isDir = entry.isDirectory();
			if (!isDir && entry.isSymbolicLink()) {
				try {
					isDir = fs.statSync(baseDir).isDirectory();
				} catch {
					continue;
				}
			}
			if (!isDir) continue;
			const filePath = path.join(baseDir, "SKILL.md");
			let raw: string;
			try {
				raw = fs.readFileSync(filePath, "utf-8");
			} catch {
				continue;
			}
			const name = readFrontmatterField(raw, "name") || entry.name;
			const description = readFrontmatterField(raw, "description");
			if (!description) continue; // pi ignores skills without a description; match that.
			const alwaysOn = readFrontmatterField(raw, "always-on").toLowerCase() === "true";
			skills.push(toSkillInfo({ name, description, filePath, baseDir }, alwaysOn));
		}
	}
	return skills;
}

/**
 * Skills for the palette/command: the full shelf scan (so disabled groups still
 * appear and can be re-enabled), overlaid with pi's live-loaded skills for
 * anything outside the shelf (project skills, --skill paths, other roots).
 */
function getAllSkills(ctx: ExtensionCommandContext): SkillInfo[] {
	const byName = new Map<string, SkillInfo>();
	for (const skill of scanShelfSkills()) byName.set(skill.name, skill);
	for (const skill of getLoadedSkills(ctx)) {
		if (!skill.baseDir.startsWith(SHELF_ROOT)) byName.set(skill.name, skill);
	}
	const all = [...byName.values()];
	lastLoadedSkills = all;
	return all;
}

function groupSkills(skills: SkillInfo[]): Map<string, SkillInfo[]> {
	const groups = new Map<string, SkillInfo[]>();
	for (const skill of skills) {
		const list = groups.get(skill.group) ?? [];
		list.push(skill);
		groups.set(skill.group, list);
	}
	for (const list of groups.values()) {
		// Enabled skills first, disabled after; alphabetical within each tier.
		// Same enabled-rule as discovery: group on minus opt-outs, or group off
		// plus explicit opt-ins.
		const rank = (skill: SkillInfo) =>
			disabledGroups.has(skill.group) ? (enabledSkills.has(skill.name) ? 0 : 1) : disabledSkills.has(skill.name) ? 1 : 0;
		list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
	}
	const rank = (name: string) => {
		const order = pinnedGroupOrder();
		const index = order.indexOf(name);
		return index === -1 ? order.length : index;
	};
	const sorted = [...groups.entries()].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
	// The fallback bucket reads best at the end of the tab bar.
	const ungroupedIndex = sorted.findIndex(([name]) => name === UNGROUPED);
	if (ungroupedIndex !== -1) sorted.push(...sorted.splice(ungroupedIndex, 1));
	return new Map(sorted);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip <skill> blocks for disabled groups and individually-disabled skills
 * from a system prompt. Discovery already keeps disabled shelf skills out;
 * this is belt-and-braces for shelf skills slipping in via another root, and
 * the only lever for non-shelf skills, whose discovery we don't own.
 */
function stripDisabledSkills(systemPrompt: string, skills: SkillInfo[]): string {
	if (disabledGroups.size === 0 && disabledSkills.size === 0) return systemPrompt;

	let result = systemPrompt;
	for (const skill of skills) {
		const discovered = disabledGroups.has(skill.group)
			? enabledSkills.has(skill.name)
			: !disabledSkills.has(skill.name);
		if (discovered) continue;
		const pattern = new RegExp(`<skill>\\s*<name>${escapeRegExp(skill.name)}</name>[\\s\\S]*?</skill>\\s*`, "m");
		result = result.replace(pattern, "");
	}
	return result;
}

function getSkillContent(skill: SkillInfo): string {
	const raw = fs.readFileSync(skill.filePath, "utf-8");
	if (!raw.startsWith("---")) return raw;
	const endIndex = raw.indexOf("\n---", 3);
	if (endIndex === -1) return raw;
	return raw.slice(endIndex + 4).trim();
}

function escapeAttribute(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildSkillContext(skills: SkillInfo[]): string {
	const blocks = skills.map((skill) => {
		const content = getSkillContent(skill);
		return `<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.filePath)}">\n${content}\n</skill>`;
	});
	if (blocks.length === 1) return blocks[0];
	return `<skills count="${blocks.length}">\n${blocks.join("\n\n")}\n</skills>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Token estimation (approximate, per-provider)
//
// pi bundles no LLM tokenizer, so counts are estimates: characters divided by
// a per-provider chars-per-token divisor. Good enough for sizing decisions
// (hence the "≈" everywhere); the divisor refreshes whenever the model changes.
// ═══════════════════════════════════════════════════════════════════════════

interface TokenEstimate {
	/** Tokens the <skill> metadata block adds to the system prompt (none when the group is disabled). */
	prompt: number;
	/** Tokens the full SKILL.md body block adds when queued for the next message. */
	full: number;
}

const CHAR_PER_TOKEN_DIVISORS: Record<string, number> = {
	anthropic: 3.6,
	openai: 4.0,
	"azure-openai": 4.0,
	"openai-codex": 4.0,
	google: 3.8,
	"google-vertex": 3.8,
};
const DEFAULT_DIVISOR = 4.0;

let currentDivisor = DEFAULT_DIVISOR;
const bodyCache = new Map<string, string>();
const tokenCache = new Map<string, { divisor: number; estimate: TokenEstimate }>();

function divisorFor(provider: string | undefined): number {
	if (!provider) return DEFAULT_DIVISOR;
	return CHAR_PER_TOKEN_DIVISORS[provider.toLowerCase()] ?? DEFAULT_DIVISOR;
}

function refreshDivisor(model: { provider?: string } | undefined): void {
	currentDivisor = divisorFor(model?.provider);
}

function estimateTokens(text: string, divisor: number = currentDivisor): number {
	return Math.round(text.length / divisor);
}

function fmtTokens(tokens: number): string {
	if (tokens < 1000) return String(tokens);
	if (tokens < 10_000) return `${(tokens / 1000).toFixed(1)}k`;
	return `${Math.round(tokens / 1000)}k`;
}

/** Mirror of pi's formatSkillsForPrompt entry for one skill (system-prompt listing cost). */
function skillListingBlock(skill: SkillInfo): string {
	return [
		"  <skill>",
		`    <name>${escapeAttribute(skill.name)}</name>`,
		`    <description>${escapeAttribute(skill.description)}</description>`,
		`    <location>${escapeAttribute(skill.filePath)}</location>`,
		"  </skill>",
	].join("\n");
}

function getSkillBody(skill: SkillInfo): string {
	const cached = bodyCache.get(skill.name);
	if (cached !== undefined) return cached;
	const body = getSkillContent(skill);
	bodyCache.set(skill.name, body);
	return body;
}

function getTokenEstimate(skill: SkillInfo): TokenEstimate {
	const cached = tokenCache.get(skill.name);
	if (cached && cached.divisor === currentDivisor) return cached.estimate;
	const body = getSkillBody(skill);
	const estimate: TokenEstimate = {
		prompt: estimateTokens(skillListingBlock(skill)),
		full: estimateTokens(
			`<skill name="${escapeAttribute(skill.name)}" location="${escapeAttribute(skill.filePath)}">\n${body}\n</skill>`,
		),
	};
	tokenCache.set(skill.name, { divisor: currentDivisor, estimate });
	return estimate;
}

function totalTokens(skills: SkillInfo[], kind: keyof TokenEstimate): number {
	return skills.reduce((sum, skill) => sum + getTokenEstimate(skill)[kind], 0);
}

function updateIndicators(ctx: Pick<ExtensionContext, "ui">): void {
	// Disabled groups/skills are deliberately not shown here — they are visible
	// in the palette (dimmed rows, on/off badges) and /skillgroups list.
	if (queuedSkills.size === 0) {
		ctx.ui.setStatus("skill-groups", undefined);
		ctx.ui.setWidget("skill-groups", undefined);
		return;
	}

	const queuedInfos = lastLoadedSkills.filter((skill) => queuedSkills.has(skill.name));
	const queuedTokens = estimateTokens(buildSkillContext(queuedInfos));
	ctx.ui.setStatus("skill-groups", `📚 ${[...queuedSkills].join(", ")} (≈${fmtTokens(queuedTokens)})`);
	ctx.ui.setWidget("skill-groups", [
		`\x1b[2m📚 Queued (${queuedSkills.size}/${MAX_QUEUED_SKILLS}, ≈${fmtTokens(queuedTokens)}): \x1b[0m\x1b[36m${[...queuedSkills].join(", ")}\x1b[0m\x1b[2m — will be applied to next message\x1b[0m`,
	]);
}

// ═══════════════════════════════════════════════════════════════════════════
// Fuzzy search (same scoring approach as pi-skill-palette)
// ═══════════════════════════════════════════════════════════════════════════

function fuzzyScore(query: string, text: string): number {
	if (text.includes(query)) return 100 + (query.length / text.length) * 50;

	let score = 0;
	let queryIndex = 0;
	let consecutiveBonus = 0;
	for (let i = 0; i < text.length && queryIndex < query.length; i++) {
		if (text[i] === query[queryIndex]) {
			score += 10 + consecutiveBonus;
			consecutiveBonus += 5;
			queryIndex++;
		} else {
			consecutiveBonus = 0;
		}
	}
	return queryIndex === query.length ? score : 0;
}

function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return skills;

	const scored: Array<{ skill: SkillInfo; score: number }> = [];
	for (const skill of skills) {
		const score = Math.max(
			fuzzyScore(normalized, skill.searchName),
			fuzzyScore(normalized, skill.searchDescription) * 0.8,
		);
		if (score > 0) scored.push({ skill, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return scored.map((item) => item.skill);
}

// ═══════════════════════════════════════════════════════════════════════════
// Overlay component
// ═══════════════════════════════════════════════════════════════════════════

type Focus = "group" | "skill";

class SkillGroupPaletteComponent {
	private activeIndex = 0;
	private message: string | null = null;
	private groupNames: string[];

	private focus: Focus = "group";
	private query = "";
	private filtered: SkillInfo[];
	private selected = 0;

	// Theme-bound style helpers so the palette matches the rest of pi's TUI
	// (same colors/weights as every other dialog) instead of hardcoded ANSI.
	private readonly bold: (s: string) => string;
	private readonly italic: (s: string) => string;
	private readonly dim: (s: string) => string;
	private readonly accent: (s: string) => string;
	private readonly success: (s: string) => string;
	private readonly error: (s: string) => string;
	private readonly border: (s: string) => string;
	private readonly selected_: (s: string) => string;

	constructor(
		private groups: Map<string, SkillInfo[]>,
		private theme: Theme,
		private done: (result: null) => void,
	) {
		this.groupNames = [...groups.keys()];
		this.filtered = this.groups.get(this.groupNames[0]) ?? [];

		this.bold = (s) => theme.bold(s);
		this.italic = (s) => theme.italic(s);
		this.dim = (s) => theme.fg("dim", s);
		this.accent = (s) => theme.fg("accent", s);
		this.success = (s) => theme.fg("success", s);
		this.error = (s) => theme.fg("error", s);
		this.border = (s) => theme.fg("border", s);
		this.selected_ = (s) => theme.bg("selectedBg", theme.fg("text", s));
	}

	private currentGroup(): string {
		return this.groupNames[this.activeIndex];
	}

	private resetToGroupFocus(): void {
		this.focus = "group";
		this.query = "";
		this.selected = 0;
		this.filtered = this.groups.get(this.currentGroup()) ?? [];
	}

	private enterSkillFocus(): void {
		if (this.focus !== "skill") {
			this.focus = "skill";
			this.query = "";
			this.selected = 0;
			this.filtered = this.groups.get(this.currentGroup()) ?? [];
		}
	}

	private updateFilter(): void {
		this.filtered = filterSkills(this.groups.get(this.currentGroup()) ?? [], this.query);
		this.selected = 0;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape")) {
			if (this.focus === "skill") {
				this.resetToGroupFocus();
				this.message = null;
				return;
			}
			this.done(null);
			return;
		}

		if (this.groupNames.length === 0) return;

		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			this.activeIndex = (this.activeIndex + 1) % this.groupNames.length;
			this.resetToGroupFocus();
			this.message = null;
			return;
		}

		if (matchesKey(data, "left")) {
			this.activeIndex = this.activeIndex === 0 ? this.groupNames.length - 1 : this.activeIndex - 1;
			this.resetToGroupFocus();
			this.message = null;
			return;
		}

		if (matchesKey(data, "up") || matchesKey(data, "down")) {
			this.enterSkillFocus();
			if (this.filtered.length > 0) {
				const delta = matchesKey(data, "up") ? -1 : 1;
				this.selected = (this.selected + delta + this.filtered.length) % this.filtered.length;
			}
			this.message = null;
			return;
		}

		if (matchesKey(data, "return")) {
			if (this.focus === "group") {
				const name = this.currentGroup();
				const nowDisabled = toggleGroup(name);
				this.message = nowDisabled ? `Disabled "${name}"` : `Enabled "${name}"`;
				return;
			}

			const skill = this.filtered[this.selected];
			if (!skill) return;

			if (queuedSkills.has(skill.name)) {
				queuedSkills.delete(skill.name);
				this.message = `Unqueued "${skill.name}"`;
				return;
			}
			if (queuedSkills.size >= MAX_QUEUED_SKILLS) {
				this.message = `You can queue up to ${MAX_QUEUED_SKILLS} skills. Unqueue one first (enter again).`;
				return;
			}
			queuedSkills.add(skill.name);
			this.message = `Queued "${skill.name}" for the next message`;
			return;
		}

		// ctrl+t toggles the highlighted skill's enable state — only from skill
		// focus, and a ctrl-key so plain letters stay free for searching.
		if (matchesKey(data, "ctrl+t") && this.focus === "skill") {
			const skill = this.filtered[this.selected];
			if (!skill) {
				this.message = "No skill selected";
				return;
			}
			const nowDisabled = toggleSkill(skill);
			this.message =
				nowDisabled === null
					? `"${skill.name}" is not on the shelf — only shelf skills can be toggled`
					: nowDisabled
						? `Disabled "${skill.name}"`
						: `Enabled "${skill.name}"`;
			return;
		}

		// 'u' unqueues everything at once, but only from the group tab bar —
		// inside the skill list it's just a letter you might be searching for.
		if ((data === "u" || data === "U") && this.focus === "group") {
			if (queuedSkills.size > 0) {
				queuedSkills.clear();
				this.message = "Unqueued all skills";
			} else {
				this.message = "No skills queued";
			}
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (this.focus === "skill" && this.query.length > 0) {
				this.query = this.query.slice(0, -1);
				this.updateFilter();
			}
			return;
		}

		// Printable character drops into the skill list and starts filtering.
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.enterSkillFocus();
			this.query += data;
			this.updateFilter();
		}
	}

	render(width: number): string[] {
		const innerW = width - 2;
		const lines: string[] = [];
		const visLen = visibleWidth;
		const { bold, italic, dim, accent, success, error, border, selected_ } = this;

		const row = (content: string) => `${border("│")}${truncateToWidth(` ${content}`, innerW, "…", true)}${border("│")}`;
		const emptyRow = () => `${border("│")}${" ".repeat(innerW)}${border("│")}`;

		const titleText = " Skill Groups ";
		const borderLen = Math.max(0, innerW - visLen(titleText));
		const leftBorder = Math.floor(borderLen / 2);
		const rightBorder = borderLen - leftBorder;
		lines.push(border(`╭${"─".repeat(leftBorder)}`) + bold(titleText) + border(`${"─".repeat(rightBorder)}╮`));
		lines.push(emptyRow());

		if (this.groupNames.length === 0) {
			lines.push(row(dim(italic("No skill groups found"))));
			lines.push(emptyRow());
			lines.push(border(`╰${"─".repeat(innerW)}╯`));
			return lines;
		}

		// Tab bar
		const tabs = this.groupNames.map((name, i) => {
			const isActiveTab = i === this.activeIndex;
			const isDisabled = disabledGroups.has(name);
			const groupList = this.groups.get(name) ?? [];
			const hasQueued = groupList.some((skill) => queuedSkills.has(skill.name));
			// Green "off" marks a disabled group that still has opted-in skills —
			// not a full off. Red "off" means everything in the group is out.
			const hasOptIns = groupList.some((skill) => enabledSkills.has(skill.name));
			const badge = isDisabled ? (hasOptIns ? success("off") : error("off")) : success("on");
			const queuedMark = hasQueued ? ` ${accent("\u25cf")}` : "";
			const label = ` ${name}${queuedMark} (${badge}) `;
			const highlighted = isActiveTab && this.focus === "group";
			return highlighted ? selected_(bold(label)) : isActiveTab ? bold(label) : dim(label);
		});
		// Wrap tabs onto as many lines as needed so no group is cut off
		const tabLines: string[][] = [[]];
		let lineLen = 0;
		for (const tab of tabs) {
			const tabWidth = visLen(tab);
			const currentLen = lineLen + (tabLines[tabLines.length - 1].length > 0 ? 1 : 0);
			if (tabLines[tabLines.length - 1].length > 0 && currentLen + tabWidth > innerW) {
				tabLines.push([]);
				lineLen = 0;
			}
			tabLines[tabLines.length - 1].push(tab);
			lineLen += tabWidth + (tabLines[tabLines.length - 1].length > 1 ? 1 : 0);
		}
		for (const tabLine of tabLines) {
			lines.push(row(tabLine.join(" ")));
		}
		lines.push(border(`├${"─".repeat(innerW)}┤`));
		lines.push(emptyRow());

		const current = this.currentGroup();
		const isDisabled = disabledGroups.has(current);
		const groupList = this.groups.get(current) ?? [];
		const currentHasOptIns = groupList.some((skill) => enabledSkills.has(skill.name));
		// Same enabled-rule as discovery: group on minus opt-outs, or group off
		// plus explicit opt-ins.
		const visibleSkills = groupList.filter((skill) =>
			isDisabled ? enabledSkills.has(skill.name) : !disabledSkills.has(skill.name),
		);
		const listedTokens = totalTokens(visibleSkills, "prompt");
		const queuedAllTokens = totalTokens(groupList, "full");
		const costNote = isDisabled
			? dim(`  ·  ≈${fmtTokens(queuedAllTokens)} if all queued`)
			: dim(`  ·  ≈${fmtTokens(listedTokens)} in prompt · ≈${fmtTokens(queuedAllTokens)} if all queued`);
		lines.push(
			row(
				bold(
					`${current}: ${
						isDisabled ? (currentHasOptIns ? success("off, some skills on") : error("disabled")) : success("enabled")
					}`,
				) + costNote,
			),
		);
		lines.push(emptyRow());

		// Search box (only meaningful once in skill focus, but always shown for consistency)
		const cursor = accent("│");
		const queryDisplay = this.query
			? `${this.query}${cursor}`
			: `${cursor}${dim(italic("type to search this group's skills..."))}`;
		lines.push(row(`${dim("◎")}  ${queryDisplay}`));
		lines.push(emptyRow());

		const maxVisible = 8;
		if (this.filtered.length === 0) {
			lines.push(row(dim(italic("No matching skills"))));
			lines.push(emptyRow());
		} else {
			const startIndex = Math.max(0, Math.min(this.selected - Math.floor(maxVisible / 2), this.filtered.length - maxVisible));
			const endIndex = Math.min(startIndex + maxVisible, this.filtered.length);
			for (let i = startIndex; i < endIndex; i++) {
				const skill = this.filtered[i];
				const isSelected = this.focus === "skill" && i === this.selected;
				const isQueued = queuedSkills.has(skill.name);
				const groupOff = disabledGroups.has(current);
				const skillOn = enabledSkills.has(skill.name); // opt-in inside a disabled group
				const skillOff = disabledSkills.has(skill.name); // opt-out inside an enabled group
				const prefix = isSelected ? accent("▸") : dim("·");
				const badge = isQueued ? ` ${accent("●")}` : "";
				const stateBadge = !groupOff && skillOff
					? ` ${error("off")}`
					: groupOff && skillOn
						? ` ${success("on")}`
						: "";
				const alwaysBadge = skill.alwaysOn ? ` ${success("↻")}` : "";
				const tokStr = dim(`≈${fmtTokens(getTokenEstimate(skill).full)}`);
				const nameStr = isSelected
					? bold(accent(skill.name))
					: (groupOff && !skillOn) || (!groupOff && skillOff)
						? dim(skill.name)
						: skill.alwaysOn
							? success(skill.name)
							: skill.name;
				const fixed = 4 /* prefix + space + space before desc */ + visLen(badge) + visLen(stateBadge) + visLen(alwaysBadge) + visLen(tokStr) + 5 /* "  —  " */;
				const maxDescLen = Math.max(0, innerW - visLen(skill.name) - fixed);
				const descStr = maxDescLen > 3 ? dim(truncateToWidth(skill.description, maxDescLen, "…")) : "";
				lines.push(row(`${prefix} ${nameStr}${badge}${stateBadge}${alwaysBadge} ${tokStr}${descStr ? `  ${dim("—")}  ${descStr}` : ""}`));
			}
			if (this.filtered.length > maxVisible) {
				lines.push(row(dim(`${startIndex + 1}-${endIndex} of ${this.filtered.length}`)));
			}
			lines.push(emptyRow());
		}

		if (queuedSkills.size > 0) {
			const allSkills = [...this.groups.values()].flat();
			const queuedInfos = allSkills.filter((skill) => queuedSkills.has(skill.name));
			const queuedTokens = estimateTokens(buildSkillContext(queuedInfos));
			lines.push(
				row(accent(`📚 ${queuedSkills.size}/${MAX_QUEUED_SKILLS} queued · ≈${fmtTokens(queuedTokens)} for next message`)),
			);
			lines.push(emptyRow());
		}

		lines.push(border(`├${"─".repeat(innerW)}┤`));
		lines.push(emptyRow());
		if (this.message) {
			lines.push(row(accent(this.message)));
			lines.push(emptyRow());
		}
		lines.push(
			row(
				dim(
					`${italic("tab/←→")} group  ${italic("↑↓/type")} search skills  ${italic("enter")} toggle group/queue skill  ${italic("ctrl+t")} on/off skill  ${italic("u")} unqueue all  ${italic("esc")} back/close  ${success("↻")}${dim(" always-on")}`,
				),
			),
		);
		lines.push(border(`╰${"─".repeat(innerW)}╯`));

		return lines;
	}

	invalidate(): void {}
	dispose(): void {}
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension entry point
// ═══════════════════════════════════════════════════════════════════════════

export default function skillGroupPaletteExtension(pi: ExtensionAPI): void {
	pi.registerCommand("skillgroups", {
		description: "Toggle skill groups or individual skills on/off, or search within a group to queue one skill",
		getArgumentCompletions: (prefix: string) => {
			const names = ["list", "on", "off"];
			return names.filter((n) => n.startsWith(prefix)).map((n) => ({ value: n, label: n }));
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			refreshDivisor(ctx.model);
			const skills = getAllSkills(ctx);
			const groups = groupSkills(skills);
			const parts = args.trim().split(/\s+/).filter(Boolean);

			// Groups/skills toggled inside the overlay; reload afterwards if the
			// set changed so pi re-scans and actually loads/drops them.
			const snapshot = () =>
				[...disabledGroups].sort().join("\u0000") +
				"\u0001" +
				[...disabledSkills].sort().join("\u0000") +
				"\u0002" +
				[...enabledSkills].sort().join("\u0000");

			if (parts.length === 0) {
				if (ctx.mode !== "tui") {
					if (ctx.hasUI) ctx.ui.notify("/skillgroups requires interactive TUI mode (try /skillgroups list)", "warning");
					return;
				}
				if (groups.size === 0) {
					ctx.ui.notify("No skill groups found", "info");
					return;
				}
				const before = snapshot();
				await ctx.ui.custom<null>(
					(_tui, theme, _keybindings, done) => new SkillGroupPaletteComponent(groups, theme, done),
					{ overlay: true, overlayOptions: { anchor: "center", width: 76 } },
				);
				updateIndicators(ctx);
				if (snapshot() !== before && ctx.reload) await ctx.reload();
				return;
			}

			if (parts[0] === "list") {
				const lines = [...groups.entries()].map(([name, list]) => {
					const groupOff = disabledGroups.has(name);
					const state = groupOff ? "off" : "on ";
					const listed = totalTokens(
						list.filter((skill) => (groupOff ? enabledSkills.has(skill.name) : !disabledSkills.has(skill.name))),
						"prompt",
					);
					const full = totalTokens(list, "full");
					const alwaysOn = list.filter((skill) => skill.alwaysOn).map((skill) => skill.name);
					const alwaysNote = alwaysOn.length ? `  ↻ always-on: ${alwaysOn.join(", ")}` : "";
					// Disabled group: show explicit opt-ins; enabled group: opt-outs.
					const special = groupOff
						? list.filter((skill) => enabledSkills.has(skill.name)).map((skill) => skill.name)
						: list.filter((skill) => disabledSkills.has(skill.name)).map((skill) => skill.name);
					const specialNote = special.length
						? `  ${groupOff ? "↑ on" : "⛔ off"}: ${special.join(", ")}`
						: "";
					return `${state}  ${name} (${list.length})  ≈${fmtTokens(listed)} in prompt · ≈${fmtTokens(full)} if all queued${alwaysNote}${specialNote}`;
				});
				ctx.ui.notify(lines.length ? lines.join("\n") : "No skill groups found", "info");
				return;
			}

			const [name, action] = parts;
			if (!groups.has(name)) {
				ctx.ui.notify(`Unknown skill group: ${name}. Known: ${[...groups.keys()].join(", ") || "(none)"}`, "error");
				return;
			}

			const before = snapshot();
			if (action === "on") {
				if (disabledGroups.delete(name)) saveState(disabledGroups, disabledSkills, enabledSkills);
				ctx.ui.notify(`Enabled "${name}"`, "info");
			} else if (action === "off") {
				disabledGroups.add(name);
				saveState(disabledGroups, disabledSkills, enabledSkills);
				ctx.ui.notify(`Disabled "${name}"`, "info");
			} else {
				ctx.ui.notify(`Usage: /skillgroups [list | <name> on|off]`, "warning");
				return;
			}
			updateIndicators(ctx);
			if (snapshot() !== before && ctx.reload) await ctx.reload();
		},
	});

	// Own discovery for the shelf: hand pi only the enabled paths — whole group
	// dirs, or per-skill dirs when some skills in a group are disabled. Disabled
	// paths are never scanned: no prompt block, no /skill:name command.
	pi.on("resources_discover", async () => {
		return { skillPaths: enabledGroupPaths() };
	});

	// Belt-and-braces: strip disabled groups from the prompt in case some shelf
	// skill still slipped in via another root, and send queued skills' full
	// content once as a follow-up message.
	pi.on("before_agent_start", async (event, ctx) => {
		const infos = (event.systemPromptOptions.skills ?? []).map((skill) => toSkillInfo(skill, isAlwaysOn(skill.filePath)));
		const systemPrompt = stripDisabledSkills(event.systemPrompt, infos);

		if (queuedSkills.size === 0) {
			return systemPrompt === event.systemPrompt ? {} : { systemPrompt };
		}

		const byName = new Map(infos.map((skill) => [skill.name, skill]));
		const toSend = [...queuedSkills].map((name) => byName.get(name)).filter((skill): skill is SkillInfo => Boolean(skill));
		queuedSkills.clear();
		updateIndicators(ctx);

		if (toSend.length === 0) {
			return systemPrompt === event.systemPrompt ? {} : { systemPrompt };
		}

		const content = buildSkillContext(toSend);
		if (content.length > LARGE_QUEUE_WARN_CHARS) {
			ctx.ui?.notify(
				`Queued skill content is large (≈${fmtTokens(estimateTokens(content))} tok).`,
				"warning",
			);
		}

		return {
			message: {
				customType: "skill-group-context",
				content,
				display: true,
			},
			systemPrompt,
		};
	});

	// Keep token estimates in sync with the active model's tokenizer family.
	pi.on("model_select", (_event, ctx) => {
		refreshDivisor(_event.model);
		updateIndicators(ctx);
	});

	// Every session begins with only alvaroak + misc on. Skill-level toggles
	// persist across sessions. /reload (reason "reload") fires after a
	// mid-session toggle and must NOT reset, or the toggle would be undone
	// before pi re-scans.
	pi.on("session_start", (event, ctx) => {
		if (event.reason !== "reload") {
			resetGroupsToDefaults();
		}
		updateIndicators(ctx);
	});
}
