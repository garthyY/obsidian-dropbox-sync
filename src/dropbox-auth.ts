import {
	requestUrl,
	Notice,
	Platform,
} from "obsidian";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DropboxToken {
	access_token: string;
	refresh_token: string;
	expires_at: number;
	account_id?: string;
}

export interface DropboxAuthConfig {
	clientId: string;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	account_id?: string;
	token_type: string;
}

interface ErrorResponse {
	error: string;
	error_description?: string;
}

// ─── PKCE ────────────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
	const charset = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
	const array = new Uint8Array(64);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => charset[byte % charset.length]).join("");
}

async function generateCodeChallenge(verifier: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(verifier);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return btoa(String.fromCharCode(...new Uint8Array(digest)))
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

// ─── Token Persistence ───────────────────────────────────────────────────────

export function loadToken(raw: Record<string, unknown> | null | undefined): DropboxToken | null {
	if (!raw || typeof raw !== "object") return null;
	const t = raw as Record<string, unknown>;
	if (
		typeof t.access_token !== "string" ||
		typeof t.refresh_token !== "string" ||
		typeof t.expires_at !== "number"
	) {
		return null;
	}
	return {
		access_token: t.access_token,
		refresh_token: t.refresh_token,
		expires_at: t.expires_at,
		account_id: typeof t.account_id === "string" ? t.account_id : undefined,
	};
}

export function saveToken(token: DropboxToken): Record<string, unknown> {
	return {
		dropboxToken: {
			access_token: token.access_token,
			refresh_token: token.refresh_token,
			expires_at: token.expires_at,
			account_id: token.account_id ?? undefined,
		},
	};
}

export function clearToken(): Record<string, unknown> {
	return { dropboxToken: null };
}

// ─── Token Validity ──────────────────────────────────────────────────────────

export function isTokenExpired(token: DropboxToken): boolean {
	return Date.now() >= token.expires_at - 300_000;
}

export function isTokenValid(token: DropboxToken | null): token is DropboxToken {
	if (!token) return false;
	return !!token.access_token && !!token.refresh_token;
}

// ─── 常量 ────────────────────────────────────────────────────────────────────

const REDIRECT_PORT = 54219;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/`;

// ─── OAuth 流程（自动 + 手动回退） ─────────────────────────────────────────

export async function authorize(config: DropboxAuthConfig): Promise<DropboxToken> {
	const verifier = generateCodeVerifier();
	const challenge = await generateCodeChallenge(verifier);
	const state = generateCodeVerifier();

	// 1) 尝试启动本地 HTTP 服务器
	let serverResult: { promise: Promise<{ code: string; state: string }> } | null = null;
	try {
		console.log("Dropbox Sync: 尝试启动本地 HTTP 服务器...");
		serverResult = await startHttpServer();
		console.log("Dropbox Sync: 本地服务器已启动，端口", REDIRECT_PORT);
	} catch (err) {
		console.warn("Dropbox Sync: 本地服务器启动失败，将使用手动模式", err);
	}

	// 2) 构建授权 URL 并打开浏览器
	const scopes = "files.metadata.read files.content.read files.content.write";
	const authUrl =
		`https://www.dropbox.com/oauth2/authorize` +
		`?client_id=${encodeURIComponent(config.clientId)}` +
		`&response_type=code` +
		`&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
		`&code_challenge=${encodeURIComponent(challenge)}` +
		`&code_challenge_method=S256` +
		`&state=${encodeURIComponent(state)}` +
		`&token_access_type=offline` +
		`&scope=${encodeURIComponent(scopes)}`;

	new Notice("正在打开浏览器进行 Dropbox 授权…");
	openUrl(authUrl);

	// 3) 等待授权码
	let code: string;
	if (serverResult) {
		// 自动模式：等本地服务器接收回调
		console.log("Dropbox Sync: 等待本地回调...");
		const result = await serverResult.promise;
		if (result.state !== state) {
			throw new Error("State 不匹配 — 可能是 CSRF 攻击");
		}
		code = result.code;
		console.log("Dropbox Sync: 通过本地服务器收到授权码");
	} else {
		// 手动模式：让用户粘贴回调 URL
		code = await promptForCode(state);
	}

	return await exchangeCodeForToken(config.clientId, REDIRECT_URI, verifier, code);
}

// ─── 方案 A：自动 — 本地 HTTP 服务器 ──────────────────────────────────────

async function startHttpServer(): Promise<{ promise: Promise<{ code: string; state: string }> }> {
	let resolveCode: (v: { code: string; state: string }) => void;
	let rejectCode: (e: Error) => void;
	const codePromise = new Promise<{ code: string; state: string }>((res, rej) => {
		resolveCode = res;
		rejectCode = rej;
	});

	const http = require("http");
	const url_mod = require("url");
	console.log("Dropbox Sync: require('http') 成功");

	const server = http.createServer((req: any, res: any) => {
		const parsed = url_mod.parse(req.url || "", true);
		const code = parsed.query.code as string;
		const state = parsed.query.state as string;
		console.log("Dropbox Sync: 收到回调", req.url);

		if (code) {
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<html><body><h2>✓ 授权成功！</h2><p>你可以关闭此页面了。</p></body></html>`);
			server.close();
			resolveCode({ code, state });
		} else {
			res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
			res.end(`<html><body><h2>✗ 授权失败</h2><p>未收到授权码。</p></body></html>`);
			server.close();
			rejectCode(new Error("未收到授权码"));
		}
	});

	// 等待服务器确认启动成功
	await new Promise<void>((resolve, reject) => {
		server.on("error", (err: Error) => {
			console.error("Dropbox Sync: 服务器错误", err);
			reject(err);
		});
		server.listen(REDIRECT_PORT, "127.0.0.1", () => {
			console.log("Dropbox Sync: 服务器已启动", REDIRECT_PORT);
			resolve();
		});
	});

	return { promise: codePromise };
}

// ─── 方案 B：手动 — 用户粘贴回调 URL ─────────────────────────────────────

async function promptForCode(expectedState: string): Promise<string> {
	const message =
		"✅ Dropbox 授权窗口已打开\n\n" +
		"1. 在浏览器中完成授权\n" +
		"2. 授权后浏览器会跳转到 http://127.0.0.1:54219/ （页面无法访问是正常的）\n" +
		"3. 复制浏览器地址栏的完整网址\n" +
		"4. 点击确定，粘贴到下面的输入框\n\n" +
		"如误关了浏览器，点击「取消」后重新授权。";

	const url = prompt(message);
	if (!url) {
		throw new Error("用户取消了授权");
	}

	try {
		const parsed = new URL(url);
		const code = parsed.searchParams.get("code");
		const state = parsed.searchParams.get("state");

		if (!code) {
			throw new Error("网址中未找到授权码 (code)，请确认复制的是完整地址栏内容");
		}
		if (state !== expectedState) {
			throw new Error("State 不匹配 — 可能是 CSRF 攻击，请重新授权");
		}
		return code;
	} catch (err) {
		if (err instanceof TypeError && err.message.includes("URL")) {
			throw new Error("网址格式不正确，请复制浏览器地址栏整段内容");
		}
		throw err;
	}
}

// ─── Dropbox API ─────────────────────────────────────────────────────────────

async function exchangeCodeForToken(
	clientId: string,
	redirectUri: string,
	codeVerifier: string,
	code: string,
): Promise<DropboxToken> {
	const body = new URLSearchParams({
		code,
		grant_type: "authorization_code",
		client_id: clientId,
		redirect_uri: redirectUri,
		code_verifier: codeVerifier,
	});

	const response = await requestUrl({
		url: "https://api.dropboxapi.com/oauth2/token",
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (response.status !== 200) {
		const err = JSON.parse(response.text) as ErrorResponse;
		throw new Error(`Dropbox 授权错误：${err.error} — ${err.error_description ?? ""}`);
	}

	const data = JSON.parse(response.text) as TokenResponse;
	return {
		access_token: data.access_token,
		refresh_token: data.refresh_token ?? "",
		expires_at: Date.now() + data.expires_in * 1000,
		account_id: data.account_id,
	};
}

export async function refreshToken(
	clientId: string,
	token: DropboxToken,
): Promise<DropboxToken> {
	if (!token.refresh_token) {
		throw new Error("没有 refresh token — 请重新授权");
	}

	const body = new URLSearchParams({
		refresh_token: token.refresh_token,
		grant_type: "refresh_token",
		client_id: clientId,
	});

	const response = await requestUrl({
		url: "https://api.dropboxapi.com/oauth2/token",
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: body.toString(),
	});

	if (response.status !== 200) {
		const err = JSON.parse(response.text) as ErrorResponse;
		throw new Error(`刷新 token 失败：${err.error} — ${err.error_description ?? ""}`);
	}

	const data = JSON.parse(response.text) as TokenResponse;
	return {
		access_token: data.access_token,
		refresh_token: data.refresh_token ?? token.refresh_token,
		expires_at: Date.now() + data.expires_in * 1000,
		account_id: data.account_id ?? token.account_id,
	};
}

// ─── 工具 ────────────────────────────────────────────────────────────────────

function openUrl(url: string): void {
	if (Platform.isDesktop) {
		const { shell } = require("electron");
		shell.openExternal(url);
	} else {
		window.open(url, "_blank");
	}
}
