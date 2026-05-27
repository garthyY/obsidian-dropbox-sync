import { requestUrl, TFile, TFolder, Vault, Notice, TAbstractFile } from "obsidian";
import {
	DropboxToken,
	isTokenExpired,
	refreshToken,
} from "./dropbox-auth";

// ─── Types ───────────────────────────────────────────────────────────────────

export type SyncDirection = "upload" | "download" | "two-way";

export interface SyncOptions {
	direction: SyncDirection;
	remoteBasePath: string;
	localPrefix: string;
	maxFileSize: number;
	clientId: string;
	/** 上次同步时间戳 — 增量模式按此过滤 */
	lastSyncAt: number;
	/** Dropbox list_folder 游标 — 增量模式复用 */
	remoteCursor: string | null;
	/** 增量同步计数 */
	incrementalCount: number;
}

export interface SyncStatus {
	running: boolean;
	lastSyncAt: number | null;
	lastError: string | null;
	progress: { total: number; completed: number; current: string };
}

/** 同步完成后回调 — 让调用方保存 lastSyncAt / cursor */
export interface SyncResult {
	lastSyncAt: number;
	remoteCursor: string | null;
	incrementalCount: number;
	fullScanDone: boolean;
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
		console.log("Dropbox Sync: SyncEngine 创建", {
			direction: options.direction,
			remoteBasePath: this.options.remoteBasePath,
			lastSyncAt: options.lastSyncAt ? new Date(options.lastSyncAt).toISOString() : "首次",
			incrementalCount: options.incrementalCount,
		});
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

	/** 返回当前 sync options 供保存 */
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

		// 判断是否该做全量扫描兜底
		const needsFullScan =
			this.options.lastSyncAt === 0 ||
			this.options.incrementalCount >= 10;

		console.log("Dropbox Sync: === 开始同步 ===");
		console.log("Dropbox Sync: 方向:", this.options.direction);
		console.log("Dropbox Sync: 模式:", needsFullScan ? "全量" : "增量");
		console.log("Dropbox Sync: 增量计数:", this.options.incrementalCount);

		try {
			await this.ensureValidToken();
			const result = await this.runSync(needsFullScan);

			this.status.lastSyncAt = Date.now();
			console.log("Dropbox Sync: === 同步完成 ===");
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
		console.log("Dropbox Sync: 用户取消了同步");
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		this.status.running = false;
	}

	// ─── 单文件保存同步 ──────────────────────────────────────────────────

	async uploadFile(file: TFile): Promise<void> {
		if (this.status.running) {
			console.log("Dropbox Sync: 全量同步中，跳过保存时同步", file.path);
			return;
		}
		try {
			await this.ensureValidToken();
			const localPath = file.path;
			const remotePath = this.localToRemote(localPath);
			const content = await this.vault.readBinary(file);

			if (this.options.maxFileSize > 0 && content.byteLength > this.options.maxFileSize) {
				console.log("Dropbox Sync: 文件超过大小限制", localPath);
				return;
			}

			console.log("Dropbox Sync: 保存时上传", localPath);
			await this.dropboxUpload(remotePath, content);
		} catch (err) {
			console.error(`Dropbox Sync: 保存时上传失败 ${file.path}:`, err);
		}
	}

	shouldSync(file: TAbstractFile): boolean {
		if (file instanceof TFolder) return false;
		const path = file.path;
		if (this.options.localPrefix && !path.startsWith(this.options.localPrefix)) return false;
		const basename = file.name;
		if (basename.startsWith(".")) return false;
		if (basename === "desktop.ini") return false;
		if (path.startsWith(".obsidian/")) return false;
		// 跳过冲突副本文件
		if (basename.includes(".conflict.")) return false;
		return true;
	}

	// ─── 内部同步逻辑 ────────────────────────────────────────────────────────

	private async runSync(needsFullScan: boolean): Promise<SyncResult> {
		let remoteCursor: string | null = null;

		// ── 1. 索引 ──────────────────────────────────────────────────────────

		this.status.progress.current = "正在索引本地文件…";
		console.time("Dropbox Sync: 索引本地");
		const localFiles = await this.indexLocalFiles(needsFullScan ? 0 : this.options.lastSyncAt);
		console.timeEnd("Dropbox Sync: 索引本地");
		console.log("Dropbox Sync: 本地文件数:", localFiles.size);

		this.status.progress.current = "正在索引远程文件…";
		console.time("Dropbox Sync: 索引远程");
		const remoteResult = await this.indexRemoteFiles(needsFullScan);
		console.timeEnd("Dropbox Sync: 索引远程");
		console.log("Dropbox Sync: 远程文件数:", remoteResult.files.size);
		remoteCursor = remoteResult.cursor;

		// ── 2. 对比 ──────────────────────────────────────────────────────────

		console.time("Dropbox Sync: 对比差异");
		const actions = this.resolveActions(localFiles, remoteResult.files);
		console.timeEnd("Dropbox Sync: 对比差异");
		console.log("Dropbox Sync: 操作数:", actions.length);
		if (actions.length > 0) {
			console.log("Dropbox Sync: 操作:", actions.map(a => `${a.action}:${a.path}`).join(", "));
		}

		this.status.progress.total = actions.length;
		this.status.progress.completed = 0;

		// ── 3. 执行 ──────────────────────────────────────────────────────────

		for (const action of actions) {
			if (this.abortController?.signal.aborted) {
				throw new Error("同步已取消");
			}
			this.status.progress.current = action.path;
			try {
				await this.executeAction(action);
			} catch (err) {
				console.error(`Dropbox Sync: 操作失败 ${action.action} ${action.path}:`, err);
			}
			this.status.progress.completed++;
		}

		// ── 4. 返回结果 ────────────────────────────────────────────────────

		const newIncrementalCount = needsFullScan ? 0 : this.options.incrementalCount + 1;
		return {
			lastSyncAt: Date.now(),
			remoteCursor: remoteCursor ?? this.options.remoteCursor,
			incrementalCount: newIncrementalCount,
			fullScanDone: needsFullScan,
		};
	}

	// ─── 索引本地（增量过滤） ─────────────────────────────────────────────

	private async indexLocalFiles(since: number): Promise<Map<string, number>> {
		const files = new Map<string, number>();
		const allFiles = this.vault.getFiles();

		for (const file of allFiles) {
			if (!this.shouldSync(file)) continue;
			const relPath = this.relativePath(file.path);

			try {
				const stat = await this.vault.adapter.stat(file.path);
				const mtime = stat?.mtime ?? file.stat.mtime;
				// 增量过滤
				if (since > 0 && mtime <= since) continue;
				files.set(relPath, mtime);
			} catch (err) {
				console.warn("Dropbox Sync: 读取文件失败", file.path, err);
			}
		}

		return files;
	}

	// ─── 索引远程（增量游标 / 全量） ─────────────────────────────────────

	private async indexRemoteFiles(
		fullScan: boolean,
	): Promise<{
		files: Map<string, { rev: string; modified: number; content_hash: string }>;
		cursor: string | null;
	}> {
		const files = new Map<string, { rev: string; modified: number; content_hash: string }>();
		let cursor: string | null = null;
		let hasMore = true;
		let pageCount = 0;

		// 增量模式且有游标 → 从游标继续
		const useCursor = !fullScan && !!this.options.remoteCursor;

		while (hasMore) {
			pageCount++;
			let result: ListFolderResult;
			try {
				if (cursor) {
					result = await this.dropboxListFolderContinue(cursor);
				} else if (useCursor) {
					// 增量：从上次游标继续
					result = await this.dropboxListFolderContinue(this.options.remoteCursor!);
					// 第一次调用后清空 remoteCursor 标记，后续分页用 cursor
				} else {
					result = await this.dropboxListFolder(this.options.remoteBasePath);
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				if (msg.includes("409") && msg.includes("not_found")) {
					console.log("Dropbox Sync: 远程目录不存在，自动创建");
					await this.createRemoteFolder();
					return { files, cursor: null };
				}
				console.error("Dropbox Sync: 索引远程失败", err);
				throw err;
			}

			for (const entry of result.entries) {
				if (entry[".tag"] === "file") {
					const file = entry as DropboxFileMetadata;
					const relPath = this.relativeRemotePath(file.path_lower);
					files.set(relPath, {
						rev: file.rev,
						modified: new Date(file.server_modified).getTime(),
						content_hash: file.content_hash,
					});
				}
			}

			cursor = result.cursor;
			hasMore = result.has_more;
		}

		return { files, cursor };
	}

	// ─── 对比差异 + 冲突检测 ───────────────────────────────────────────

	private resolveActions(
		localFiles: Map<string, number>,
		remoteFiles: Map<string, { rev: string; modified: number; content_hash: string }>,
	): Array<{
		path: string;
		action: "upload" | "download" | "conflict-upload" | "delete-local" | "delete-remote";
		conflictRemoteRev?: string;
	}> {
		const actions: Array<{
			path: string;
			action: "upload" | "download" | "conflict-upload" | "delete-local" | "delete-remote";
			conflictRemoteRev?: string;
		}> = [];

		const allPaths = new Set([...localFiles.keys(), ...remoteFiles.keys()]);
		const dir = this.options.direction;

		for (const path of allPaths) {
			const localMtime = localFiles.get(path) ?? null;
			const remote = remoteFiles.get(path) ?? null;
			const remoteMtime = remote?.modified ?? null;

			// —— 只在一侧存在 ——
			if (localMtime === null) {
				if (dir === "download" || dir === "two-way") {
					actions.push({ path, action: "download" });
				}
				continue;
			}
			if (remoteMtime === null) {
				if (dir === "upload" || dir === "two-way") {
					actions.push({ path, action: "upload" });
				}
				continue;
			}

			// —— 两侧都存在 ——
			if (dir === "upload") {
				if (localMtime > remoteMtime) actions.push({ path, action: "upload" });
			} else if (dir === "download") {
				if (remoteMtime > localMtime) actions.push({ path, action: "download" });
			} else {
				// 双向同步 + 冲突检测（加 1 秒缓冲防时钟偏差）
				if (localMtime! > remoteMtime! && remoteMtime! > this.options.lastSyncAt + 1000) {
					// 两侧都在上次同步后改过 → 冲突，保留远程副本
					actions.push({ path, action: "conflict-upload", conflictRemoteRev: remote!.rev });
					continue;
				}
				if (localMtime > remoteMtime) {
					actions.push({ path, action: "upload" });
				} else if (remoteMtime > localMtime) {
					actions.push({ path, action: "download" });
				}
				// mtime 相等 → 跳过
			}
		}

		const priority = { upload: 0, "conflict-upload": 0, download: 1, "delete-local": 2, "delete-remote": 3 };
		actions.sort((a, b) => priority[a.action] - priority[b.action]);

		return actions;
	}

	// ─── 执行操作 ─────────────────────────────────────────────────────────

	private async executeAction(
		action: {
			path: string;
			action: "upload" | "download" | "conflict-upload" | "delete-local" | "delete-remote";
			conflictRemoteRev?: string;
		},
	): Promise<void> {
		const localPath = this.remoteToLocal(action.path);
		const remotePath = this.localToRemote(localPath);

		switch (action.action) {
			case "upload":
			case "conflict-upload": {
				const file = this.vault.getFileByPath(localPath);
				if (!file) {
					console.warn("Dropbox Sync: 上传时文件消失", localPath);
					return;
				}

				// conflict-upload：先把远程旧版本下载为冲突副本
				if (action.action === "conflict-upload" && action.conflictRemoteRev) {
					console.log("Dropbox Sync: 冲突检测 —", localPath, "本地和远程都已修改");
					try {
						const conflictContent = await this.dropboxDownload(remotePath);
						const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
						const conflictName = this.insertSuffix(localPath, `.conflict.${timestamp}`);
						const parent = conflictName.substring(0, conflictName.lastIndexOf("/"));
						if (parent && !(await this.vault.adapter.exists(parent))) {
							await this.vault.createFolder(parent);
						}
						const existing = this.vault.getFileByPath(conflictName);
						if (existing) {
							await this.vault.modifyBinary(existing, conflictContent);
						} else {
							await this.vault.createBinary(conflictName, conflictContent);
						}
						console.log("Dropbox Sync: 冲突副本已保存", conflictName);
					} catch (err) {
						console.error("Dropbox Sync: 保存冲突副本失败", localPath, err);
						// 继续上传本地版本
					}
				}

				// 上传本地版本覆盖远程
				const content = await this.vault.readBinary(file);
				await this.dropboxUpload(remotePath, content);
				break;
			}

			case "download": {
				const content = await this.dropboxDownload(remotePath);
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
				break;
			}

			case "delete-local": {
				const file = this.vault.getFileByPath(localPath);
				if (file) await this.vault.delete(file, true);
				break;
			}

			case "delete-remote": {
				await this.dropboxDelete(remotePath);
				break;
			}
		}
	}

	// ─── 工具函数 ─────────────────────────────────────────────────────────

	/** 在文件名中插入后缀，如 note.md → note.conflict.2024-01-01.md */
	private insertSuffix(path: string, suffix: string): string {
		const dot = path.lastIndexOf(".");
		if (dot === -1) return path + suffix;
		return path.slice(0, dot) + suffix + path.slice(dot);
	}

	// (冲突检测不再需要 hash 比对，Dropbox 的 content_hash 算法与标准 SHA-256 不兼容)

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
			console.log("Dropbox Sync: token 过期，刷新…");
			this.token = await refreshToken(this.options.clientId, this.token);
			console.log("Dropbox Sync: token 刷新成功");
		}
	}

	// ─── Dropbox API ───────────────────────────────────────────────────────

	private async dropboxListFolder(path: string, recursive = true): Promise<ListFolderResult> {
		const body = JSON.stringify({ path, recursive, include_media_info: false, include_deleted: false, include_has_explicit_shared_members: false });
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
			"Dropbox-API-Arg": JSON.stringify({ path: remotePath, mode: "overwrite", autorename: false, mute: false }),
		};
		await this.apiCallBinary("https://content.dropboxapi.com/2/files/upload", content, headers);
	}

	private async dropboxDownload(remotePath: string): Promise<ArrayBuffer> {
		const headers: Record<string, string> = {
			"Dropbox-API-Arg": JSON.stringify({ path: remotePath }),
		};
		const response = await this.apiCallBinary("https://content.dropboxapi.com/2/files/download", null, headers);
		return response.arrayBuffer();
	}

	private async dropboxDelete(remotePath: string): Promise<void> {
		const body = JSON.stringify({ path: remotePath });
		await this.apiCall("https://api.dropboxapi.com/2/files/delete_v2", body);
	}

	private async createRemoteFolder(): Promise<void> {
		const body = JSON.stringify({ path: this.options.remoteBasePath, autorename: false });
		try {
			await this.apiCall("https://api.dropboxapi.com/2/files/create_folder_v2", body);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("409")) throw err;
		}
	}

	// ─── HTTP ──────────────────────────────────────────────────────────────

	private async apiCall(url: string, body: string): Promise<{ status: number; text: string }> {
		console.log("Dropbox Sync: API", url);
		const response = await requestUrl({
			url, method: "POST",
			headers: { "Authorization": `Bearer ${this.token.access_token}`, "Content-Type": "application/json" },
			body, throw: false,
		});
		if (response.status >= 400) {
			throw new Error(`Dropbox API 错误 (${response.status}): ${response.text}`);
		}
		return { status: response.status, text: response.text };
	}

	private async apiCallBinary(
		url: string, body: ArrayBuffer | null, extraHeaders: Record<string, string>,
	): Promise<{ arrayBuffer: () => Promise<ArrayBuffer> }> {
		const headers = { "Authorization": `Bearer ${this.token.access_token}`, ...extraHeaders };
		const response = await requestUrl({
			url, method: "POST", headers,
			body: body ?? undefined, throw: false,
		});
		if (response.status >= 400) {
			throw new Error(`Dropbox API 错误 (${response.status}): ${response.text}`);
		}
		return { arrayBuffer: () => Promise.resolve(response.arrayBuffer) };
	}
}
