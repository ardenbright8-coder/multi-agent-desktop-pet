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
function bmShowImage(name, onReplace, holdEditor = false) {
  if (holdEditor) bmImagesBusy += 1; // 模态窗抢焦点时，别让图文编辑框按失焦提交并销毁。
  const dialog = document.createElement("dialog");
  dialog.className = "bm-image-viewer";
  const close = document.createElement("button"); close.textContent = "×"; close.type = "button"; close.className = "bm-image-close"; close.title = "关闭（也可以按 Esc 或点外面）";
  close.addEventListener("click", () => dialog.close());
  const img = document.createElement("img"); img.alt = "任务参考图";
  dialog.append(close, img); document.body.appendChild(dialog);
  dialog.addEventListener("close", () => {
    dialog.remove();
    if (holdEditor) {
      bmImagesBusy -= 1;
      if (dialog.bmChangedInput?.isConnected) dialog.bmChangedInput.dispatchEvent(new Event("input", { bubbles: true }));
      bmFlushImageRefresh();
    }
  });
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.showModal();
  void bmImageSource(name).then((url) => { img.src = url; }).catch(() => { img.alt = "图片文件缺失或无法读取"; });
  if (onReplace) {
    const edit = document.createElement("button"); edit.type = "button";
    edit.className = "bm-image-annotate"; edit.textContent = "标注图片";
    edit.addEventListener("click", () => bmAnnotateImage(dialog, img, onReplace));
    dialog.appendChild(edit);
  }
}
function bmAnnotateImage(dialog, img, onReplace) {
  if (!img.complete || !img.naturalWidth) { bmShowError("图片还没加载好，请稍后再试"); return; }
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
  canvas.className = "bm-annotation-canvas";
  const ctx = canvas.getContext("2d");
  const strokes = [];
  let draft = null;
  let tool = "arrow";
  const draw = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const mark of [...strokes, ...(draft ? [draft] : [])]) {
      ctx.strokeStyle = "#ed302c"; ctx.fillStyle = "#ed302c";
      ctx.lineWidth = Math.max(3, Math.min(canvas.width, canvas.height) / 180);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      const { x, y, endX, endY } = mark;
      if (mark.kind === "text") {
        ctx.font = `bold ${Math.max(18, Math.min(canvas.width, canvas.height) / 18)}px sans-serif`;
        ctx.lineWidth = 4; ctx.strokeStyle = "white";
        ctx.strokeText(mark.text, x, y); ctx.fillText(mark.text, x, y);
      } else if (mark.kind === "rect") {
        ctx.strokeRect(x, y, endX - x, endY - y);
      } else if (mark.kind === "circle") {
        ctx.beginPath(); ctx.ellipse((x + endX) / 2, (y + endY) / 2, Math.max(1, Math.abs(endX - x) / 2), Math.max(1, Math.abs(endY - y) / 2), 0, 0, Math.PI * 2); ctx.stroke();
      } else {
        const angle = Math.atan2(endY - y, endX - x);
        const head = Math.max(12, Math.min(canvas.width, canvas.height) / 28);
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(endX, endY);
        ctx.moveTo(endX, endY); ctx.lineTo(endX - head * Math.cos(angle - Math.PI / 6), endY - head * Math.sin(angle - Math.PI / 6));
        ctx.moveTo(endX, endY); ctx.lineTo(endX - head * Math.cos(angle + Math.PI / 6), endY - head * Math.sin(angle + Math.PI / 6)); ctx.stroke();
      }
    }
  };
  const point = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) * canvas.width / rect.width, y: (event.clientY - rect.top) * canvas.height / rect.height };
  };
  const toolbar = document.createElement("div"); toolbar.className = "bm-annotation-tools";
  const modes = [["arrow", "箭头"], ["circle", "圈选"], ["rect", "方框"], ["text", "文字"]];
  for (const [kind, label] of modes) {
    const button = document.createElement("button"); button.type = "button"; button.textContent = label;
    button.setAttribute("aria-pressed", String(kind === tool));
    button.addEventListener("click", () => {
      tool = kind;
      for (const item of toolbar.querySelectorAll("[aria-pressed]")) item.setAttribute("aria-pressed", String(item === button));
    });
    toolbar.appendChild(button);
  }
  const words = document.createElement("input"); words.type = "text"; words.placeholder = "要写在图上的字";
  words.setAttribute("aria-label", "标注文字"); words.maxLength = 60; toolbar.appendChild(words);
  const undo = document.createElement("button"); undo.type = "button"; undo.textContent = "撤销上一步";
  undo.addEventListener("click", () => { strokes.pop(); draw(); }); toolbar.appendChild(undo);
  const save = document.createElement("button"); save.type = "button"; save.textContent = "保存标注";
  save.addEventListener("click", async () => {
    if (!strokes.length) return;
    save.disabled = true; bmImagesBusy += 1;
    try {
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) throw new Error("无法生成标注图片");
      const newName = await window.bookmark.saveImage(new Uint8Array(await blob.arrayBuffer()));
      dialog.bmChangedInput = await onReplace(newName);
      dialog.close();
    } catch (error) { bmShowError("保存标注失败：" + bmErrorText(error)); save.disabled = false; }
    finally { bmImagesBusy -= 1; bmFlushImageRefresh(); }
  }); toolbar.appendChild(save);
  canvas.addEventListener("pointerdown", (event) => {
    if (tool === "text") {
      if (!words.value.trim()) { words.focus(); return; }
      strokes.push({ kind: "text", ...point(event), text: words.value.trim() }); draw(); return;
    }
    const start = point(event); draft = { kind: tool, ...start, endX: start.x, endY: start.y };
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener("pointermove", (event) => { if (!draft) return; const end = point(event); draft.endX = end.x; draft.endY = end.y; draw(); });
  canvas.addEventListener("pointerup", (event) => {
    if (!draft) return;
    const end = point(event); draft.endX = end.x; draft.endY = end.y;
    if (Math.hypot(draft.endX - draft.x, draft.endY - draft.y) > 3) strokes.push(draft);
    draft = null; draw();
  });
  canvas.addEventListener("pointercancel", () => { draft = null; draw(); });
  img.hidden = true; dialog.classList.add("bm-annotating"); dialog.querySelector(".bm-image-annotate").hidden = true;
  dialog.append(toolbar, canvas); draw();
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
    const rich = editable ? box.parentElement : null;
    const row = !editable ? box.closest(".task[data-id]") : null;
    const onReplace = marker && (rich?.bmSource || row) ? async (newName) => {
      const before = marker;
      const after = `[图片:${newName}]`;
      if (rich?.bmSource) {
        const input = rich.bmSource;
        input.value = input.value.replace(before, after);
        bmRenderImages(rich, input.value, true);
        return input;
      } else {
        const record = (await window.bookmark.list()).find((item) => item.id === row.dataset.id);
        if (!record || !record.text.includes(before)) throw new Error("条目已改变，请重新打开图片");
        await window.bookmark.updateText(record.id, record.text.replace(before, after), record.url);
        await bmRefresh();
      }
    } : null;
    bmShowImage(name, onReplace, editable);
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
