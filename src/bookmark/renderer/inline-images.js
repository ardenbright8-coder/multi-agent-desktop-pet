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
function bmShowImage(name) {
  const dialog = document.createElement("dialog");
  dialog.className = "bm-image-viewer";
  const close = document.createElement("button"); close.textContent = "×"; close.type = "button"; close.className = "bm-image-close"; close.title = "关闭（也可以按 Esc 或点外面）";
  close.addEventListener("click", () => dialog.close());
  const img = document.createElement("img"); img.alt = "任务参考图";
  dialog.append(close, img); document.body.appendChild(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  dialog.showModal();
  void bmImageSource(name).then((url) => { img.src = url; }).catch(() => { img.alt = "图片文件缺失或无法读取"; });
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
  open.addEventListener("click", (event) => { event.stopPropagation(); bmShowImage(name); });
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
