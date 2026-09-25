// 贴图编辑块：沿用 textarea 的存档接口；有图时显示可直接编辑的图文框。
// 图片标记只在存档中使用，界面以真实缩略图呈现。全程不渲染外来 HTML。
let bmImagesBusy = 0;
const bmImageCache = new Map();

function bmFlushImageRefresh() {
  if (!bmImagesBusy && bmRefreshPending) { bmRefreshPending = false; void bmRefresh(); }
}
function bmImageParts(text) {
  return [...text.matchAll(/\[图片:(image-[a-zA-Z0-9-]+\.png)\]/g)];
}
function bmImageText(node) {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || "";
  if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return "";
  if (node.dataset?.imageMarker) return node.dataset.imageMarker;
  if (node.nodeName === "BR") return "\n";
  let value = "";
  for (const child of node.childNodes) {
    if (/^(DIV|P)$/.test(child.nodeName) && value && !value.endsWith("\n")) value += "\n";
    value += bmImageText(child);
  }
  return value;
}
function bmImageSelection(rich) {
  const sel = window.getSelection();
  if (!sel?.rangeCount || !rich.contains(sel.anchorNode) || !rich.contains(sel.focusNode)) return [bmImageText(rich).length, bmImageText(rich).length];
  const range = sel.getRangeAt(0);
  const before = document.createRange();
  before.selectNodeContents(rich);
  before.setEnd(range.startContainer, range.startOffset);
  const start = bmImageText(before.cloneContents()).length;
  before.setEnd(range.endContainer, range.endOffset);
  return [start, bmImageText(before.cloneContents()).length];
}
function bmImageCaret(rich, start, end = start) {
  const point = (offset) => {
    let left = offset;
    const walk = (parent) => {
      for (const child of parent.childNodes) {
        const length = bmImageText(child).length;
        if (child.nodeType === Node.TEXT_NODE && left <= length) return [child, left];
        if (child.dataset?.imageMarker || child.nodeName === "BR") {
          if (left <= length) return [parent, Array.prototype.indexOf.call(parent.childNodes, child) + (left ? 1 : 0)];
        } else if (child.nodeType === Node.ELEMENT_NODE && left <= length) return walk(child);
        left -= length;
      }
      return [parent, parent.childNodes.length];
    };
    return walk(rich);
  };
  const a = point(start), b = point(end);
  const range = document.createRange();
  range.setStart(...a); range.setEnd(...b);
  const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
}
function bmEditorHasFocus(input) {
  return document.activeElement === input || (!!input?.bmRich && document.activeElement === input.bmRich);
}
function bmActiveImageInput() {
  return document.activeElement?.bmSource || document.activeElement;
}
async function bmImageSource(name) {
  if (!bmImageCache.has(name)) {
    const promise = window.bookmark.readImage(name).catch((error) => { bmImageCache.delete(name); throw error; });
    bmImageCache.set(name, promise);
    if (bmImageCache.size > 64) bmImageCache.delete(bmImageCache.keys().next().value);
  }
  return bmImageCache.get(name);
}
// 图片标注（设定16第三版，2026-09-24 用户：学 ChatGPT 那样打开就能标、工具常驻、按编号告诉 AI）：
// 打开大图就能标；工具只留编号 / 框 / 箭头；全图一套流水号；说明写在图下面、一个编号一行；
// 标注不烧进原图，边改边自动存（主进程另存一张带编号的给 AI）；没有保存按钮。
// 标注颜色：马卡龙橙红（2026-09-24 用户：原来的大红太扎眼，要偏艳一点的橙红）。
const BM_MARK_RED = "#f76c55";
const BM_MARK_NUMBERS = "①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳";
function bmMarkLabel(index) { return BM_MARK_NUMBERS[index] || `(${index + 1})`; }
function bmMarkAnchor(mark) {
  if (mark.kind === "box") return { x: Math.min(mark.x, mark.endX), y: Math.min(mark.y, mark.endY) };
  return { x: mark.x, y: mark.y };
}
// w/h 是画布像素；s＝一个屏幕像素折几个画布像素，线粗和编号大小跟屏幕上看到的一样。
function bmDrawMarks(ctx, w, h, marks, s, selected = -1) {
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  marks.forEach((mark, index) => {
    const x = mark.x * w, y = mark.y * h, ex = mark.endX * w, ey = mark.endY * h;
    ctx.strokeStyle = BM_MARK_RED; ctx.lineWidth = 3 * s;
    if (mark.kind === "box") {
      ctx.beginPath(); ctx.rect(Math.min(x, ex), Math.min(y, ey), Math.abs(ex - x), Math.abs(ey - y)); ctx.stroke();
    } else if (mark.kind === "arrow") {
      const angle = Math.atan2(ey - y, ex - x), head = 13 * s;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey);
      ctx.moveTo(ex, ey); ctx.lineTo(ex - head * Math.cos(angle - Math.PI / 6), ey - head * Math.sin(angle - Math.PI / 6));
      ctx.moveTo(ex, ey); ctx.lineTo(ex - head * Math.cos(angle + Math.PI / 6), ey - head * Math.sin(angle + Math.PI / 6));
      ctx.stroke();
    }
    const a = bmMarkAnchor(mark), cx = a.x * w, cy = a.y * h, r = 11 * s;
    ctx.beginPath(); ctx.arc(cx, cy, r + (index === selected ? 3 * s : 0), 0, Math.PI * 2);
    ctx.fillStyle = index === selected ? "#ffd84d" : "#fff"; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, r - 1.5 * s, 0, Math.PI * 2); ctx.fillStyle = BM_MARK_RED; ctx.fill();
    ctx.fillStyle = "#fff"; ctx.font = `bold ${13 * s}px "Segoe UI", sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(index + 1), cx, cy + 0.5 * s);
  });
}
function bmShowImage(name, holdEditor = false) {
  if (holdEditor) bmImagesBusy += 1; // 模态窗抢焦点时，别让图文编辑框按失焦提交并销毁。
  const dialog = document.createElement("dialog");
  dialog.className = "bm-image-viewer";
  const close = document.createElement("button"); close.textContent = "×"; close.type = "button"; close.className = "bm-image-close"; close.title = "关闭（也可以按 Esc 或点外面）";
  close.addEventListener("click", () => dialog.close());
  const stage = document.createElement("div"); stage.className = "bm-mark-stage";
  const img = document.createElement("img"); img.alt = "任务参考图"; img.draggable = false;
  stage.appendChild(img);
  dialog.append(close, stage); document.body.appendChild(dialog);
  let flush = null;
  dialog.addEventListener("close", () => {
    flush?.();
    dialog.remove();
    if (holdEditor) { bmImagesBusy -= 1; bmFlushImageRefresh(); }
  });
  // 只有点到框外面的暗处才关；框里的空隙不算，免得标着标着一下关了。
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  dialog.showModal();
  void bmImageSource(name).then((url) => { img.src = url; }).catch(() => { img.alt = "图片文件缺失或无法读取"; });
  if (/^image-[a-zA-Z0-9-]+\.png$/.test(name)) flush = bmBindMarks(dialog, stage, img, name);
}
function bmBindMarks(dialog, stage, img, name) {
  const layer = document.createElement("canvas"); layer.className = "bm-mark-layer";
  stage.appendChild(layer);
  const ctx = layer.getContext("2d");
  let marks = [], summary = "", tool = "pin", selected = -1, draft = null, moving = null, ready = false;
  let saveTimer = null, dirty = false, chain = Promise.resolve(), shownWidth = 0, savedTimer = null;

  const tools = document.createElement("div"); tools.className = "bm-mark-tools";
  for (const [kind, icon, label, tip] of [["pin", "●", "标注", "点一下图片，落一个带号的标注"], ["box", "▢", "框", "拖一下，框住一块"], ["arrow", "↗", "箭头", "从哪拖到哪"]]) {
    const button = document.createElement("button"); button.type = "button"; button.dataset.tool = kind; button.title = tip;
    const mark = document.createElement("span"); mark.className = "bm-mark-icon"; mark.textContent = icon;
    button.append(mark, label); button.setAttribute("aria-pressed", String(kind === tool));
    button.addEventListener("click", () => {
      tool = kind;
      for (const item of tools.querySelectorAll("[data-tool]")) item.setAttribute("aria-pressed", String(item === button));
    });
    tools.appendChild(button);
  }
  const saved = document.createElement("span"); saved.className = "bm-mark-saved"; saved.textContent = "已自动保存";
  const undo = document.createElement("button"); undo.type = "button"; undo.className = "bm-mark-undo"; undo.textContent = "↶"; undo.title = "撤销上一个（Ctrl+Z）";
  undo.addEventListener("click", () => { if (marks.length) remove(marks.length - 1); });
  tools.append(saved, undo);
  // 整体说明：对整张图说的话（2026-09-24 用户：光有局部不够，要一个总的）。可以不填。
  const overall = document.createElement("textarea"); overall.className = "bm-mark-summary"; overall.rows = 2; overall.maxLength = 2000;
  overall.placeholder = "整张图总的说一下（可以不填）"; overall.setAttribute("aria-label", "整张图的说明"); overall.readOnly = true;
  overall.addEventListener("input", () => { summary = overall.value; schedule(); });
  const notes = document.createElement("ol"); notes.className = "bm-mark-notes";
  dialog.append(tools, overall, notes);

  const draw = () => {
    ctx.clearRect(0, 0, layer.width, layer.height);
    bmDrawMarks(ctx, layer.width, layer.height, draft ? [...marks, draft] : marks, window.devicePixelRatio || 1, selected);
  };
  const fit = () => {
    const r = img.getBoundingClientRect();
    if (!r.width) return;
    shownWidth = r.width;
    const dpr = window.devicePixelRatio || 1;
    layer.width = Math.round(r.width * dpr); layer.height = Math.round(r.height * dpr);
    draw();
  };
  new ResizeObserver(fit).observe(img);
  img.addEventListener("load", fit);
  const clamp = (value) => Math.min(1, Math.max(0, value));
  const point = (event) => {
    const r = img.getBoundingClientRect();
    return { x: clamp((event.clientX - r.left) / r.width), y: clamp((event.clientY - r.top) / r.height) };
  };
  const hit = (event) => {
    const r = img.getBoundingClientRect();
    for (let i = marks.length - 1; i >= 0; i -= 1) {
      const a = bmMarkAnchor(marks[i]);
      if (Math.hypot(event.clientX - (r.left + a.x * r.width), event.clientY - (r.top + a.y * r.height)) <= 15) return i;
    }
    return -1;
  };

  const save = () => {
    saveTimer = null;
    if (!dirty) return chain;
    dirty = false;
    const snapshot = marks.map(({ kind, x, y, endX, endY, note }) => ({ kind, x, y, endX, endY, note }));
    const overallText = summary;
    const scale = shownWidth ? Math.max(1, img.naturalWidth / shownWidth) : 1;
    chain = chain.then(async () => {
      let bytes = null;
      if (snapshot.length && img.naturalWidth) {
        // 带编号的那张：原图＋标注，跟屏幕上看到的一样，只给 AI 看。
        const out = document.createElement("canvas"); out.width = img.naturalWidth; out.height = img.naturalHeight;
        const c = out.getContext("2d"); c.drawImage(img, 0, 0);
        bmDrawMarks(c, out.width, out.height, snapshot, scale);
        const blob = await new Promise((resolve) => out.toBlob(resolve, "image/png"));
        if (blob) bytes = new Uint8Array(await blob.arrayBuffer());
      }
      await window.bookmark.setImageMarks(name, snapshot, overallText, bytes);
      saved.classList.add("on"); clearTimeout(savedTimer); savedTimer = setTimeout(() => saved.classList.remove("on"), 1500);
    }).catch((error) => { dirty = true; bmShowError("标注没存上：" + bmErrorText(error)); });
    return chain;
  };
  const schedule = () => { dirty = true; clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); };

  const select = (index) => {
    selected = index; draw();
    for (const li of notes.children) li.classList.toggle("bm-mark-on", Number(li.dataset.index) === index);
  };
  const renderNotes = (focusIndex = -1) => {
    notes.replaceChildren();
    if (!marks.length) {
      const empty = document.createElement("li"); empty.className = "bm-mark-empty";
      empty.textContent = "点一下图片落标注，拖一下画框或箭头；每个标注要怎么改，写在这里";
      notes.appendChild(empty); return;
    }
    marks.forEach((mark, index) => {
      const li = document.createElement("li"); li.dataset.index = String(index);
      li.classList.toggle("bm-mark-on", index === selected);
      const num = document.createElement("span"); num.className = "bm-mark-num"; num.textContent = bmMarkLabel(index);
      const input = document.createElement("input"); input.type = "text"; input.maxLength = 500;
      input.placeholder = "这里要怎么改…"; input.value = mark.note || ""; input.setAttribute("aria-label", `标注 ${index + 1} 的说明`);
      input.addEventListener("input", () => { mark.note = input.value; schedule(); });
      input.addEventListener("focus", () => select(index));
      input.addEventListener("keydown", (event) => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); input.blur(); } });
      const del = document.createElement("button"); del.type = "button"; del.className = "bm-mark-del"; del.textContent = "×"; del.title = "删掉这个标注";
      del.addEventListener("click", () => remove(index));
      li.append(num, input, del); notes.appendChild(li);
      if (index === focusIndex) requestAnimationFrame(() => input.focus());
    });
  };
  const remove = (index) => { marks.splice(index, 1); selected = -1; renderNotes(); draw(); schedule(); };
  const add = (mark) => { marks.push(mark); selected = marks.length - 1; renderNotes(selected); draw(); schedule(); };

  layer.addEventListener("pointerdown", (event) => {
    if (!ready || event.button !== 0) return;
    event.preventDefault();
    if (document.activeElement?.matches?.("input, textarea")) document.activeElement.blur();
    layer.setPointerCapture(event.pointerId);
    const p = point(event), index = hit(event);
    if (index >= 0) { moving = { index, from: p, orig: { ...marks[index] }, moved: false }; select(index); return; }
    select(-1);
    draft = { kind: tool, x: p.x, y: p.y, endX: p.x, endY: p.y, note: "" };
    draw();
  });
  layer.addEventListener("pointermove", (event) => {
    const p = point(event);
    if (moving) {
      const { orig, from } = moving, dx = p.x - from.x, dy = p.y - from.y;
      if (Math.abs(dx) + Math.abs(dy) > 0.002) moving.moved = true;
      Object.assign(marks[moving.index], { x: clamp(orig.x + dx), y: clamp(orig.y + dy), endX: clamp(orig.endX + dx), endY: clamp(orig.endY + dy) });
      draw(); return;
    }
    if (draft && draft.kind !== "pin") { draft.endX = p.x; draft.endY = p.y; draw(); }
  });
  layer.addEventListener("pointerup", () => {
    if (moving) {
      const { index, moved } = moving; moving = null;
      if (moved) schedule();
      else notes.querySelector(`[data-index="${index}"] input`)?.focus();
      return;
    }
    if (!draft) return;
    const r = img.getBoundingClientRect();
    const length = Math.hypot((draft.endX - draft.x) * r.width, (draft.endY - draft.y) * r.height);
    // 框和箭头没拖开（只点了一下）就当落一个编号，不白点。
    const mark = draft.kind === "pin" || length < 8 ? { ...draft, kind: "pin", endX: draft.x, endY: draft.y } : draft;
    draft = null; add(mark);
  });
  layer.addEventListener("pointercancel", () => { draft = null; moving = null; draw(); });
  dialog.addEventListener("keydown", (event) => {
    if (event.target.matches?.("input, textarea")) return;
    if ((event.key === "Delete" || event.key === "Backspace") && selected >= 0) { event.preventDefault(); remove(selected); }
    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z" && marks.length) { event.preventDefault(); remove(marks.length - 1); }
  });

  renderNotes();
  void window.bookmark.getImageMarks(name)
    .then((loaded) => {
      marks = Array.isArray(loaded?.marks) ? loaded.marks : [];
      summary = typeof loaded?.summary === "string" ? loaded.summary : ""; overall.value = summary;
    })
    .catch(() => { marks = []; })
    .finally(() => { ready = true; overall.readOnly = false; renderNotes(); draw(); });
  return () => { if (saveTimer) { clearTimeout(saveTimer); void save(); } };
}
function bmImageNode(name, marker, editable) {
  const box = document.createElement("span");
  box.className = "bm-inline-image"; box.contentEditable = "false";
  if (marker) box.dataset.imageMarker = marker;
  const open = document.createElement("button"); open.type = "button"; open.title = "查看大图";
  const img = document.createElement("img"); img.alt = "参考图（加载中）"; img.draggable = false;
  open.appendChild(img); box.appendChild(open);
  box.addEventListener("pointerdown", (event) => event.stopPropagation());
  box.addEventListener("mousedown", (event) => event.preventDefault());
  open.addEventListener("click", (event) => {
    event.stopPropagation();
    // 标注单独存在图旁边，不换正文里的图片标记（设定16第三版）。
    bmShowImage(name, editable);
  });
  void bmImageSource(name).then((url) => { img.src = url; img.alt = "参考图"; }).catch(() => { img.alt = "图片缺失，点击检查"; });
  if (editable) {
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "bm-image-remove";
    remove.textContent = "×"; remove.title = "移除这张图";
    remove.addEventListener("click", (event) => {
      event.stopPropagation(); const rich = box.parentElement;
      const index = [...rich.childNodes].slice(0, [...rich.childNodes].indexOf(box)).map(bmImageText).join("").length;
      box.remove(); rich.focus(); bmImageCaret(rich, index); rich.dispatchEvent(new Event("input", { bubbles: true }));
    }); box.appendChild(remove);
  }
  return box;
}
function bmRenderImages(target, text, editable = false, attachments = []) {
  target.replaceChildren();
  let at = 0;
  const seen = new Set();
  for (const match of bmImageParts(text)) {
    target.appendChild(document.createTextNode(text.slice(at, match.index)));
    target.appendChild(bmImageNode(match[1], match[0], editable));
    seen.add(match[1]); at = match.index + match[0].length;
  }
  target.appendChild(document.createTextNode(text.slice(at)));
  for (const name of attachments) if (!seen.has(name)) target.appendChild(bmImageNode(name, null, false));
  target.classList.toggle("bm-has-images", !!seen.size || !!attachments.length);
}
function bmBindImageEditor(input) {
  const wrap = document.createElement("div"); wrap.className = "bm-image-editor";
  input.replaceWith(wrap); wrap.appendChild(input);
  const nativeFocus = input.focus.bind(input);
  const nativeSetRange = input.setSelectionRange.bind(input);
  const selection = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "selectionStart");
  const selectionEnd = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "selectionEnd");
  Object.defineProperty(input, "selectionStart", { get: () => input.bmRich ? bmImageSelection(input.bmRich)[0] : selection.get.call(input) });
  Object.defineProperty(input, "selectionEnd", { get: () => input.bmRich ? bmImageSelection(input.bmRich)[1] : selectionEnd.get.call(input) });
  input.focus = (...args) => input.bmRich ? input.bmRich.focus(...args) : nativeFocus(...args);
  input.setSelectionRange = (start, end) => input.bmRich ? bmImageCaret(input.bmRich, start, end) : nativeSetRange(start, end);
  const upgrade = () => {
    if (input.bmRich || !bmImageParts(input.value).length) return;
    const rich = document.createElement("div"); rich.className = "bm-rich-input";
    rich.contentEditable = "true"; rich.setAttribute("role", "textbox"); rich.setAttribute("aria-label", "任务图文"); rich.setAttribute("aria-multiline", "true");
    rich.bmSource = input; input.bmRich = rich; input.hidden = true;
    wrap.insertBefore(rich, input); bmRenderImages(rich, input.value, true);
    rich.addEventListener("input", () => { input.value = bmImageText(rich); input.dispatchEvent(new Event("input", { bubbles: true })); });
    rich.addEventListener("compositionend", () => input.dispatchEvent(new Event("compositionend")));
    rich.addEventListener("blur", () => { if (!bmImagesBusy) input.dispatchEvent(new Event("blur")); });
    rich.addEventListener("keydown", (event) => {
      if (event.isComposing) return;
      if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); insertText("\n"); return; }
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault(); input.dispatchEvent(new KeyboardEvent("keydown", { key: event.key, cancelable: true }));
      }
    });
    rich.addEventListener("paste", onPaste);
    // 外来拖放不接收 HTML/路径；图片通过贴图按钮或剪贴板进入。
    rich.addEventListener("drop", (event) => event.preventDefault());
  };
  const insertText = (text) => {
    const start = input.selectionStart, end = input.selectionEnd;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    upgrade();
    if (input.bmRich) bmRenderImages(input.bmRich, input.value, true);
    input.focus(); input.setSelectionRange(start + text.length, start + text.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const addFiles = async (files) => {
    if (!files.length || bmImagesBusy) return;
    const start = input.selectionStart, end = input.selectionEnd;
    bmImagesBusy += 1; input.readOnly = true;
    if (input.bmRich) input.bmRich.contentEditable = "false";
    const markers = [];
    try {
      for (const file of files) {
        if (file.size > 20 * 1024 * 1024) throw new Error("请选择 20 MB 以内的图片");
        const name = await window.bookmark.saveImage(new Uint8Array(await file.arrayBuffer()));
        markers.push(`[图片:${name}]`);
      }
    } catch (error) { bmShowError("贴图失败：" + bmErrorText(error)); }
    finally {
      input.readOnly = false;
      if (input.bmRich) input.bmRich.contentEditable = "true";
      if (markers.length && input.isConnected) {
        input.focus(); input.setSelectionRange(start, end); insertText(markers.join("\n"));
      }
      bmImagesBusy -= 1;
      bmFlushImageRefresh();
    }
  };
  function onPaste(event) {
    const files = [...(event.clipboardData?.items || [])].filter((item) => item.kind === "file" && item.type.startsWith("image/")).map((item) => item.getAsFile()).filter(Boolean);
    if (files.length) { event.preventDefault(); void addFiles(files); }
    else if (input.bmRich) { event.preventDefault(); insertText(event.clipboardData?.getData("text/plain") || ""); }
  }
  input.addEventListener("paste", onPaste);
  const tools = document.createElement("div"); tools.className = "bm-image-tools";
  const choose = document.createElement("button"); choose.type = "button"; choose.innerHTML = bmIcon("image"); choose.setAttribute("aria-label", "贴图片"); choose.title = "选图片，或直接 Ctrl+V 粘贴截图";
  const picker = document.createElement("input"); picker.type = "file"; picker.accept = "image/png,image/jpeg,image/webp,image/gif,image/bmp"; picker.multiple = true; picker.hidden = true;
  let savedRange = null;
  choose.addEventListener("mousedown", (event) => { event.preventDefault(); savedRange = [input.selectionStart, input.selectionEnd]; });
  choose.addEventListener("click", () => { savedRange ??= [input.selectionStart, input.selectionEnd]; bmImagesBusy += 1; picker.click(); });
  const finishPicker = () => { bmImagesBusy = Math.max(0, bmImagesBusy - 1); input.focus(); if (savedRange) input.setSelectionRange(...savedRange); savedRange = null; bmFlushImageRefresh(); };
  picker.addEventListener("cancel", finishPicker);
  picker.addEventListener("change", () => { finishPicker(); const files = [...picker.files]; picker.value = ""; void addFiles(files); });
  tools.append(choose, picker); wrap.appendChild(tools);
  upgrade();
}
