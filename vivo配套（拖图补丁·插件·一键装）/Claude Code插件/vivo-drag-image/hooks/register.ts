// vivo 拖图提示：从 vivo 办公套件截图弹窗把手机截图拖进 Claude Code，终端交进来的只是一串 blob:file:///<编号>
// （vivo 内部地址，出了它打不开）。这张图在电脑硬盘上没有文件——vivo 只在点「复制」「保存」时才存图，拖图不存——
// 所以拿不到原图，也不能拿「最新一张」顶上（会拿成上一次复制的那张，2026-10-18 实际拿错过）。
// 这个插件在链接落进输入框那一下（prompt.edit，拖放在终端里就是一次粘贴）把链接删掉，弹一句提示：点复制再 Ctrl+V。
// 复制那条路是准的：桌宠「vivo 截图复制」板块把图存进中转夹，Ctrl+V 进来 Claude Code 自己显示成 [Image #N]。
// 2026-10-18 晚起 vivo 装了拖图补丁：拖出来是真文件，不走这里。
// 本插件正本在桌宠项目 app 夹 `vivo配套（拖图补丁·插件·一键装）\Claude Code插件\`，改那份再跑同夹 换电脑一键装.ps1 拷过来。
// 还拖出链接 = 弹窗出来不到 1 秒就拖（原图没下好），或补丁被 vivo 升级盖掉了。
import type { Register } from "claude-code";

const LINK = /blob:file:\/\/\/[0-9a-f-]{8,}/gi;
const HAS_LINK = /blob:file:\/\/\/[0-9a-f-]{8,}/i;

export const register: Register = (on) => {
  on("prompt.edit", async ($, e, next) => {
    if (!HAS_LINK.test(e.inputText)) return next(e);
    $.ui.toast("vivo 原图还没下好：弹窗出来等 1 秒再拖，或点「复制」再 Ctrl+V");
    return next({ ...e, inputText: e.inputText.replace(LINK, "") });
  });
};
