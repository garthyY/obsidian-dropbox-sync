import {
	Notice,
	Plugin,
	TFile,
} from "obsidian";
import { SyncEngine, SyncDirection, SyncStatus, SyncResult } from "./sync-engine";
import {
	authorize,
	loadToken,
	saveToken,
	clearToken,
	isTokenValid,
	DropboxToken,
	DropboxAuthConfig,
} from "./dropbox-auth";
import { DropboxSyncSettings, DEFAULT_SETTINGS, SettingsTab } from "./settings";

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class DropboxSyncPlugin extends Plugin {
	settings: DropboxSyncSettings = DEFAULT_SETTINGS;
	syncEngine: SyncEngine | null = null;
	settingTab: SettingsTab | null = null;
	private statusBarItem: HTMLElement | null = null;
	private statusInterval: number | null = null;

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	async onload(): Promise<void> {
		await this.loadSettings();

		// Status bar
		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass("dropbox-sync-status-bar");
		this.updateStatusBar("idle");

		// Settings tab
		this.settingTab = new SettingsTab(this.app, this);
		this.addSettingTab(this.settingTab);

		// Commands
		this.registerCommands();

		// Event hooks
		this.registerEventHooks();

		// Initialize sync engine if already authorized
		this.initSyncEngine();

		// Status bar updater
		this.statusInterval = window.setInterval(() => this.refreshStatusBar(), 5000);
	}

	onunload(): void {
		this.syncEngine?.cancel();
		if (this.statusInterval !== null) {
			clearInterval(this.statusInterval);
		}
	}

	// ─── Sync Engine ─────────────────────────────────────────────────────────

	private initSyncEngine(): void {
		const token = loadToken(this.settings.dropboxToken);
		if (!isTokenValid(token)) {
			this.syncEngine = null;
			return;
		}

		this.syncEngine = new SyncEngine(this.app.vault, token, {
			direction: this.settings.syncDirection as SyncDirection,
			remoteBasePath: this.settings.remotePath,
			localPrefix: this.settings.localPrefix,
			maxFileSize: this.settings.maxFileSize,
			clientId: this.settings.clientId,
			lastSyncAt: this.settings.lastSyncAt ?? 0,
			remoteCursor: this.settings.remoteCursor ?? null,
			incrementalCount: this.settings.incrementalCount ?? 0,
		});
	}

	/**
	 * Re-create the sync engine (e.g. after auth or settings change).
	 */
	reloadSyncEngine(): void {
		this.syncEngine?.cancel();
		this.initSyncEngine();
	}

	// ─── OAuth ───────────────────────────────────────────────────────────────

	/**
	 * Start Dropbox authorization flow.
	 */
	async authorizeDropbox(): Promise<void> {
		const config: DropboxAuthConfig = {
			clientId: this.settings.clientId,
		};

		try {
			const token = await authorize(config);
			// Store token
			Object.assign(this.settings, saveToken(token));
			await this.saveSettings();
			this.reloadSyncEngine();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			throw new Error(`Authorization failed: ${msg}`);
		}
	}

	/**
	 * Revoke Dropbox authorization.
	 */
	async revokeDropbox(): Promise<void> {
		Object.assign(this.settings, clearToken());
		await this.saveSettings();
		this.syncEngine?.cancel();
		this.syncEngine = null;
	}

	// ─── Config Export / Import ──────────────────────────────────────────────

	/**
	 * 序列化当前配置到 JSON 字符串并复制到剪贴板。
	 */
	async exportConfigToClipboard(): Promise<void> {
		const exportData: Record<string, unknown> = {};

		// 导出所有 settings 字段
		for (const [key, value] of Object.entries(this.settings)) {
			exportData[key] = value;
		}

		const jsonStr = JSON.stringify(exportData, null, 2);

		try {
			await navigator.clipboard.writeText(jsonStr);
			new Notice("✅ 配置已复制到剪贴板", 3000);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`❌ 复制失败：${msg}`, 5000);
		}
	}

	/**
	 * 从 JSON 字符串导入配置并应用。
	 * @param jsonStr 用户粘贴的 JSON 字符串
	 * @returns 导入是否成功
	 */
	async importConfig(jsonStr: string): Promise<boolean> {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(jsonStr);
		} catch {
			new Notice("❌ 配置格式错误：不是有效的 JSON", 5000);
			return false;
		}

		if (typeof parsed !== "object" || parsed === null) {
			new Notice("❌ 配置格式错误：需要 JSON 对象", 5000);
			return false;
		}

		// 类型校验
		const errors: string[] = [];
		if (parsed.clientId !== undefined && typeof parsed.clientId !== "string") {
			errors.push("clientId 应为字符串");
		}
		if (parsed.syncDirection !== undefined && !["upload", "download", "two-way"].includes(parsed.syncDirection as string)) {
			errors.push("syncDirection 应为 upload / download / two-way");
		}
		if (parsed.maxFileSize !== undefined && typeof parsed.maxFileSize !== "number") {
			errors.push("maxFileSize 应为数字");
		}
		if (parsed.syncOnSave !== undefined && typeof parsed.syncOnSave !== "boolean") {
			errors.push("syncOnSave 应为布尔值");
		}

		if (errors.length > 0) {
			new Notice(`❌ 配置校验失败：${errors.join("；")}`, 8000);
			return false;
		}

		// 合入当前设置
		Object.assign(this.settings, DEFAULT_SETTINGS, parsed);
		await this.saveSettings();

		// 重载引擎
		this.reloadSyncEngine();
		new Notice("✅ 配置导入成功", 3000);
		return true;
	}

	// ─── Commands ────────────────────────────────────────────────────────────

	private registerCommands(): void {
		this.addCommand({
			id: "sync-now",
			name: "立即全量同步",
			callback: async () => {
				if (!this.syncEngine) {
					new Notice("Dropbox 同步：请先在设置中授权");
					return;
				}
				try {
					const result = await this.syncEngine.syncNow();
					// 保存增量同步状态
					this.settings.lastSyncAt = result.lastSyncAt;
					this.settings.remoteCursor = result.remoteCursor;
					this.settings.incrementalCount = result.incrementalCount;
					await this.saveSettings();
					console.log("Dropbox Sync: 同步状态已保存", {
						lastSyncAt: new Date(result.lastSyncAt).toISOString(),
						fullScanDone: result.fullScanDone,
						incrementalCount: result.incrementalCount,
					});
					this.refreshStatusBar();
				} catch (err) {
					const msg = err instanceof Error ? err.message : String(err);
					new Notice(`Dropbox 同步错误：${msg}`, 8000);
				}
			},
		});

		this.addCommand({
			id: "cancel-sync",
			name: "取消同步",
			callback: () => {
				this.syncEngine?.cancel();
				new Notice("Dropbox 同步已取消");
			},
		});
	}

	// ─── Events ──────────────────────────────────────────────────────────────

	private registerEventHooks(): void {
		// Sync on file modification (debounced)
		this.registerEvent(
			this.app.vault.on("modify", (file: TFile) => {
				if (!this.syncEngine || !this.settings.syncOnSave) return;
				if (!this.syncEngine.shouldSync(file)) return;
				this.debouncedUpload(file);
			}),
		);

		// Sync on file creation
		this.registerEvent(
			this.app.vault.on("create", (file: TFile) => {
				if (!this.syncEngine || !this.settings.syncOnSave) return;
				if (!this.syncEngine.shouldSync(file)) return;
				this.debouncedUpload(file);
			}),
		);
	}

	private debouncedUpload = this.debounce(async (file: TFile) => {
		if (!this.syncEngine) return;
		await this.syncEngine.uploadFile(file);
		this.refreshStatusBar();
	}, 2000);

	// ─── Status Bar ──────────────────────────────────────────────────────────

	private refreshStatusBar(): void {
		if (!this.statusBarItem) return;

		if (!this.syncEngine) {
			this.updateStatusBar("unauthorized");
			return;
		}

		const status = this.syncEngine.getStatus();
		if (status.running) {
			this.updateStatusBar("syncing", status);
		} else if (status.lastError) {
			this.updateStatusBar("error", status);
		} else if (status.lastSyncAt) {
			this.updateStatusBar("synced", status);
		} else {
			this.updateStatusBar("idle");
		}
	}

	private updateStatusBar(
		state: "idle" | "syncing" | "synced" | "error" | "unauthorized",
		status?: SyncStatus,
	): void {
		if (!this.statusBarItem) return;

		this.statusBarItem.empty();
		this.statusBarItem.className = `dropbox-sync-status-bar ${state}`;

		switch (state) {
			case "unauthorized":
				this.statusBarItem.setText("☁️ Dropbox — 未授权");
				break;
			case "syncing":
				this.statusBarItem.setText(
					`☁️ 同步中… ${status?.progress.completed ?? 0}/${status?.progress.total ?? 0}`,
				);
				break;
			case "synced": {
				const last = status?.lastSyncAt
					? new Date(status.lastSyncAt).toLocaleTimeString()
					: "?";
				this.statusBarItem.setText(`☁️ 已同步 ${last}`);
				break;
			}
			case "error":
				this.statusBarItem.setText("☁️ 同步出错");
				break;
			default:
				this.statusBarItem.setText("☁️ Dropbox");
				break;
		}
	}

	// ─── Settings ────────────────────────────────────────────────────────────

	async loadSettings(): Promise<void> {
		const data = await this.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// ─── Utility ─────────────────────────────────────────────────────────────

	private debounce<T extends (...args: unknown[]) => unknown>(
		fn: T,
		delay: number,
	): (...args: Parameters<T>) => void {
		let timer: number | null = null;
		return (...args: Parameters<T>) => {
			if (timer !== null) clearTimeout(timer);
			timer = window.setTimeout(() => {
				fn(...args);
				timer = null;
			}, delay);
		};
	}
}
