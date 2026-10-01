---
name: 多Agent桌面宠物
description: 用一株像素幼苗替多个本机 Agent 值班的透明悬浮界面
colors:
  night-ink: "#15241c"
  soft-ink: "#24392b"
  night-forest: "#0f1c15"
  panel-surface: "rgba(15, 28, 21, 0.985)"
  note-surface: "rgba(15, 28, 21, 0.94)"
  paper: "#f3f5e9"
  paper-muted: "#b9c7b6"
  hairline: "rgba(225, 239, 218, 0.15)"
  sunlight: "#f2c84b"
  danger-coral: "#ed8065"
  healthy-green: "#8fdb78"
  sprout-light: "#b9e86f"
  sprout: "#75c85d"
  sprout-deep: "#3f8d47"
  sprout-shadow: "#285d38"
typography:
  headline:
    fontFamily: "Segoe UI Variable, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Segoe UI Variable, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "13px"
    fontWeight: 620
    lineHeight: 1.45
  body:
    fontFamily: "Segoe UI Variable, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "Segoe UI Variable, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.45
  micro:
    fontFamily: "Segoe UI Variable, Microsoft YaHei UI, Microsoft YaHei, sans-serif"
    fontSize: "10px"
    fontWeight: 400
    lineHeight: 1.45
rounded:
  pixel: "4px"
  control: "8px"
  field: "11px"
  note: "12px 12px 4px 12px"
  panel: "16px 16px 6px 16px"
  pill: "999px"
spacing:
  pixel: "4px"
  tight: "6px"
  control-gap: "7px"
  panel: "18px"
components:
  primary-action:
    backgroundColor: "{colors.sprout-light}"
    textColor: "{colors.night-forest}"
    rounded: "{rounded.field}"
    padding: "11px 14px"
    width: "100%"
  secondary-action:
    backgroundColor: "transparent"
    textColor: "{colors.paper}"
    rounded: "{rounded.field}"
    padding: "9px 12px"
    width: "100%"
  compact-option:
    backgroundColor: "rgba(255, 255, 255, 0.035)"
    textColor: "{colors.paper-muted}"
    rounded: "{rounded.control}"
    height: "32px"
---

# Design System: 多Agent桌面宠物

## Overview

**Creative North Star: "夜林里的像素值班幼苗"**

已发货界面把 Agent 状态压缩成一株常驻桌面的绿色幼苗：先看姿态和信笺色点判断是否要回来，再展开询问／权限处理面板或现场索引。深夜林半透明面板像悬在幼苗上方的纸签，Windows 原生中文字负责快速判断，像素轮廓负责记忆和生命感。

视觉反面是光滑矢量吉祥物、死板机器人、带窗口框的桌面软件和通用 SaaS 仪表盘。信息可以密集，但不能抢走幼苗作为第一状态信号的地位，也不能用装饰性图表代替明确中文。

**Key Characteristics:**
- 透明、无框、始终置顶的桌面层，而不是独立应用画布。
- 以 4px 像素模数搭出的幼苗，硬边细节配少量柔和环境阴影。
- 夜林黑、嫩芽绿、纸白和一粒日光黄；珊瑚红只承担失败或高风险。
- 操作面板克制、紧凑、靠右下生长，幼苗在复杂界面中仍然留场。

## Colors

颜色值以前置 token 为准。主世界由近黑森林表面、纸白文字和四级幼苗绿组成；黄色表示等待、风险和工作火花，红色只表示错误或高风险，健康绿表示连接、工作、选中与键盘焦点。

**The Signal Color Rule.** 黄、红和健康绿必须继续表达状态，不得降级成无含义装饰；同一视图不要另造竞争色。

**The Transparent Forest Rule.** 面板使用近乎不透明的夜林表面来保证桌面背景上的可读性；系统要求减少透明度时，退回纯夜林色，不改变层级。

## Typography

**Display and body font:** `Segoe UI Variable`，依次回退到 `Microsoft YaHei UI`、`Microsoft YaHei` 和系统无衬线体。

字体是 Windows 原生、直白、紧凑的，不引入品牌展示字体。22px 用于抽屉主标题，20-21px 用于设置和权限标题；13px 半粗体是状态信笺主句；12px 是详情正文；11px 是标签、页签和辅助文案；10px 是状态、时间与元数据。标题使用轻微负字距，数字百分比使用等宽数字。主操作沿用 16px 默认字号和 760 粗度。

**The Native Clarity Rule.** 不用像素字体承载中文和权限说明；像素感只属于幼苗几何，文字始终以系统字体保证扫读。

## Layout

> ⚠️ **本节是幼苗时代（v0.1.14 前后）的布局，已过期**（2026-10-01 体检时标的）。幼苗 2026-08-14 已去掉，现在是右上角木框小窗（物理 480×270）；询问／权限／完成面板高度跟着内容走，最高 740。现行布局以 `src/pet/AGENTS.md` 和项目根 `00_叫什么（咱俩说话的统一叫法）.md` 为准。

Electron 窗口固定为 440×680px、不可缩放，首次放在主屏工作区右下方，距右 28px、距下 22px。点一下幼苗会进入拿起状态，窗口按绝对鼠标位置跟随，再点一下放下；没有移动按钮、拖动条或回右下角。移动后 300ms 保存 `x/y` 到 `%APPDATA%/AgentPetHub/data/preferences.json`，退出前再立即保存一次。再次启动或显示器变化时只要求 140% 幼苗保持可见，因此透明窗口可以伸出屏幕，让幼苗真正到达屏幕边缘。窗口关闭默认隐藏到托盘，不退出。

默认幼苗区为 196×284px，距窗口右 18px、下 14px；幼苗按钮为 152×176px，位于区内左 22px、下 28px。状态信笺宽 188px、最小高 80px。统一询问／权限处理面板与现场索引都是 400×638px、距右下各 20px；处理面板正文单独滚动，底部关闭和确认固定可见。设置面板 360px 宽、距右 20px、下 300px，为 140% 幼苗预留不相撞的试演区。

幼苗缩放范围 70%-140%，步进 5%，只缩放幼苗本体，不改变窗口、信笺或面板。缩放值和活泼程度共同保存在 `localStorage` 的 `agent-pet:appearance`；默认 100% 和“活泼”。抽屉展开时幼苗额外缩到用户尺寸的 62%，向右 18px、向下 2px，只作视觉陪伴。

窗口背景完全透明；Windows 原生窗口形状平时只覆盖幼苗、信笺和控制区，所以其余透明区域从系统层面不参与命中，不再依赖容易卡死的动态鼠标穿透。拿起幼苗或展开面板时暂时使用完整窗口形状；面板打开前把整窗拉回可见工作区，关闭后再恢复幼苗原位置。系统窗口无框、无系统阴影、不进任务栏，以 `floating` 级别始终置顶，并显示在所有工作区和全屏空间。内部层级依次为幼苗 3、信笺 5、控制条 6、面板 10。

## Elevation & Depth

深度来自“硬像素近景 + 柔和悬浮远景”的混合：幼苗使用 4px 内嵌高光、4px 硬投影和低透明环境投影；信笺和面板使用大范围暗色环境阴影、1px 顶部内高光、细边框和背景模糊。应用窗口本身没有原生阴影。

状态信笺与面板都采用右下角更小的纸签式角，信笺再用三块 10px 方形拼出像素尾巴。不要把每个列表行做成浮卡；列表靠细分隔线和文字层级组织。

**The One Floating Plane Rule.** 同一时刻只展开处理面板、现场索引或设置面板中的一层；三者互斥。关闭处理面板只收起，不等于回答，待处理事项仍可从会话索引重新打开。

## Shapes

幼苗由 4px 网格、直角块、阶梯式 `clip-path` 和方形五官组成；84×86px 主体是核心轮廓，叶、茎、手脚与工作火花都服从同一像素模数。应用图标延续方形幼苗与深林圆角底，但角色本体不能被平滑成圆润矢量。

操作层使用两套形状：纸签面板是 16/16/6/16px 非对称圆角，状态信笺是 12/12/4/12px；字段和主按钮为 11px，风险和微型控制使用全圆胶囊。圆角属于容器，状态点、像素尾巴和幼苗细节保持方形；会话状态点是唯一固定圆点。

## Components

### Status Note

188px 宽的可点击总览，顶行是 Agent 名和 7px 状态点，中间是 13px 主句，底部是 10px 状态标签。悬停上移 2px，按下回落并缩至 98%；等待点用日光黄，错误点用珊瑚红，完成用浅芽绿，其余健康状态用健康绿。

### Interaction Panel

询问和权限共用同一个非模态处理面板：顶部是小号 Agent 名、类型胶囊和关闭；正文是直接标题、一段完整口语说明、Agent 本次真实给出的动态选项，以及事件支持时出现的“自己输入”；底部固定关闭和确认。询问说明按“现状、原因、建议、影响、让用户选择”组织；权限说明用同样口气说清为什么要权限、具体动作和范围、负面影响、回退和未核实项。确认提交后先等 Agent 真正接收，成功才关闭；不支持桌宠回传时禁用确认并明确回原窗口，绝不放假按钮。

### Drawer, Settings, and Controls

现场索引使用标题、搜索框、三页签、单列分隔列表和底部全宽次操作；待处理会话行可重新打开对应面板。页签选中态是 2px 健康绿底线。搜索框聚焦时边框变绿并出现 3px 低透明焦点环。设置面板只保留幼苗大小和安静／自然／活泼三档；动作不提供手动试演。幼苗下方的详情／设置／隐藏胶囊只在幼苗区悬停或获得焦点时出现；移动直接点幼苗本体。

所有按钮和输入保留 2px 健康绿 `:focus-visible` 外框与 2px 偏移；页签支持左右方向键。新增交互必须有语义名称和键盘路径。当前 10-11px 辅助文字已经是密度下限，不得再缩小。

### Pet Poses and State Mapping

已发货姿态按状态语义维护：`idle` 呼吸、摆叶和眨眼；`thinking` 左右思索并显示省略号；`running` 原地颠步、交替手脚并冒黄工作像素；`working-focus` 低头专注；`working-rope` 用力拉扯；`waving` 抬右手、微笑并抬叶；`jumping` 是两次离地庆祝；`waiting` 垂叶、圆嘴、轻倾并显示问号；`failed` 下沉、降饱和、垂叶、斜眼且胸灯转红；`review` 只作为空闲环境变化。

六个后端状态映射固定为：`idle -> idle`，`thinking -> thinking`，`working -> running`，`waiting -> waiting`，`done -> waving`，`error -> failed`。首次进入完成态先播放 `jumping` 1450ms，再落到 `waving`。工作态按活泼程度自动轮换 `running`、`working-focus` 和 `working-rope`；面板开关和窗口移动不再手动覆盖 Agent 状态动作。

### Motion and Liveliness

“安静”停止环境随机动作，并把待机周期放慢到 3.2s、工作周期放慢到 0.78s；“自然”使用 2.4s 待机和 0.46s 工作，空闲约每 10s 变化一次、工作约每 6s 换一次姿态；默认“活泼”使用 1.55s 待机和 0.32s 工作，空闲约每 5.5s 触发挥手、跳跃或查看，工作约每 3.6s 在三套动作间轮换。动作采用 `steps()` 保持像素节奏，面板进场采用短促平滑缓动。

Windows 关闭动画或 `prefers-reduced-motion` 开启时，“安静”模式把动画和过渡压缩为单帧；用户明确选择“自然”或“活泼”时，只为这株幼苗重新开启动作，不改系统设置。`prefers-reduced-transparency` 开启时取消模糊并使用纯色面板。关键状态不能只靠动画表达，姿态轮廓、文字和颜色必须同时成立。

## Do's and Don'ts

### Do:
- **Do** 先从真实状态、中文任务和风险角色出发，再选择姿态、色点和文案。
- **Do** 为每个新后端状态同时定义状态文案、标签、色点、自动姿态映射和减少动画时的静态读法。
- **Do** 保持 4px 幼苗几何、右下生长方向、单列信息层级和 Windows 系统字体。
- **Do** 在改窗口或面板尺寸时同时检查 70%-140% 幼苗、询问／权限面板、抽屉、设置、原生窗口形状和屏幕边缘裁切。
- **Do** 保持等待和错误高于庆祝和环境动作。

### Don't:
- **Don't** 把幼苗替换成机器人、光滑矢量角色、3D 公仔或通用头像。
- **Don't** 引入完整窗口底色、标题栏、侧边导航、卡片矩阵、渐变或无状态含义的亮色。
- **Don't** 让透明空白区域拦截桌面点击，也不要让展开面板盖住幼苗的必要陪伴位置。
- **Don't** 用持续弹跳、发光或平滑漂浮破坏 `steps()` 像素节奏；必须尊重两种系统减少偏好。
- **Don't** 重新加入移动按钮、拖动条、回右下角、左右跑反馈或手动动作试演。
- **Don't** 只改 CSS 姿态而漏改六状态映射、动作优先级和持久化约束。
