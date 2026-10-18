/**
 * 图片块 + vivo 拖图提示 —— 让 Pi 的输入框里，图片显示成一个 `[Image #1]` 块，一按退格整块删，不再是一长串路径。
 *
 * 管三种进图的路：
 *   1. Ctrl+V：桌宠的「vivo 截图复制」板块已经把图存进中转夹、把文件位置放进剪贴板，贴进来是一串 D:\…jpg → 变成块
 *   2. Alt+V：Pi 自己读剪贴板，插进来的也是一串图片位置 → 变成块
 *   3. 从 vivo 办公套件截图弹窗拖图：终端交进来的只是 blob:file:///<编号>（vivo 内部地址，出了它打不开）→ 删掉、弹提示
 * 按回车发出去那一刻，块换回真图片位置（模型用 read 打开）。
 *
 * 🚨 拖图为什么不换成图（2026-10-18 查实）：vivo 弹窗里的截图在电脑硬盘上没有文件，只有点「复制」「保存」vivo 才存图，
 * 拖图不存。拿「最新一张」顶上会拿成上一次复制的那张（他拖「金蛋骗局」收到「MoMo侠」就是这么来的）。宁可提示，不给错图。
 * 2026-10-18 晚起 vivo 装了拖图补丁：拖出来是真文件路径，走第 1 条变成块。
 * 本文件正本在桌宠项目 app 夹 `vivo配套（拖图补丁·插件·一键装）\Pi插件\`，改那份再跑同夹 换电脑一键装.ps1 拷过来；整套说明在桌宠项目「vivo截图（…）」夹。
 * 还拖出链接 = 弹窗出来不到 1 秒就拖（原图没下好），或补丁被 vivo 升级盖掉了。
 *
 * 做法：换掉 Pi 的输入框（setEditorComponent），在它自带输入框上加三处：
 *   - handlePaste / insertTextAtCursor：进来的是图片路径 → 记下来、插一个块；是 blob 链接 → 删掉、提示
 *   - segment：把块切成一个整体（Pi 自己的大段粘贴块 [paste #1] 就是这么做到一按退格整块删的）
 *   - expandPasteMarkers：发出去时块换回路径
 * 兜底：发出去时消息里还有 blob 链接（换输入框失败），input 事件删掉链接、提示。任何出错原样放行，不卡住发消息。
 * 2026-10-18 用户要的：「派里边也要显示成这样……能一键删掉，不然我一删一堆链接」。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";

const LINK = /blob:file:\/\/\/[0-9a-f-]{8,}/gi;
const HAS_LINK = /blob:file:\/\/\/[0-9a-f-]{8,}/i;
const IMAGE_PATH = /^[a-z]:\\[^\r\n]+\.(jpe?g|png|webp|gif|bmp)$/i;
const BLOCK = /\[Image #(\d+)\]/g;
const DRAG_HINT = "vivo 原图还没下好：弹窗出来等 1 秒再拖，或点「复制」再 Ctrl+V";

let notify: (message: string) => void = () => {};

/** 一段进来的字是不是全是图片路径（一行一个，可带引号）。是就给路径，不是给 null。 */
function imagePathsIn(text: string): string[] | null {
	const lines = text.trim().split(/\r?\n/).map((line) => line.trim().replace(/^"(.*)"$/, "$1")).filter(Boolean);
	if (lines.length && lines.every((line) => IMAGE_PATH.test(line) && existsSync(line))) return lines;
	return null;
}

export class ImageBlockEditor extends CustomEditor {
	private images = new Map<number, string>();
	private imageCounter = 0;

	private insertBlocks(paths: string[]): void {
		const blocks = paths.map((path) => {
			this.imageCounter += 1;
			this.images.set(this.imageCounter, path);
			return `[Image #${this.imageCounter}]`;
		});
		super.handlePaste(blocks.join(" "));
	}

	/** 返回 true 表示这段已经处理掉了。 */
	private takeOver(text: string): boolean {
		if (HAS_LINK.test(text)) {
			notify(DRAG_HINT);
			const rest = text.replace(LINK, "").trim();
			if (rest) super.handlePaste(rest);
			return true;
		}
		const paths = imagePathsIn(text);
		if (!paths) return false;
		this.insertBlocks(paths);
		return true;
	}

	handlePaste(pastedText: string): void {
		if (!this.takeOver(pastedText)) super.handlePaste(pastedText);
	}

	insertTextAtCursor(text: string): void {
		if (!this.takeOver(text)) super.insertTextAtCursor(text);
	}

	segment(text: string, mode?: any): any {
		const base = super.segment(text, mode);
		if (!this.images.size || !text.includes("[Image #")) return base;
		const spans: { start: number; end: number }[] = [];
		for (const match of text.matchAll(BLOCK)) {
			if (this.images.has(Number(match[1]))) spans.push({ start: match.index!, end: match.index! + match[0].length });
		}
		if (!spans.length) return base;
		const out: any[] = [];
		let at = 0;
		for (const seg of base) {
			while (at < spans.length && spans[at].end <= seg.index) at += 1;
			const span = spans[at];
			if (span && seg.index >= span.start && seg.index < span.end) {
				if (seg.index === span.start) out.push({ segment: text.slice(span.start, span.end), index: span.start, input: text });
				continue;
			}
			out.push(seg);
		}
		return out;
	}

	expandPasteMarkers(text: string): string {
		const expanded = super.expandPasteMarkers(text);
		return expanded.replace(BLOCK, (block, id) => this.images.get(Number(id)) ?? block);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event: any, ctx: any) => {
		try {
			if (!ctx.hasUI) return;
			notify = (message) => ctx.ui.notify(message, "warning");
			ctx.ui.setEditorComponent((tui: any, theme: any, keybindings: any) => new ImageBlockEditor(tui, theme, keybindings));
		} catch {
			// 换不了输入框就算了，下面 input 事件照样兜底
		}
	});

	pi.on("input", (event) => {
		try {
			if (!HAS_LINK.test(event.text)) return { action: "continue" };
			notify(DRAG_HINT);
			return { action: "transform", text: `${event.text.replace(LINK, "").trim()}\n\n（用户从 vivo 拖了截图进来，但只拖出链接、拿不到原图；请提醒他弹窗出来等 1 秒再拖，或点「复制」再 Ctrl+V；老这样就是 vivo 升级把拖图补丁盖掉了，双击桌宠项目里的 E:\\个人AI资源管理\\10_按项目存放（某个项目专用的脚本和资料）\\01_手作园（自己从0搓的·应用网页工具）\\应用\\多Agent桌面宠物（统一通知与权限说明）\\app（Electron本体·带git）\\vivo配套（拖图补丁·插件·一键装）\\拖图补丁\\双击装补丁.cmd 重装。）` };
		} catch {
			return { action: "continue" };
		}
	});
}
