import {
	Notice,
	Plugin,
	TFile,
} from "obsidian";
import { SyncEngine, SyncDirection, SyncStatus, SyncResult, addLog } from "./sync-engine";
import {
	authorize,
	loadToken,
	saveToken,
	clearToken,
	isTokenValid,
	DropboxToken,
	DropboxAuthConfig,
} from "./dropbox-auth";
import { DropboxSyncSettings, DEFAULT_SETTINGS, SettingsTab, ExportModal } from "./settings";
// 不顶格 import path —— 移动端无此模块，改为函数内动态 require / 内联拼接

// ─── Plugin ──────────────────────────────────────────────────────────────────

export default class DropboxSyncPlugin extends Plugin {
	settings: DropboxSyncSettings = DEFAULT_SETTINGS;
	syncEngine: SyncEngine | null = null;
	settingTab: SettingsTab | null = null;
	private statusBarItem: HTMLElement | null = null;
	private statusInterval: number | null = null;
	private autoSyncInterval: number | null = null;

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

		// Ribbon button
		this.addRibbonIcon("refresh-cw", "Dropbox 立即同步", async () => {
			if (!this.syncEngine) {
				new Notice("Dropbox 同步：请先在设置中授权");
				return;
			}
			try {
				const result = await this.syncEngine.syncNow();
				this.settings.lastSyncAt = result.lastSyncAt;
				await this.saveSettings();
				this.refreshStatusBar();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				new Notice(`同步错误：${msg}`, 8000);
			}
		});

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
		this.stopAutoSync();
	}

	// ─── Auto Sync ─────────────────────────────────────────────────────────

	private startAutoSync(): void {
		this.stopAutoSync();
		if (this.settings.syncInterval <= 0) return;
		addLog(`启动自动同步，间隔 ${this.settings.syncInterval} 秒`);
		this.autoSyncInterval = window.setInterval(() => {
			if (!this.syncEngine) return;
			if (this.syncEngine.isRunning()) return;
			this.syncEngine.syncNow().then(() => {
				this.settings.lastSyncAt = Date.now();
				this.saveSettings();
			}).catch(() => {});
		}, this.settings.syncInterval * 1000);
	}

	private stopAutoSync(): void {
		if (this.autoSyncInterval !== null) {
			clearInterval(this.autoSyncInterval);
			this.autoSyncInterval = null;
		}
	}

	restartAutoSync(): void {
		this.startAutoSync();
	}

	// ─── Sync Engine ─────────────────────────────────────────────────────────

	private initSyncEngine(): void {
		const token = loadToken(this.settings.dropboxToken);
		if (!isTokenValid(token)) {
			if (token) {
				new Notice(`❌ Token 缺少 refresh_token（值为空），请重新授权`, 8000);
			} else {
				const raw = this.settings.dropboxToken;
				new Notice(`❌ Token 加载失败: type=${typeof raw}, keys=${raw ? Object.keys(raw).join(",") : "null"}`, 8000);
			}
			this.syncEngine = null;
			return;
		}

		// 通过 Vault Adapter 获取插件目录
		// adapter.getBasePath() 返回仓库根目录，拼接 .obsidian/plugins/<id>
		const adapter = (this.app.vault.adapter as any);
		const basePath: string | undefined = adapter?.getBasePath?.();
		const segments = [basePath, this.app.vault.configDir || ".obsidian", "plugins", this.manifest.id];
		// __dirname 在移动端不存在 → 用空字符串 fallback（移动端走 vault adapter）
		const pluginDir = basePath
			? segments.filter(Boolean).join("/").replace(/\\/g, "/").replace(/([^:])\/+/g, "$1/")
			: "";
		const stateFilePath = basePath ? pluginDir + "/state.json" : ".obsidian/plugins/" + this.manifest.id + "/state.json";
		addLog("状态文件路径: " + stateFilePath);
		this.syncEngine = new SyncEngine(this.app.vault, token, {
			direction: this.settings.syncDirection as SyncDirection,
			remoteBasePath: this.settings.remotePath,
			localPrefix: this.settings.localPrefix,
			maxFileSize: this.settings.maxFileSize,
			clientId: this.settings.clientId,
			stateFilePath,
		});
		this.startAutoSync();
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
	 * 导出配置：优先剪贴板，失败则弹窗显示 JSON。
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
		} catch {
			// 移动端等不支持 clipboard API 的环境 → 弹窗显示
			new ExportModal(this.app, jsonStr).open();
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

		// 重载引擎（失败不阻止配置导入）
		try {
			this.reloadSyncEngine();
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			new Notice(`⚠️ 配置已保存，但引擎加载失败：${msg}`, 8000);
			console.warn("Dropbox Sync: 导入后重载引擎失败", err);
		}
		if (this.syncEngine) {
			new Notice("✅ 配置导入成功，引擎已就绪", 3000);
		} else {
			new Notice("⚠️ 配置已保存，但引擎未加载（检查 Token 是否有效）", 8000);
		}
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
					this.settings.lastSyncAt = result.lastSyncAt;
					await this.saveSettings();
					addLog("同步完成: " + JSON.stringify(result));
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

}
