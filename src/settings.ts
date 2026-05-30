import { App, Modal, PluginSettingTab, Setting, Notice } from "obsidian";
import DropboxSyncPlugin from "./main";
import { isTokenValid, loadToken } from "./dropbox-auth";
import { getLogs, clearLogs } from "./sync-engine";

// ─── Settings Interface ──────────────────────────────────────────────────────

export interface DropboxSyncSettings {
	/** Dropbox App client ID (from Dropbox Developer Console) */
	clientId: string;
	/** OAuth token data (stored here by main.ts) */
	dropboxToken: Record<string, unknown> | null;
	/** Sync direction */
	syncDirection: string;
	/** Remote path in Dropbox */
	remotePath: string;
	/** Local vault path prefix to sync */
	localPrefix: string;
	/** Max file size in bytes (0 = no limit) */
	maxFileSize: number;
	/** Auto-sync on file save */
	syncOnSave: boolean;
	/** Last successful sync timestamp (ms) */
	lastSyncAt: number;
}

export const DEFAULT_SETTINGS: DropboxSyncSettings = {
	clientId: "",
	dropboxToken: null,
	syncDirection: "upload",
	remotePath: "/Apps/ObsidianSync",
	localPrefix: "",
	maxFileSize: 50 * 1024 * 1024, // 50 MB
	syncOnSave: true,
	lastSyncAt: 0,
};

// ─── Export Modal ────────────────────────────────────────────────────────────

/**
 * 导出配置的模态对话框 — 显示 JSON，用户可长按复制。
 */
export class ExportModal extends Modal {
	private jsonStr: string;

	constructor(app: App, jsonStr: string) {
		super(app);
		this.jsonStr = jsonStr;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "导出配置" });

		contentEl.createEl("p", {
			text: "请长按下方文本全选后复制，然后发送到另一台设备",
		});

		const textarea = contentEl.createEl("textarea", {
			attr: {
				readonly: "readonly",
				rows: "16",
				style: "width: 100%; font-family: monospace; font-size: 13px; box-sizing: border-box; resize: vertical; user-select: all;",
			},
		});
		textarea.value = this.jsonStr;

		contentEl.createEl("br");

		const closeBtn = contentEl.createEl("button", {
			text: "关闭",
			attr: { style: "cursor: pointer;" },
		});
		closeBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ─── Import Modal ────────────────────────────────────────────────────────────

/**
 * 导入配置的模态对话框 — 粘贴 JSON 后点击导入。
 */
class ImportModal extends Modal {
	private plugin: DropboxSyncPlugin;

	constructor(app: App, plugin: DropboxSyncPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl("h2", { text: "导入配置" });

		contentEl.createEl("p", {
			text: "请粘贴之前导出的配置 JSON（包含 App Key、Token 等全部设置）",
		});

		const textarea = contentEl.createEl("textarea", {
			attr: {
				rows: "12",
				style: "width: 100%; font-family: monospace; font-size: 13px; box-sizing: border-box; resize: vertical;",
				placeholder: "在此粘贴配置 JSON …",
			},
		});

		const btnContainer = contentEl.createDiv({
			attr: { style: "display: flex; gap: 8px; margin-top: 12px;" },
		});

		const importBtn = btnContainer.createEl("button", {
			text: "📥 导入",
			attr: { style: "flex: 1; cursor: pointer;" },
		});
		importBtn.addEventListener("click", async () => {
			const jsonStr = textarea.value.trim();
			if (!jsonStr) {
				new Notice("请先粘贴配置 JSON");
				return;
			}
			importBtn.disabled = true;
			importBtn.textContent = "导入中…";
			try {
				const ok = await this.plugin.importConfig(jsonStr);
				if (ok) {
					this.close();
					this.plugin.settingTab?.display();
				} else {
					importBtn.disabled = false;
					importBtn.textContent = "📥 导入";
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				new Notice(`❌ 导入失败：${msg}`, 8000);
				importBtn.disabled = false;
				importBtn.textContent = "📥 导入";
			}
		});

		const cancelBtn = btnContainer.createEl("button", {
			text: "取消",
			attr: { style: "flex: 1; cursor: pointer;" },
		});
		cancelBtn.addEventListener("click", () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

// ─── Settings Tab ────────────────────────────────────────────────────────────

export class SettingsTab extends PluginSettingTab {
	private plugin: DropboxSyncPlugin;

	constructor(app: App, plugin: DropboxSyncPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		try {
			containerEl.createEl("h2", { text: "Dropbox 同步" });

			// ── 授权 ──────────────────────────────────────────────────────────

			containerEl.createEl("h3", { text: "授权" });

			const token = loadToken(this.plugin.settings.dropboxToken);
			const isAuthed = isTokenValid(token);

			const statusEl = containerEl.createEl("div", {
				cls: `dropbox-sync-auth-status ${isAuthed ? "authorized" : "unauthorized"}`,
			});
			statusEl.textContent = isAuthed
				? "✅ 已授权 Dropbox"
				: "❌ 未授权 — 请在下方填写 App Key 并授权";

			new Setting(containerEl)
				.setName("Dropbox App Key")
				.setDesc(
					"在 https://www.dropbox.com/developers/apps 创建应用，复制 App Key 粘贴至此",
				)
				.addText((text) =>
					text
						.setPlaceholder("你的 Dropbox App Key")
						.setValue(this.plugin.settings.clientId)
						.onChange(async (value) => {
							this.plugin.settings.clientId = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl).addButton((btn) => {
				btn.setButtonText(isAuthed ? "重新授权" : "授权 Dropbox")
					.setCta()
					.onClick(async () => {
						if (!this.plugin.settings.clientId) {
							new Notice("请先填写 Dropbox App Key");
							return;
						}
						try {
							btn.setDisabled(true);
							btn.setButtonText("授权中…");
							await this.plugin.authorizeDropbox();
							new Notice("Dropbox 授权成功！");
							this.display();
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`授权失败：${msg}`, 8000);
						} finally {
							btn.setDisabled(false);
							this.display();
						}
					});
			});

			if (isAuthed) {
				new Setting(containerEl).addButton((btn) => {
					btn.setButtonText("撤销授权")
						.setWarning()
						.onClick(async () => {
							await this.plugin.revokeDropbox();
							new Notice("已撤销 Dropbox 授权");
							this.display();
						});
				});
			}

			// ── 同步设置 ──────────────────────────────────────────────────────

			containerEl.createEl("h3", { text: "同步设置" });

			new Setting(containerEl)
				.setName("同步方向")
				.setDesc("上传：库 → Dropbox（安全）。下载：Dropbox → 库。双向：两边合并。")
				.addDropdown((dropdown) =>
					dropdown
						.addOption("upload", "上传（库 → Dropbox）")
						.addOption("download", "下载（Dropbox → 库）")
						.addOption("two-way", "双向同步")
						.setValue(this.plugin.settings.syncDirection)
						.onChange(async (value) => {
							this.plugin.settings.syncDirection = value;
							await this.plugin.saveSettings();
							this.plugin.reloadSyncEngine();
						}),
				);

			new Setting(containerEl)
				.setName("远程路径")
				.setDesc("Dropbox 上的同步目录（例如 /Apps/ObsidianSync）")
				.addText((text) =>
					text
						.setPlaceholder("/Apps/ObsidianSync")
						.setValue(this.plugin.settings.remotePath)
						.onChange(async (value) => {
							const normalized = value.startsWith("/") ? value : "/" + value;
							this.plugin.settings.remotePath = normalized || "/Apps/ObsidianSync";
							await this.plugin.saveSettings();
							this.plugin.reloadSyncEngine();
						}),
				);

			new Setting(containerEl)
				.setName("本地路径前缀")
				.setDesc("只同步库的某个子文件夹（留空 = 整个库），例如「笔记」")
				.addText((text) =>
					text
						.setPlaceholder("留空则同步整个库")
						.setValue(this.plugin.settings.localPrefix)
						.onChange(async (value) => {
							this.plugin.settings.localPrefix = value;
							await this.plugin.saveSettings();
							this.plugin.reloadSyncEngine();
						}),
				);

			new Setting(containerEl)
				.setName("最大文件大小")
				.setDesc("超过此大小的文件将被跳过（0 = 不限制，默认 50MB）")
				.addText((text) =>
					text
						.setPlaceholder("52428800")
						.setValue(String(this.plugin.settings.maxFileSize))
						.onChange(async (value) => {
							const num = parseInt(value, 10);
							if (!isNaN(num) && num >= 0) {
								this.plugin.settings.maxFileSize = num;
								await this.plugin.saveSettings();
							}
						}),
				);

			new Setting(containerEl)
				.setName("保存时自动同步")
				.setDesc("文件在 Obsidian 中保存后自动上传到 Dropbox")
				.addToggle((toggle) =>
					toggle
						.setValue(this.plugin.settings.syncOnSave)
						.onChange(async (value) => {
							this.plugin.settings.syncOnSave = value;
							await this.plugin.saveSettings();
						}),
				);

			// ── 手动同步 ──────────────────────────────────────────────────────

			containerEl.createEl("h3", { text: "手动同步" });

			new Setting(containerEl).addButton((btn) => {
				btn.setButtonText("🔄 立即同步")
					.setCta()
					.onClick(async () => {
						if (!this.plugin.syncEngine) {
							new Notice("请先授权 Dropbox");
							return;
						}
						try {
							btn.setDisabled(true);
							btn.setButtonText("同步中…");
							const result = await this.plugin.syncEngine.syncNow();
							this.plugin.settings.lastSyncAt = result.lastSyncAt;
							await this.plugin.saveSettings();
							new Notice("同步完成！");
						} catch (err) {
							const msg = err instanceof Error ? err.message : String(err);
							new Notice(`同步失败：${msg}`, 8000);
						} finally {
							btn.setDisabled(false);
							btn.setButtonText("🔄 立即同步");
						}
					});
			});

			new Setting(containerEl).addButton((btn) => {
				btn.setButtonText("取消同步")
					.setWarning()
					.onClick(() => {
						this.plugin.syncEngine?.cancel();
						new Notice("同步已取消");
					});
			});

			// ── 配置导入导出 ──────────────────────────────────────────────────

			containerEl.createEl("h3", { text: "配置导入导出" });

			new Setting(containerEl)
				.setName("导出配置到剪贴板")
				.setDesc("将当前所有设置（包括 Token）复制到剪贴板，可在另一台设备上导入")
				.addButton((btn) =>
					btn.setButtonText("📋 导出配置")
						.setCta()
						.onClick(async () => {
							await this.plugin.exportConfigToClipboard();
						}),
				);

			new Setting(containerEl)
				.setName("从剪贴板导入配置")
				.setDesc("粘贴之前导出的 JSON 配置，覆盖当前所有设置")
				.addButton((btn) =>
					btn.setButtonText("📥 导入配置")
						.onClick(() => {
							const modal = new ImportModal(this.app, this.plugin);
							modal.open();
						}),
				);

			// ── 同步日志 ──────────────────────────────────────────────────────

			containerEl.createEl("h3", { text: "同步日志" });

			const logContainer = containerEl.createDiv();
			const logTextarea = logContainer.createEl("textarea", {
				attr: {
					readonly: "readonly",
					rows: "10",
					style: "width: 100%; font-family: monospace; font-size: 12px; box-sizing: border-box; resize: vertical; white-space: pre;",
				},
			});
			logTextarea.value = getLogs().join("\n");

			const refreshBtn = logContainer.createEl("button", {
				text: "🔄 刷新日志",
				attr: { style: "cursor: pointer; margin-right: 8px;" },
			});
			refreshBtn.addEventListener("click", () => {
				logTextarea.value = getLogs().join("\n");
				logTextarea.scrollTop = logTextarea.scrollHeight;
			});

			const clearBtn = logContainer.createEl("button", {
				text: "🗑 清空",
				attr: { style: "cursor: pointer;" },
			});
			clearBtn.addEventListener("click", () => {
				clearLogs();
				logTextarea.value = "";
			});

			// ── 设置说明 ──────────────────────────────────────────────────────

			containerEl.createEl("h3", { text: "设置步骤" });
			const infoEl = containerEl.createEl("div", { cls: "setting-item-description" });
			infoEl.innerHTML = `
				<ol>
					<li>前往 <a href="https://www.dropbox.com/developers/apps" target="_blank">Dropbox 开发者控制台</a></li>
					<li>创建新应用 → "Scoped access" → "App folder" 或 "Full Dropbox"</li>
					<li>在 <strong>Permissions</strong> 标签页勾选：<code>files.metadata.read</code>、<code>files.content.read</code>、<code>files.content.write</code></li>
					<li>在 <strong>OAuth 2</strong> 中设置重定向 URI：<code>http://127.0.0.1:54219/</code></li>
					<li>复制 <strong>App Key</strong> 粘贴到上方输入框</li>
					<li>点击 "授权 Dropbox" → 在浏览器中完成授权</li>
					<li>授权后浏览器跳转到 <code>http://127.0.0.1:54219/</code>（显示无法访问 — 正常）</li>
					<li>复制浏览器地址栏的完整网址 → 回到 Obsidian → 粘贴到弹出的对话框</li>
				</ol>
				<p>授权后，你的库会自动同步到 Dropbox 的 <code>${this.plugin.settings.remotePath}/</code> 目录。</p>
			`;
		} catch (err) {
			console.error("Dropbox Sync: display error", err);
		}
	}
}
