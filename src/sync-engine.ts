import { requestUrl, TFile, TFolder, Vault, Notice, TAbstractFile } from "obsidian";
import {
	DropboxToken,
	isTokenExpired,
	refreshToken,
} from "./dropbox-auth";
// 不顶格 import fs —— 移动端无此模块，改为函数内动态 require

// ─── Types ───────────────────────────────────────────────────────────────────

export type SyncDirection = "upload" | "download" | "two-way";

export interface SyncOptions {
	direction: SyncDirection;
	remoteBasePath: string;
	localPrefix: string;
	maxFileSize: number;
	clientId: string;
	/** 本地状态文件路径（如 /path/to/plugins/obsidian-dropbox-sync/state.json）*/
	stateFilePath: string;
}

export interface SyncStatus {
	running: boolean;
	lastSyncAt: number | null;
	lastError: string | null;
	progress: { total: number; completed: number; current: string };
}

export interface SyncResult {
	lastSyncAt: number;
	actionsCompleted: number;
}

// ─── 状态文件类型 ───────────────────────────────────────────────────────────

export interface FileStateEntry {
	v: number;       // 版本号
	exists: boolean; // 文件是否存在
	h: string;       // 内容哈希（SHA-256 hex）
}

export interface SyncState {
	files: Record<string, FileStateEntry>;
}

// ─── Dropbox API Response Types ──────────────────────────────────────────────

interface DropboxFileMetadata {
	".tag": "file";
	name: string;
	path_lower: string;
	path_display: string;
	id: string;
	client_modified: string;
	server_modified: string;
	rev: string;
	size: number;
	content_hash: string;
}

interface DropboxFolderMetadata {
	".tag": "folder";
	name: string;
	path_lower: string;
	path_display: string;
}

type DropboxEntry = DropboxFileMetadata | DropboxFolderMetadata;

interface ListFolderResult {
	entries: DropboxEntry[];
	cursor: string;
	has_more: boolean;
}

// ─── 日志缓冲区 ─────────────────────────────────────────────────────────────

const MAX_LOG_LINES = 500;
const _logBuffer: string[] = [];

export function addLog(msg: string): void {
	const entry = `[${new Date().toLocaleTimeString()}] ${msg}`;
	_logBuffer.push(entry);
	if (_logBuffer.length > MAX_LOG_LINES) _logBuffer.shift();
	console.log("Dropbox Sync:", msg);
}

export function getLogs(): string[] {
	return [..._logBuffer];
}

export function clearLogs(): void {
	_logBuffer.length = 0;
}

// ─── 常量 ─────────────────────────────────────────────────────────────────────

const REMOTE_STATE_FILENAME = ".sync_state.json";

// ─── Sync Engine ─────────────────────────────────────────────────────────────

export class SyncEngine {
	private vault: Vault;
	private token: DropboxToken;
	private options: SyncOptions;
	private status: SyncStatus;
	private abortController: AbortController | null = null;

	constructor(vault: Vault, token: DropboxToken, options: SyncOptions) {
		this.vault = vault;
		this.token = token;
		this.options = {
			...options,
			remoteBasePath: "/" + options.remoteBasePath.replace(/^\/+|\/+$/g, ""),
		};
		this.status = {
			running: false,
			lastSyncAt: null,
			lastError: null,
			progress: { total: 0, completed: 0, current: "" },
		};
		addLog("SyncEngine 创建: " + JSON.stringify({
			direction: options.direction,
			remoteBasePath: this.options.remoteBasePath,
		}));
	}

	getStatus(): SyncStatus {
		return { ...this.status, progress: { ...this.status.progress } };
	}

	isRunning(): boolean {
		return this.status.running;
	}

	updateToken(token: DropboxToken): void {
		this.token = token;
	}

	getOptions(): SyncOptions {
		return { ...this.options };
	}

	// ─── 全量同步 ──────────────────────────────────────────────────────────

	async syncNow(): Promise<SyncResult> {
		if (this.status.running) {
			console.warn("Dropbox Sync: 同步已在进行中");
			throw new Error("同步已在进行中");
		}

		this.abortController = new AbortController();
		this.status.running = true;
		this.status.lastError = null;
		this.status.progress = { total: 0, completed: 0, current: "正在启动…" };

		addLog("=== 开始同步 ===");
		addLog(`方向: ${this.options.direction}`);

		try {
			await this.ensureValidToken();
			const result = await this.runSync();

			this.status.lastSyncAt = Date.now();
			addLog("=== 同步完成 ===");
			new Notice("Dropbox 同步完成");
			return result;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.status.lastError = msg;
			console.error("Dropbox Sync: === 同步失败 ===", err);
			new Notice(`Dropbox 同步错误：${msg}`, 8000);
			throw err;
		} finally {
			this.status.running = false;
			this.abortController = null;
		}
	}

	cancel(): void {
		addLog("用户取消了同步");
		if (this.abortController) {
			this.abortController.abort();
			// 不置 null——后续 runSync 循环靠 ?.signal.aborted 检测取消
		}
		this.status.running = false;
	}

	/**
	 * 首次同步 / 强制重扫：清空本地状态 → 全量同步（远端文件用现有版本号）
	 */
	async syncFresh(): Promise<SyncResult> {
		addLog("=== 首次同步 / 强制重扫 ===");
		await this.saveLocalState({ files: {} });
		addLog("本地状态已清空");
		return await this.syncNow();
	}

	// ─── 单文件保存同步 ──────────────────────────────────────────────────

	async uploadFile(file: TFile): Promise<void> {
		if (this.status.running) {
			addLog(`全量同步中，跳过保存时上传 ${file.path}`);
			return;
		}
		try {
			await this.ensureValidToken();
			const localPath = file.path;
			const remotePath = this.localToRemote(localPath);
			const content = await this.vault.readBinary(file);

			if (this.options.maxFileSize > 0 && content.byteLength > this.options.maxFileSize) {
				addLog(`文件超过大小限制 ${localPath}`);
				return;
			}

			addLog(`保存时上传 ${localPath}`);
			await this.dropboxUpload(remotePath, content);
		} catch (err) {
			console.error(`Dropbox Sync: 保存时上传失败 ${file.path}:`, err);
		}
	}

	shouldSync(file: TAbstractFile): boolean {
		if (file instanceof TFolder) return false;
		const p = file.path;
		if (this.options.localPrefix && !p.startsWith(this.options.localPrefix)) return false;
		const basename = file.name;
		if (basename.startsWith(".")) return false;
		if (basename === "desktop.ini") return false;
		if (p.startsWith(".obsidian/")) return false;
		if (p === ".obsidian") return false;
		if (basename.includes(".conflict.")) return false;
		// 跳过状态文件本身（当 vault 根目录恰好是插件目录时兜底）
		if (basename === "state.json" && p.endsWith("/state.json")) return false;
		return true;
	}

	// ─── 内部同步逻辑（状态文件驱动） ───────────────────────────────────────

	private async runSync(): Promise<SyncResult> {
		// 1. 确保远程目录存在
		await this.createRemoteFolder();

		// 2. 加载本地状态
		const localState = await this.loadLocalState();
		addLog("本地状态文件已加载");

		// 3. 扫描本地文件 + 计算 hash + 检测变更 → 版本号推进
		addLog("开始扫描本地文件，计算 SHA-256 哈希…");
		this.status.progress.current = "正在扫描本地文件…";
		// 扫描在手机上可能较慢（SHA-256）
		const newLocalState = await this.detectLocalChanges(localState);
		addLog("扫描完成");
		addLog("本地文件数: " + Object.keys(newLocalState.files).length);

		// 4. 下载远程状态
		this.status.progress.current = "正在下载远程状态…";
		addLog("下载远程状态…");
		let remoteState = await this.downloadRemoteState();
		addLog("远程状态下载完成");

		if (!remoteState.files || Object.keys(remoteState.files).length === 0) {
			// 远程无状态文件 → 枚举实际远程文件作为初始状态（兼容旧系统遗留文件）
			addLog("远程无状态文件，扫描远程目录…");
			remoteState = await this.listRemoteFilesToState();
			if (remoteState.files && Object.keys(remoteState.files).length > 0) {
				const remoteOnly = Object.keys(remoteState.files).filter(
					p => !(p in (newLocalState.files || {})),
				);
				addLog(`发现 ${Object.keys(remoteState.files).length} 个远程文件（${remoteOnly.length} 个仅远程）`);
			} else {
				addLog("远程目录为空（全新开始）");
			}
		} else {
			addLog(`远程状态包含 ${Object.keys(remoteState.files).length} 个文件`);
		}

		// 过滤远程状态中不应同步的路径（如 .obsidian/）
		const beforeFilterCount = Object.keys(remoteState.files || {}).length;
		remoteState = this.filterStatePaths(remoteState);
		const filteredCount = beforeFilterCount - Object.keys(remoteState.files || {}).length;
		if (filteredCount > 0) {
			addLog(`远程状态过滤了 ${filteredCount} 个不应同步的条目`);
		}

		// 5. 对比两端状态 → 决议操作
		const actions = this.resolveStateActions(newLocalState, remoteState, this.options.direction);
		addLog(`待处理 ${actions.length} 个文件`);
		if (actions.length > 0) {
			addLog(`操作: ${actions.map(a => `${a.action}:${a.path}`).join(", ")}`);
		}

		this.status.progress.total = actions.length;
		this.status.progress.completed = 0;

		// 6. 执行操作（每个操作成功后立即保存本地状态，避免中途崩溃丢状态）
		for (const action of actions) {
			if (this.abortController?.signal.aborted) {
				throw new Error("同步已取消");
			}
			this.status.progress.current = action.path;
			try {
				await this.executeAction(action, newLocalState, remoteState);
				// 操作成功 → 立即保存本地状态，崩溃后下次同步能从中断点继续
				await this.saveLocalState(this.mergeStates(newLocalState, remoteState));
				addLog(`[${this.status.progress.completed + 1}/${actions.length}] ${action.action} ${action.path}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				addLog(`❌ 操作失败 ${action.action} ${action.path}: ${msg}`);
			}
			this.status.progress.completed++;
		}

		// 7. 合并两端状态（各路径取最高版本号）
		const merged = this.mergeStates(newLocalState, remoteState);

		// 8. 保存本地状态（兜底）
		await this.saveLocalState(merged);
		addLog("本地状态已保存");

		// 9. 上传远程状态到 Dropbox
		try {
			await this.uploadRemoteState(merged);
			addLog("远程状态已上传");
		} catch (err) {
			console.error("Dropbox Sync: 远程状态上传失败（非致命）", err);
		}

		return { lastSyncAt: Date.now(), actionsCompleted: actions.length };
	}

	// ─── Hash ──────────────────────────────────────────────────────────────────

	private async fileHash(content: ArrayBuffer): Promise<string> {
		const hash = await crypto.subtle.digest("SHA-256", content);
		return Array.from(new Uint8Array(hash))
			.map(b => b.toString(16).padStart(2, "0"))
			.join("");
	}

	// ─── 本地状态文件管理 ─────────────────────────────────────────────────

	private async loadLocalState(): Promise<SyncState> {
		const _fs = getFs();
		if (_fs) {
			try {
				const content = _fs.readFileSync(this.options.stateFilePath, "utf-8");
				return JSON.parse(content);
			} catch (err) {
				if (err instanceof Error && (err as NodeJS.ErrnoException).code !== "ENOENT") {
					console.warn("Dropbox Sync: 读取本地状态文件失败", this.options.stateFilePath, err);
				}
				return { files: {} };
			}
		}
		// 移动端无 fs → 尝试 vault adapter
		try {
			const adapter = this.vault.adapter;
			const vaultPath = `.obsidian/plugins/obsidian-dropbox-sync/state.json`;
			const content = await adapter.read(vaultPath);
			return JSON.parse(content);
		} catch {
			return { files: {} };
		}
	}

	private async saveLocalState(state: SyncState): Promise<void> {
		const _fs = getFs();
		if (_fs) {
			try {
				_fs.writeFileSync(this.options.stateFilePath, JSON.stringify(state, null, 2), "utf-8");
				return;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				console.error("Dropbox Sync: 保存本地状态文件失败", this.options.stateFilePath, msg);
				throw new Error(`无法写入状态文件 ${this.options.stateFilePath}: ${msg}`);
			}
		}
		// 移动端无 fs → 写入 vault
		try {
			const adapter = this.vault.adapter;
			const vaultPath = `.obsidian/plugins/obsidian-dropbox-sync/state.json`;
			await adapter.write(vaultPath, JSON.stringify(state, null, 2));
		} catch (err) {
			console.warn("Dropbox Sync: 保存状态到 vault 失败", err);
		}
	}

	// ─── 远程状态文件管理 ────────────────────────────────────────────────

	private remoteStatePath(): string {
		const base = this.options.remoteBasePath.replace(/\/+$/, "");
		return `${base}/${REMOTE_STATE_FILENAME}`;
	}

	private async downloadRemoteState(): Promise<SyncState> {
		try {
			const content = await this.dropboxDownload(this.remoteStatePath());
			const text = new TextDecoder().decode(content);
			return JSON.parse(text);
		} catch {
			return { files: {} };
		}
	}

	private async uploadRemoteState(state: SyncState): Promise<void> {
		const json = JSON.stringify(state, null, 2);
		const encoded = new TextEncoder().encode(json);
		const content = encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength);
		try {
			await this.dropboxUpload(this.remoteStatePath(), content);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (msg.includes("not_found")) {
				await this.createRemoteFolder();
				await this.dropboxUpload(this.remoteStatePath(), content);
			} else {
				throw err;
			}
		}
	}

	private async listRemoteFilesToState(): Promise<SyncState> {
		/** 首次同步 / 迁移时枚举远程实际文件，生成初始状态条目（v=1） */
		const state: SyncState = { files: {} };
		try {
			let result = await this.dropboxListFolder(this.options.remoteBasePath);
			let entries = result.entries;
			let cursor = result.cursor;
			let hasMore = result.has_more;

			while (hasMore) {
				result = await this.dropboxListFolderContinue(cursor);
				entries = entries.concat(result.entries);
				cursor = result.cursor;
				hasMore = result.has_more;
			}

			for (const entry of entries) {
				if (entry[".tag"] !== "file") continue;
				const rel = this.relativeRemotePath(entry.path_lower);
				if (rel === REMOTE_STATE_FILENAME) continue;
				state.files[rel] = { v: 1, exists: true, h: "" };
			}
		} catch {
			// 目录尚不存在
		}
		return state;
	}

	// ─── 本地文件扫描 + hash + 版本检测 ─────────────────────────────────

	private async detectLocalChanges(oldState: SyncState): Promise<SyncState> {
		/** 扫描本地文件，计算 hash，与旧状态比对 → 返回更新后的状态（版本号 + hash） */
		const oldFiles = oldState.files || {};
		const newFiles: Record<string, FileStateEntry> = {};
		const allFiles = this.vault.getFiles();

		for (const file of allFiles) {
			if (!this.shouldSync(file)) continue;

			const relPath = this.relativePath(file.path);

			// 文件超过大小限制 → 跳过
			if (this.options.maxFileSize > 0 && file.stat.size > this.options.maxFileSize) {
				addLog(`跳过超大文件 ${relPath}`);
				continue;
			}

			let content: ArrayBuffer;
			try {
				content = await this.vault.readBinary(file);
			} catch (err) {
				console.warn("Dropbox Sync: 读取文件失败", relPath, err);
				continue;
			}

			const h = await this.fileHash(content);
			const oldEntry = oldFiles[relPath] || {};
			const oldV = oldEntry.v || 0;
			const oldHash = oldEntry.h || "";

			if ((oldEntry.exists ?? true) && h === oldHash) {
				// 内容未变 → 保持版本号
				newFiles[relPath] = { v: oldV, exists: true, h };
			} else {
				// 新增或内容改变 → 版本号 +1
				newFiles[relPath] = { v: oldV + 1, exists: true, h };
			}
		}

		// 处理被删除的文件
		for (const [p, entry] of Object.entries(oldFiles)) {
			if (!(p in newFiles)) {
				if (entry.exists) {
					newFiles[p] = { v: (entry.v || 0) + 1, exists: false, h: "" };
				} else {
					newFiles[p] = entry; // 保持已删除状态的条目
				}
			}
		}

		return { files: newFiles };
	}

	// ─── 过滤不应同步的路径 ──────────────────────────────────────────────

	private filterStatePaths(state: SyncState): SyncState {
		/** 移除状态中不应同步的条目（与 shouldSync 逻辑一致） */
		const filtered: Record<string, FileStateEntry> = {};
		for (const [relPath, entry] of Object.entries(state.files || {})) {
			const parts = relPath.split("/");
			const basename = parts.pop() || relPath;

			// 隐藏文件/目录（文件自身或任意父目录以 . 开头，如 .obsidian/）
			if (basename.startsWith(".")) continue;
			if (parts.some(p => p.startsWith("."))) continue;
			// 系统文件
			if (basename === "desktop.ini") continue;
			// 冲突副本
			if (basename.includes(".conflict.")) continue;
			// 远程状态文件自身
			if (basename === REMOTE_STATE_FILENAME) continue;

			filtered[relPath] = entry;
		}
		return { files: filtered };
	}

	// ─── 版本号对比 → 决议操作 ────────────────────────────────────────

	private resolveStateActions(
		localState: SyncState,
		remoteState: SyncState,
		direction: SyncDirection,
	): Array<{ path: string; action: "upload" | "download" | "delete" | "delete_local" }> {
		const actions: Array<{ path: string; action: "upload" | "download" | "delete" | "delete_local" }> = [];
		const localFiles = localState.files || {};
		const remoteFiles = remoteState.files || {};
		const allPaths = new Set([...Object.keys(localFiles), ...Object.keys(remoteFiles)]);

		const hashMatch = (le: Partial<FileStateEntry>, re: Partial<FileStateEntry>): boolean => {
			const lh = le.h || "";
			const rh = re.h || "";
			return !!(lh && rh && lh === rh);
		};

		for (const path of allPaths) {
			const lEntry = localFiles[path] || {};
			const rEntry = remoteFiles[path] || {};
			const lv = lEntry.v || 0;
			const rv = rEntry.v || 0;
			const lExists = path in localFiles ? (lEntry.exists ?? true) : false;
			const rExists = path in remoteFiles ? (rEntry.exists ?? true) : false;

			if (direction === "upload") {
				if (lv > rv) {
					if (lExists && !hashMatch(lEntry, rEntry)) {
						actions.push({ path, action: "upload" });
					} else if (rExists && !lExists) {
						actions.push({ path, action: "delete" });
					}
				} else if (rv > lv && !(path in localFiles) && rExists) {
					actions.push({ path, action: "delete" });
				}
			} else if (direction === "download") {
				if (rv > lv) {
					if (rExists && !hashMatch(lEntry, rEntry)) {
						actions.push({ path, action: "download" });
					} else if (lExists && !rExists) {
						actions.push({ path, action: "delete_local" });
					}
				} else if (lv > rv && !(path in remoteFiles) && lExists) {
					actions.push({ path, action: "delete_local" });
				}
			} else { // two-way
				if (lv > rv) {
					if (lExists && !hashMatch(lEntry, rEntry)) {
						actions.push({ path, action: "upload" });
					} else if (rExists && !lExists) {
						actions.push({ path, action: "delete" });
					}
				} else if (rv > lv) {
					if (rExists && !hashMatch(lEntry, rEntry)) {
						actions.push({ path, action: "download" });
					} else if (lExists && !rExists) {
						actions.push({ path, action: "delete_local" });
					}
				}
			}
		}

		return actions;
	}

	// ─── 合并两端状态 ────────────────────────────────────────────────────

	private mergeStates(localState: SyncState, remoteState: SyncState): SyncState {
		/** 合并两端状态：每个路径取最高版本号 */
		const merged: SyncState = { files: {} };
		const allPaths = new Set([
			...Object.keys(localState.files || {}),
			...Object.keys(remoteState.files || {}),
		]);

		for (const path of allPaths) {
			const lEntry = (localState.files || {})[path] || {};
			const rEntry = (remoteState.files || {})[path] || {};
			const lv = lEntry.v || 0;
			const rv = rEntry.v || 0;

			merged.files[path] = lv >= rv ? lEntry : rEntry;
		}

		return merged;
	}

	// ─── 执行单个操作 ───────────────────────────────────────────────────

	private async executeAction(
		action: { path: string; action: "upload" | "download" | "delete" | "delete_local" },
		localState: SyncState,
		remoteState: SyncState,
	): Promise<void> {
		const localPath = this.remoteToLocal(action.path);
		const remotePath = this.localToRemote(localPath);

		if (action.action === "upload") {
			const file = this.vault.getFileByPath(localPath);
			if (!file) {
				console.warn("Dropbox Sync: 上传时文件消失", localPath);
				return;
			}
			const content = await this.vault.readBinary(file);
			await this.dropboxUpload(remotePath, content);

			// 操作成功 → 更新远程状态条目
			remoteState.files[action.path] = { ...(localState.files[action.path] || { v: 1, exists: true, h: "" }) };

		} else if (action.action === "download") {
			const content = await this.dropboxDownload(remotePath);
			const h = await this.fileHash(content);

			const parent = localPath.substring(0, localPath.lastIndexOf("/"));
			if (parent && !(await this.vault.adapter.exists(parent))) {
				await this.vault.createFolder(parent);
			}
			const existing = this.vault.getFileByPath(localPath);
			if (existing) {
				await this.vault.modifyBinary(existing, content);
			} else {
				await this.vault.createBinary(localPath, content);
			}

			// 操作成功 → 更新本地状态条目（补充 hash）
			const rEntry = remoteState.files[action.path] || { v: 1, exists: true, h: "" };
			localState.files[action.path] = { ...rEntry, h };

		} else if (action.action === "delete") {
			try {
				await this.dropboxDelete(remotePath);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (!msg.includes("not_found")) throw err;
				// 远程已不存在 → 继续
			}

			const lv = (localState.files[action.path]?.v || 0);
			const rv = (remoteState.files[action.path]?.v || 0);
			const maxV = Math.max(lv, rv);
			remoteState.files[action.path] = { v: maxV, exists: false, h: "" };
			if (!(action.path in localState.files)) {
				localState.files[action.path] = { v: maxV, exists: false, h: "" };
			}

		} else if (action.action === "delete_local") {
			const file = this.vault.getFileByPath(localPath);
			if (file) await this.vault.delete(file, true);

			const lv = (localState.files[action.path]?.v || 0);
			const rv = (remoteState.files[action.path]?.v || 0);
			const maxV = Math.max(lv, rv);
			localState.files[action.path] = { v: maxV, exists: false, h: "" };
			if (!(action.path in remoteState.files)) {
				remoteState.files[action.path] = { v: maxV, exists: false, h: "" };
			}
		}
	}

	// ─── 路径工具 ──────────────────────────────────────────────────────────

	private relativePath(absolutePath: string): string {
		if (this.options.localPrefix) {
			if (absolutePath.startsWith(this.options.localPrefix + "/")) {
				return absolutePath.substring(this.options.localPrefix.length + 1);
			}
			if (absolutePath === this.options.localPrefix) return "";
		}
		return absolutePath;
	}

	private localToRemote(localPath: string): string {
		const base = this.options.remoteBasePath.replace(/\/+$/, "");
		return `${base}/${localPath}`;
	}

	private remoteToLocal(remotePath: string): string {
		const prefix = this.options.localPrefix || "";
		return prefix ? `${prefix}/${remotePath}` : remotePath;
	}

	private relativeRemotePath(remoteLower: string): string {
		const base = this.options.remoteBasePath.toLowerCase().replace(/\/+$/, "");
		if (remoteLower.startsWith(base + "/")) {
			return remoteLower.substring(base.length + 1);
		}
		return remoteLower;
	}

	// ─── Token ─────────────────────────────────────────────────────────────

	private async ensureValidToken(): Promise<void> {
		if (isTokenExpired(this.token)) {
			addLog("token 过期，刷新…");
			this.token = await refreshToken(this.options.clientId, this.token);
			addLog("token 刷新成功");
		}
	}

	// ─── Dropbox API ───────────────────────────────────────────────────────

	/**
	 * JSON API 调用（带 401 自动刷新 + 409 自动建目录）
	 */
	private async apiCall(url: string, body: string): Promise<{ status: number; text: string }> {
		const attempt = async (): Promise<{ status: number; text: string }> => {
			const response = await requestUrl({
				url, method: "POST",
				headers: {
					"Authorization": `Bearer ${this.token.access_token}`,
					"Content-Type": "application/json",
				},
				body, throw: false,
			});

			if (response.status === 401) {
				// Token 过期 → 刷新后重试一次
				addLog("API 返回 401，自动刷新 token 后重试...");
				await this.ensureValidToken();
				const retry = await requestUrl({
					url, method: "POST",
					headers: {
						"Authorization": `Bearer ${this.token.access_token}`,
						"Content-Type": "application/json",
					},
					body, throw: false,
				});
				return { status: retry.status, text: retry.text };
			}

			return { status: response.status, text: response.text };
		};

		const result = await attempt();

		if (result.status === 409) {
			try {
				const err = JSON.parse(result.text);
				if (err?.error?.[".tag"] === "path" && err?.error?.path?.[".tag"] === "not_found") {
					// 目录不存在 → 自动创建父目录后重试
					const parsed = JSON.parse(body);
					const parentPath = parsed.path?.split("/").slice(0, -1).join("/") || "";
					if (parentPath) {
						addLog("目录不存在，自动创建: " + parentPath);
						await this.createFolder(parentPath);
						const retry = await attempt();
						return retry;
					}
				}
			} catch {
				// JSON 解析失败 → 透传原错误
			}
		}

		if (result.status >= 400) {
			throw new Error(`Dropbox API 错误 (${result.status}): ${result.text}`);
		}

		return result;
	}

	/**
	 * 二进制 API 调用（带 401 自动刷新）
	 */
	private async apiCallBinary(
		url: string, body: ArrayBuffer | null, extraHeaders: Record<string, string>,
	): Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; status: number }> {
		const attempt = async (): Promise<{ arrayBuffer: () => Promise<ArrayBuffer>; status: number }> => {
			const headers = { "Authorization": `Bearer ${this.token.access_token}`, ...extraHeaders };
			const response = await requestUrl({
				url, method: "POST", headers,
				body: body ?? undefined, throw: false,
			});

			if (response.status === 401) {
				addLog("二进制 API 返回 401，自动刷新 token 后重试...");
				await this.ensureValidToken();
				const retryHeaders = { "Authorization": `Bearer ${this.token.access_token}`, ...extraHeaders };
				const retry = await requestUrl({
					url, method: "POST", headers: retryHeaders,
					body: body ?? undefined, throw: false,
				});
				return {
					arrayBuffer: () => Promise.resolve(retry.arrayBuffer),
					status: retry.status,
				};
			}

			return {
				arrayBuffer: () => Promise.resolve(response.arrayBuffer),
				status: response.status,
			};
		};

		const result = await attempt();

		if (result.status >= 400) {
			throw new Error(`Dropbox API 错误 (${result.status})`);
		}

		return result;
	}

	private async dropboxListFolder(path: string, recursive = true): Promise<ListFolderResult> {
		const body = JSON.stringify({
			path, recursive,
			include_media_info: false,
			include_deleted: false,
			include_has_explicit_shared_members: false,
		});
		const response = await this.apiCall("https://api.dropboxapi.com/2/files/list_folder", body);
		return JSON.parse(response.text);
	}

	private async dropboxListFolderContinue(cursor: string): Promise<ListFolderResult> {
		const body = JSON.stringify({ cursor });
		const response = await this.apiCall("https://api.dropboxapi.com/2/files/list_folder/continue", body);
		return JSON.parse(response.text);
	}

	private async dropboxUpload(remotePath: string, content: ArrayBuffer): Promise<void> {
		const headers: Record<string, string> = {
			"Content-Type": "application/octet-stream",
			"Dropbox-API-Arg": JSON.stringify({
				path: remotePath, mode: "overwrite", autorename: false, mute: false,
			}),
		};
		await this.apiCallBinary("https://content.dropboxapi.com/2/files/upload", content, headers);
	}

	private async dropboxDownload(remotePath: string): Promise<ArrayBuffer> {
		const headers: Record<string, string> = {
			"Dropbox-API-Arg": JSON.stringify({ path: remotePath }),
		};
		const response = await this.apiCallBinary(
			"https://content.dropboxapi.com/2/files/download", null, headers,
		);
		return response.arrayBuffer();
	}

	private async dropboxDelete(remotePath: string): Promise<void> {
		const body = JSON.stringify({ path: remotePath });
		await this.apiCall("https://api.dropboxapi.com/2/files/delete_v2", body);
	}

	private async createFolder(dirPath: string): Promise<void> {
		const body = JSON.stringify({ path: dirPath, autorename: false });
		try {
			await this.apiCall("https://api.dropboxapi.com/2/files/create_folder_v2", body);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("409") && !msg.includes("conflict")) throw err;
		}
	}

	private async createRemoteFolder(): Promise<void> {
		await this.createFolder(this.options.remoteBasePath);
	}

	// ─── 工具 ─────────────────────────────────────────────────────────────

	/** 在文件名中插入后缀（保留扩展名），如 note.md → note.suffix.md */
	private insertSuffix(filePath: string, suffix: string): string {
		const dot = filePath.lastIndexOf(".");
		if (dot === -1) return filePath + suffix;
		return filePath.slice(0, dot) + suffix + filePath.slice(dot);
	}
}

// ─── 模块级工具 ──────────────────────────────────────────────────────────────

/** 动态获取 fs 模块（移动端不可用时返回 null） */
function getFs(): any {
	try {
		return require("fs");
	} catch {
		return null;
	}
}
